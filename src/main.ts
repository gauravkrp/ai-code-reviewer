import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import Anthropic from "@anthropic-ai/sdk";

// Constants for configuration
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const AI_PROVIDER: string = core.getInput("AI_PROVIDER") || "openai"; // Default to OpenAI if not specified
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL") || "o3-mini";
const ANTHROPIC_API_KEY: string = core.getInput("ANTHROPIC_API_KEY");
const ANTHROPIC_API_MODEL: string = core.getInput("ANTHROPIC_API_MODEL") || "claude-3-7-sonnet-20250219"; // Latest model
const MAX_FILES: number = parseInt(core.getInput("MAX_FILES") || "0", 10); // 0 means no limit
const EXCLUDE_PATTERNS: string[] = core
  .getInput("exclude")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // Filter out empty strings

// Add retry configuration
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

// Add token configuration
const DEFAULT_MAX_TOKENS = 1500;
const MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS = 500; // lines
const TOKEN_MULTIPLIER = 3; // Increase tokens by 3x for large chunks

// Add rate limiting and memory management configuration
const RATE_LIMIT_DELAY = 1000; // 1 second between API calls
const MAX_CHUNK_TOTAL_LINES = 2000; // Skip chunks larger than this
const MAX_FILE_TOTAL_LINES = 5000; // Skip files larger than this
const API_CALL_QUEUE = new Map<string, number>(); // Track last API call time

// Initialize clients
const octokit = new Octokit({ auth: GITHUB_TOKEN });
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// Type definitions
interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

interface ReviewComment {
  body: string;
  path: string;
  line: number;  // The line number in the file to comment on
  side?: 'RIGHT' | 'LEFT';  // Which side of the diff to place the comment
  commit_id?: string;  // The SHA of the commit to comment on
}

interface AIReviewResponse {
  lineNumber: string;
  reviewComment: string;
}

// Add validation function for AI responses
function validateAIResponse(response: AIReviewResponse): boolean {
  // Validate line number is a positive integer
  const lineNumber = Number(response.lineNumber);
  if (isNaN(lineNumber) || lineNumber <= 0) {
    core.warning(`Invalid line number in AI response: ${response.lineNumber}`);
    return false;
  }

  // Validate review comment is not empty and has reasonable length
  if (!response.reviewComment || response.reviewComment.trim().length === 0) {
    core.warning('Empty review comment received from AI');
    return false;
  }

  if (response.reviewComment.length > 65536) { // GitHub's max comment length
    core.warning('Review comment exceeds GitHub\'s maximum length');
    return false;
  }

  return true;
}

/**
 * Helper function to delay execution
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Adds rate limiting to API calls
 */
async function withRateLimit<T>(
  operation: () => Promise<T>,
  apiName: string
): Promise<T> {
  const now = Date.now();
  const lastCallTime = API_CALL_QUEUE.get(apiName) || 0;
  const timeToWait = Math.max(0, lastCallTime + RATE_LIMIT_DELAY - now);
  
  if (timeToWait > 0) {
    core.debug(`Rate limiting: Waiting ${timeToWait}ms before calling ${apiName}`);
    await delay(timeToWait);
  }
  
  API_CALL_QUEUE.set(apiName, Date.now());
  return operation();
}

/**
 * Helper function to retry an async operation
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY,
  apiName?: string
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Add rate limiting if apiName is provided
      if (apiName) {
        return await withRateLimit(() => operation(), apiName);
      } else {
        return await operation();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check for rate limiting errors and adjust delay
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();
        if (
          errorMsg.includes('rate limit') || 
          errorMsg.includes('too many requests') ||
          errorMsg.includes('429')
        ) {
          // For rate limit errors, use a longer delay
          delayMs = delayMs * 3;
          core.warning(`Rate limit detected, increasing delay to ${delayMs}ms`);
        }
      }
      
      if (attempt < maxRetries) {
        core.warning(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
        await delay(delayMs * attempt); // Exponential backoff
      }
    }
  }
  
  throw lastError;
}

/**
 * Safely validates a file is within size limits
 */
function isFileTooLarge(file: File): boolean {
  const totalLines = file.additions + file.deletions;
  if (totalLines > MAX_FILE_TOTAL_LINES) {
    core.warning(`Skipping file ${file.to}: Too large (${totalLines} lines)`);
    return true;
  }
  return false;
}

/**
 * Safely validates a chunk is within size limits
 */
function isChunkTooLarge(chunk: Chunk): boolean {
  const totalLines = chunk.newLines + chunk.oldLines;
  if (totalLines > MAX_CHUNK_TOTAL_LINES) {
    core.warning(`Skipping chunk: Too large (${totalLines} lines)`);
    return true;
  }
  return false;
}

/**
 * Fetches pull request details from GitHub
 */
async function getPRDetails(): Promise<PRDetails> {
  try {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error("GITHUB_EVENT_PATH environment variable is not set");
    }

    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
    );
    
    const { repository, number } = eventData;
    
    if (!repository || !number) {
      throw new Error("Invalid event data: missing repository or PR number");
    }

    const prResponse = await octokit.pulls.get({
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
    });

    return {
      owner: repository.owner.login,
      repo: repository.name,
      pull_number: number,
      title: prResponse.data.title ?? "",
      description: prResponse.data.body ?? "",
    };
  } catch (error) {
    core.error(`Failed to get PR details: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Fetches the diff for a pull request
 */
async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string> {
  try {
    const response = await octokit.pulls.get({
      owner,
      repo,
      pull_number,
      mediaType: { format: "diff" },
    });
    
    // @ts-expect-error - response.data is a string when mediaType.format is "diff"
    return response.data;
  } catch (error) {
    core.error(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Calculates appropriate token limit based on chunk size
 */
function calculateTokenLimit(chunk: Chunk): number {
  const totalLines = chunk.newLines + chunk.oldLines;
  if (totalLines > MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS) {
    const multiplier = Math.ceil(totalLines / MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS);
    return DEFAULT_MAX_TOKENS * Math.min(multiplier, TOKEN_MULTIPLIER);
  }
  return DEFAULT_MAX_TOKENS;
}

/**
 * Analyzes code diffs using AI and generates review comments
 */
async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];
  core.info(`Analyzing ${parsedDiff.length} files...`);

  // Apply MAX_FILES limit if set
  const filesToAnalyze = MAX_FILES > 0 ? parsedDiff.slice(0, MAX_FILES) : parsedDiff;
  if (MAX_FILES > 0 && parsedDiff.length > MAX_FILES) {
    core.info(`Limiting analysis to first ${MAX_FILES} files as per MAX_FILES setting`);
  }

  // Process files in parallel with a concurrency limit
  const CONCURRENT_FILES = 3;
  for (let i = 0; i < filesToAnalyze.length; i += CONCURRENT_FILES) {
    const fileBatch = filesToAnalyze.slice(i, i + CONCURRENT_FILES);
    const fileCommentsPromises = fileBatch.map(async (file) => {
      if (file.to === "/dev/null") {
        core.debug(`Skipping deleted file: ${file.from}`);
        return [];
      }
      
      // Skip files that are too large
      if (isFileTooLarge(file)) {
        return [];
      }
      
      try {
        core.info(`\nAnalyzing file: ${file.to}`);
        core.info(`Changes: +${file.additions} -${file.deletions} lines`);
        
        const fileComments: ReviewComment[] = [];
        
        // Process chunks in parallel with a concurrency limit
        const CONCURRENT_CHUNKS = 2;
        for (let j = 0; j < file.chunks.length; j += CONCURRENT_CHUNKS) {
          const chunkBatch = file.chunks.slice(j, j + CONCURRENT_CHUNKS);
          const chunkCommentsPromises = chunkBatch.map(async (chunk) => {
            // Skip chunks that are too large
            if (isChunkTooLarge(chunk)) {
              return [];
            }
            
            try {
              core.debug(`Processing chunk at lines ${chunk.oldStart},${chunk.oldLines} -> ${chunk.newStart},${chunk.newLines}`);
              const prompt = createPrompt(file, chunk, prDetails);
              core.debug('Sending prompt to AI:\n' + prompt);
              
              const aiResponse = await getAIResponse(prompt, chunk);
              
              if (aiResponse && aiResponse.length > 0) {
                core.info(`Received ${aiResponse.length} comments from AI for file ${file.to}:`);
                aiResponse.forEach(response => {
                  core.info(`- Line ${response.lineNumber}: ${response.reviewComment}`);
                });
                
                return createComment(file, chunk, aiResponse);
              } else {
                core.debug(`No comments generated for chunk in ${file.to}`);
                return [];
              }
            } catch (error) {
              // Log the error but continue processing other chunks
              core.warning(`Error processing chunk in ${file.to}: ${error instanceof Error ? error.message : String(error)}`);
              return [];
            }
          });
          
          try {
            const chunkComments = await Promise.all(chunkCommentsPromises);
            fileComments.push(...chunkComments.flat());
          } catch (error) {
            core.warning(`Error processing chunk batch in ${file.to}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        
        return fileComments;
      } catch (error) {
        // Log the error but continue processing other files
        core.warning(`Error processing file ${file.to}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    
    try {
      const fileComments = await Promise.all(fileCommentsPromises);
      comments.push(...fileComments.flat());
    } catch (error) {
      core.warning(`Error processing file batch: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  core.info(`\nAnalysis complete. Generated ${comments.length} comments total.`);
  return comments;
}

/**
 * Creates a prompt for the AI model to review code
 */
function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- IMPORTANT: For imports and variable declarations:
  * Only suggest removing imports if they are newly added in this diff (lines with '+' prefix) and definitely unused
  * Do not suggest removing existing imports or variables - they might be used elsewhere in the file
  * Only flag unused variables if they're newly introduced in this diff
  * Remember you're only seeing a portion of the file in the diff, not the entire file
- Focus on actual code issues: bugs, performance issues, security concerns, and best practices.
- Suggest specific fixes rather than just pointing out problems.
- If suggesting a code change, provide a concrete example of the improved code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`

Remember that you're only seeing a portion of the file and your knowledge of the codebase is limited to what's shown in this diff.
`;
}

/**
 * Gets AI response for a given prompt using the configured AI provider
 */
async function getAIResponse(prompt: string, chunk?: Chunk): Promise<AIReviewResponse[] | null> {
  try {
    if (AI_PROVIDER.toLowerCase() === "anthropic") {
      return await withRetry(() => getAnthropicResponse(prompt));
    } else {
      return await withRetry(() => getOpenAIResponse(prompt, chunk));
    }
  } catch (error) {
    core.error(`Error getting AI response after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Gets response from OpenAI API
 */
async function getOpenAIResponse(prompt: string, chunk?: Chunk): Promise<AIReviewResponse[] | null> {
  // Base configuration for the API request
  const baseConfig = {
    model: OPENAI_API_MODEL,
  };

  // Calculate token limit based on chunk size if available
  const maxTokens = chunk ? calculateTokenLimit(chunk) : DEFAULT_MAX_TOKENS;

  // Add model-specific parameters
  const modelConfig = OPENAI_API_MODEL.startsWith('o') 
    ? {
        max_completion_tokens: maxTokens,
        response_format: { type: "json_object" as const }
      }
    : {
        temperature: 0.2,
        top_p: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        max_tokens: maxTokens,
        ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
          ? { response_format: { type: "json_object" as const } }
          : {})
      };

  try {
    core.debug(`Sending request to OpenAI API with model: ${OPENAI_API_MODEL} and max_tokens: ${maxTokens}`);
    
    const response = await withRetry(
      () => openai.chat.completions.create({
        ...baseConfig,
        ...modelConfig,
        messages: [
          {
            role: "system",
            content: prompt,
          },
        ],
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "openai-api" // Add API name for rate limiting
    );

    const content = response.choices[0].message?.content?.trim();
    
    if (!content) {
      core.warning("Received empty response from OpenAI API");
      return null;
    }
    
    try {
      const parsedResponse = JSON.parse(content);
      const reviews = parsedResponse.reviews || [];
      
      // Validate each review
      const validReviews = reviews.filter(validateAIResponse);
      if (validReviews.length !== reviews.length) {
        core.warning(`Filtered out ${reviews.length - validReviews.length} invalid reviews`);
      }
      
      return validReviews;
    } catch (parseError) {
      core.warning(`Failed to parse OpenAI response as JSON: ${content}`);
      // If parsing fails, try to extract JSON from the content
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const extractedJson = JSON.parse(jsonMatch[0]);
          if (extractedJson.reviews) {
            core.info("Successfully extracted JSON from response");
            return extractedJson.reviews.filter(validateAIResponse);
          }
        } catch (extractError) {
          core.warning("Failed to extract JSON from response");
        }
      }
      // Try to extract reviews with regex as a last resort
      try {
        const reviewMatches = content.match(/"lineNumber"\s*:\s*"?([^",\s]+)"?\s*,\s*"reviewComment"\s*:\s*"([^"]+)"/g);
        if (reviewMatches && reviewMatches.length > 0) {
          core.info("Using regex to extract reviews as last resort");
          const extractedReviews = reviewMatches.map(match => {
            const lineMatch = match.match(/"lineNumber"\s*:\s*"?([^",\s]+)"?/);
            const commentMatch = match.match(/"reviewComment"\s*:\s*"([^"]+)"/);
            if (lineMatch && commentMatch) {
              return {
                lineNumber: lineMatch[1],
                reviewComment: commentMatch[1].replace(/\\"/g, '"')
              };
            }
            return null;
          }).filter(Boolean) as AIReviewResponse[];
          
          if (extractedReviews.length > 0) {
            return extractedReviews.filter(validateAIResponse);
          }
        }
      } catch (regexError) {
        core.warning("Failed to extract reviews with regex");
      }
      return null;
    }
  } catch (error) {
    core.error(`Error calling OpenAI API: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Gets response from Anthropic API
 */
async function getAnthropicResponse(prompt: string): Promise<AIReviewResponse[] | null> {
  try {
    core.debug(`Sending request to Anthropic API with model: ${ANTHROPIC_API_MODEL}`);
    
    const response = await withRetry(
      () => anthropic.messages.create({
        model: ANTHROPIC_API_MODEL,
        max_tokens: 1024,
        temperature: 0.2,
        system: "You are a helpful code review assistant that provides feedback in JSON format.",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "anthropic-api" // Add API name for rate limiting
    );

    // Process the content blocks from the response
    let textContent = "";
    
    // The content property is an array of content blocks
    if (response.content && Array.isArray(response.content)) {
      // Find text blocks and concatenate their content
      for (const block of response.content) {
        if (block.type === 'text' && 'text' in block) {
          textContent += block.text;
        }
      }
    }
    
    if (!textContent) {
      core.warning("Received empty or invalid response from Anthropic API");
      return null;
    }
    
    try {
      // Extract JSON from the response - Anthropic might wrap the JSON in markdown code blocks
      let jsonContent = textContent.trim();
      
      // Check if the content is wrapped in a code block and extract it
      const jsonMatch = jsonContent.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
      if (jsonMatch && jsonMatch[1]) {
        jsonContent = jsonMatch[1].trim();
      }
      
      const parsedResponse = JSON.parse(jsonContent);
      const reviews = parsedResponse.reviews || [];
      
      // Validate each review
      const validReviews = reviews.filter(validateAIResponse);
      if (validReviews.length !== reviews.length) {
        core.warning(`Filtered out ${reviews.length - validReviews.length} invalid reviews`);
      }
      
      return validReviews;
    } catch (parseError) {
      core.warning(`Failed to parse Anthropic response as JSON: ${textContent}`);
      // Try to extract JSON from the response
      const jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const extractedJson = JSON.parse(jsonMatch[0]);
          if (extractedJson.reviews) {
            core.info("Successfully extracted JSON from response");
            return extractedJson.reviews.filter(validateAIResponse);
          }
        } catch (extractError) {
          core.warning("Failed to extract JSON from response");
        }
      }
      return null;
    }
  } catch (error) {
    core.error(`Error calling Anthropic API: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Creates GitHub review comments from AI responses
 */
function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: AIReviewResponse[]
): ReviewComment[] {
  if (!file.to) {
    core.debug("Skipping comment creation for file with no destination path");
    return [];
  }

  // Group comments by line number to avoid duplicate comments
  const commentsByLine = new Map<number, string[]>();
  
  aiResponses.forEach((aiResponse) => {
    const lineNumber = Number(aiResponse.lineNumber);
    if (isNaN(lineNumber)) {
      core.warning(`Invalid line number in AI response: ${aiResponse.lineNumber}`);
      return;
    }

    // Validate that the line number is within the chunk's range
    const chunkEndLine = chunk.newStart + chunk.newLines - 1;
    if (lineNumber < chunk.newStart || lineNumber > chunkEndLine) {
      core.warning(`Line number ${lineNumber} is outside chunk range ${chunk.newStart}-${chunkEndLine}`);
      return;
    }

    // Find the change that corresponds to this line number
    const change = chunk.changes.find(c => {
      // @ts-expect-error - ln and ln2 exist where needed
      return c.ln === lineNumber || c.ln2 === lineNumber;
    });

    if (!change) {
      core.warning(`No matching change found for line number ${lineNumber}`);
      return;
    }

    // Validate that the file path exists and is not empty
    if (!file.to || file.to.trim() === '') {
      core.warning(`Invalid file path for comment on line ${lineNumber}`);
      return;
    }

    // Group comments by line number
    if (!commentsByLine.has(lineNumber)) {
      commentsByLine.set(lineNumber, []);
    }
    commentsByLine.get(lineNumber)!.push(aiResponse.reviewComment);
  });

  // Create final comments by combining comments for the same line
  return Array.from(commentsByLine.entries()).map(([lineNumber, comments]) => ({
    path: file.to!,
    body: comments.join('\n\n'), // Separate multiple comments with newlines
    line: lineNumber,
    side: 'RIGHT'  // We always comment on the new version
  }));
}

/**
 * Creates a review on the pull request with the generated comments
 */
async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[]
): Promise<void> {
  try {
    if (comments.length === 0) {
      core.info("No comments to create");
      return;
    }
    
    core.info(`Creating review with ${comments.length} comments`);

    // First get the latest commit SHA with retry
    const { data: pr } = await withRetry(
      () => octokit.pulls.get({
        owner,
        repo,
        pull_number,
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "github-api-get-pr"
    );

    const commitId = pr.head.sha;
    
    // Split comments into batches to handle partial failures
    const BATCH_SIZE = 50; // GitHub's recommended batch size
    const batches = [];
    for (let i = 0; i < comments.length; i += BATCH_SIZE) {
      batches.push(comments.slice(i, i + BATCH_SIZE));
    }

    let successCount = 0;
    let failureCount = 0;
    const failedComments: ReviewComment[] = [];

    for (const batch of batches) {
      try {
        // Extra validation before sending to GitHub
        const validBatch = batch.filter(comment => {
          // Validate path
          if (!comment.path || comment.path.trim() === "") {
            core.warning(`Skipping comment with invalid path: ${comment.line}`);
            return false;
          }
          
          // Validate line number
          if (typeof comment.line !== 'number' || comment.line <= 0) {
            core.warning(`Skipping comment with invalid line number: ${comment.line} for file ${comment.path}`);
            return false;
          }
          
          // Validate body
          if (!comment.body || comment.body.trim() === "") {
            core.warning(`Skipping comment with empty body at line ${comment.line} for file ${comment.path}`);
            return false;
          }
          
          return true;
        });
        
        if (validBatch.length === 0) {
          core.warning("No valid comments in batch after filtering");
          failureCount += batch.length;
          failedComments.push(...batch);
          continue;
        }
        
        // Make API call with rate limiting
        await withRetry(
          () => octokit.pulls.createReview({
            owner,
            repo,
            pull_number,
            commit_id: commitId,
            event: "COMMENT",
            comments: validBatch.map(comment => ({
              path: comment.path,
              body: comment.body,
              line: comment.line,
              side: comment.side || 'RIGHT'
            }))
          }),
          MAX_RETRIES,
          RETRY_DELAY,
          "github-api-create-review"
        );
        
        successCount += validBatch.length;
        
        // If some comments were filtered out, track them as failures
        if (validBatch.length < batch.length) {
          const filtered = batch.length - validBatch.length;
          failureCount += filtered;
          failedComments.push(...batch.filter(comment => 
            !validBatch.some(valid => 
              valid.path === comment.path && 
              valid.line === comment.line &&
              valid.body === comment.body
            )
          ));
        }
      } catch (error) {
        failureCount += batch.length;
        failedComments.push(...batch);
        const errorMessage = error instanceof Error ? error.message : String(error);
        core.warning(`Failed to create batch of ${batch.length} comments: ${errorMessage}`);
        
        // Try to extract the invalid comment from the error message
        if (errorMessage.includes("path is invalid") || errorMessage.includes("line number") || errorMessage.includes("diff hunk")) {
          core.warning("Attempting to identify and remove problematic comments for future batches");
        }
      }
    }

    if (successCount > 0) {
      core.info(`Successfully created ${successCount} comments`);
    }
    if (failureCount > 0) {
      core.warning(`Failed to create ${failureCount} comments`);
      // Log failed comments for debugging (limit to avoid excessive logs)
      const MAX_FAILED_LOGS = 10;
      failedComments.slice(0, MAX_FAILED_LOGS).forEach(comment => {
        core.debug(`Failed comment: ${comment.path}:${comment.line}`);
      });
      if (failedComments.length > MAX_FAILED_LOGS) {
        core.debug(`...and ${failedComments.length - MAX_FAILED_LOGS} more failed comments`);
      }
    }

    if (successCount === 0 && comments.length > 0) {
      throw new Error("Failed to create any comments");
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    if (errorMessage.includes("Pull request review thread path is invalid")) {
      core.error("Failed to create review: One or more file paths in the comments are invalid");
    } else if (errorMessage.includes("Pull request review thread diff hunk can't be blank")) {
      core.error("Failed to create review: One or more line numbers in the comments are invalid");
    } else if (errorMessage.includes("rate limit")) {
      core.error("Failed to create review: GitHub API rate limit exceeded. Try again later.");
    } else {
      core.error(`Failed to create review: ${errorMessage}`);
    }
    throw error;
  }
}

/**
 * Gets the diff for a PR based on the event type
 */
async function getDiffForEvent(prDetails: PRDetails): Promise<string | null> {
  try {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error("GITHUB_EVENT_PATH environment variable is not set");
    }
    
    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
    );
    
    if (eventData.action === "opened") {
      core.info("Processing 'opened' event");
      return await getDiff(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number
      );
    } else if (eventData.action === "synchronize") {
      core.info("Processing 'synchronize' event");
      const newBaseSha = eventData.before;
      const newHeadSha = eventData.after;

      if (!newBaseSha || !newHeadSha) {
        throw new Error("Missing base or head SHA for synchronize event");
      }

      const response = await octokit.repos.compareCommits({
        headers: {
          accept: "application/vnd.github.v3.diff",
        },
        owner: prDetails.owner,
        repo: prDetails.repo,
        base: newBaseSha,
        head: newHeadSha,
      });

      return String(response.data);
    } else {
      core.warning(`Unsupported event action: ${eventData.action}`);
      return null;
    }
  } catch (error) {
    core.error(`Failed to get diff for event: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Filters files based on exclude patterns
 */
function filterFiles(parsedDiff: File[]): File[] {
  if (EXCLUDE_PATTERNS.length === 0) {
    return parsedDiff;
  }
  
  core.info(`Filtering files with exclude patterns: ${EXCLUDE_PATTERNS.join(', ')}`);
  
  return parsedDiff.filter((file) => {
    if (!file.to) return false;
    
    const shouldExclude = EXCLUDE_PATTERNS.some((pattern) => 
      minimatch(file.to!, pattern)
    );
    
    if (shouldExclude) {
      core.debug(`Excluding file: ${file.to}`);
    }
    
    return !shouldExclude;
  });
}

/**
 * Validates the configuration based on the selected AI provider
 */
function validateConfig(): void {
  if (AI_PROVIDER.toLowerCase() === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required when using Anthropic as the AI provider");
    }
    core.info(`Using Anthropic as AI provider with model: ${ANTHROPIC_API_MODEL}`);
  } else {
    // Default to OpenAI
    if (!OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required when using OpenAI as the AI provider");
    }
    core.info(`Using OpenAI as AI provider with model: ${OPENAI_API_MODEL}`);
  }
}

/**
 * Main function
 */
export async function main() {
  try {
    core.info("Starting AI code review");
    core.info(`Configuration:
- AI Provider: ${AI_PROVIDER}
- Model: ${AI_PROVIDER === 'openai' ? OPENAI_API_MODEL : ANTHROPIC_API_MODEL}
- Max Files: ${MAX_FILES > 0 ? MAX_FILES : 'No limit'}
- Exclude Patterns: ${EXCLUDE_PATTERNS.length > 0 ? EXCLUDE_PATTERNS.join(', ') : 'None'}`);
    
    // Validate configuration
    validateConfig();
    
    // Get PR details
    const prDetails = await getPRDetails();
    core.info(`Processing PR #${prDetails.pull_number} in ${prDetails.owner}/${prDetails.repo}`);
    core.info(`PR Title: ${prDetails.title}`);
    if (prDetails.description) {
      core.info(`PR Description: ${prDetails.description}`);
    }
    
    // Get diff
    const diff = await getDiffForEvent(prDetails);
    
    if (!diff) {
      core.info("No diff found or unsupported event");
      return;
    }
    
    // Parse and filter diff
    const parsedDiff = parseDiff(diff);
    core.info(`\nFound ${parsedDiff.length} changed files:`);
    parsedDiff.forEach(file => {
      core.info(`- ${file.to} (+${file.additions} -${file.deletions})`);
    });
    
    const filteredDiff = filterFiles(parsedDiff);
    core.info(`\nAnalyzing ${filteredDiff.length} files after filtering`);
    
    // Analyze code and create comments
    const comments = await analyzeCode(filteredDiff, prDetails);
    
    // Create review if there are comments
    if (comments.length > 0) {
      core.info(`\nCreating review with ${comments.length} comments:`);
      comments.forEach(comment => {
        core.info(`- ${comment.path}:${comment.line} - ${comment.body.split('\n')[0]}...`);
      });
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
    } else {
      core.info("\nNo comments to add");
    }
    
    core.info("\nAI code review completed successfully");
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Only run the main function if this file is being run directly
if (require.main === module) {
  main().catch((error) => {
    core.setFailed(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
