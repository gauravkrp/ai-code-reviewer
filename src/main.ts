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
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const ANTHROPIC_API_KEY: string = core.getInput("ANTHROPIC_API_KEY");
const ANTHROPIC_API_MODEL: string = core.getInput("ANTHROPIC_API_MODEL") || "claude-3-7-sonnet-20250219"; // Latest model
const EXCLUDE_PATTERNS: string[] = core
  .getInput("exclude")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean); // Filter out empty strings

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
  line: number;
}

interface AIReviewResponse {
  lineNumber: string;
  reviewComment: string;
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
 * Analyzes code diffs using AI and generates review comments
 */
async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
): Promise<ReviewComment[]> {
  const comments: ReviewComment[] = [];
  core.info(`Analyzing ${parsedDiff.length} files...`);

  for (const file of parsedDiff) {
    if (file.to === "/dev/null") {
      core.debug(`Skipping deleted file: ${file.from}`);
      continue; // Ignore deleted files
    }
    
    core.debug(`Analyzing file: ${file.to}`);
    
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      
      if (aiResponse && aiResponse.length > 0) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments.length > 0) {
          core.debug(`Generated ${newComments.length} comments for ${file.to}`);
          comments.push(...newComments);
        }
      }
    }
  }
  
  core.info(`Analysis complete. Generated ${comments.length} comments.`);
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
`;
}

/**
 * Gets AI response for a given prompt using the configured AI provider
 */
async function getAIResponse(prompt: string): Promise<AIReviewResponse[] | null> {
  try {
    if (AI_PROVIDER.toLowerCase() === "anthropic") {
      return await getAnthropicResponse(prompt);
    } else {
      return await getOpenAIResponse(prompt);
    }
  } catch (error) {
    core.error(`Error getting AI response: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Gets response from OpenAI API
 */
async function getOpenAIResponse(prompt: string): Promise<AIReviewResponse[] | null> {
  // Base configuration for the API request
  const baseConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  // Add token limit based on model type
  // For o1/o3 series models, use max_completion_tokens
  // For older models, use max_tokens
  const tokenConfig = OPENAI_API_MODEL.startsWith('o') 
    ? { max_completion_tokens: 1500 }
    : { max_tokens: 1500 };

  try {
    core.debug(`Sending request to OpenAI API with model: ${OPENAI_API_MODEL}`);
    
    const response = await openai.chat.completions.create({
      ...baseConfig,
      ...tokenConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const content = response.choices[0].message?.content?.trim();
    
    if (!content) {
      core.warning("Received empty response from OpenAI API");
      return null;
    }
    
    try {
      const parsedResponse = JSON.parse(content);
      return parsedResponse.reviews || [];
    } catch (parseError) {
      core.warning(`Failed to parse OpenAI response as JSON: ${content}`);
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
    
    const response = await anthropic.messages.create({
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
    });

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
      return parsedResponse.reviews || [];
    } catch (parseError) {
      core.warning(`Failed to parse Anthropic response as JSON: ${textContent}`);
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
  
  return aiResponses.map((aiResponse) => ({
    body: aiResponse.reviewComment,
    path: file.to!,
    line: Number(aiResponse.lineNumber),
  })).filter(comment => !isNaN(comment.line)); // Filter out comments with invalid line numbers
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
    core.info(`Creating review with ${comments.length} comments`);
    
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });
    
    core.info("Review created successfully");
  } catch (error) {
    core.error(`Failed to create review: ${error instanceof Error ? error.message : String(error)}`);
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
async function main() {
  try {
    core.info("Starting AI code review");
    
    // Validate configuration
    validateConfig();
    
    // Get PR details
    const prDetails = await getPRDetails();
    core.info(`Processing PR #${prDetails.pull_number} in ${prDetails.owner}/${prDetails.repo}`);
    
    // Get diff
    const diff = await getDiffForEvent(prDetails);
    
    if (!diff) {
      core.info("No diff found or unsupported event");
      return;
    }
    
    // Parse and filter diff
    const parsedDiff = parseDiff(diff);
    core.info(`Found ${parsedDiff.length} changed files`);
    
    const filteredDiff = filterFiles(parsedDiff);
    core.info(`Analyzing ${filteredDiff.length} files after filtering`);
    
    // Analyze code and create comments
    const comments = await analyzeCode(filteredDiff, prDetails);
    
    // Create review if there are comments
    if (comments.length > 0) {
      core.info(`Creating review with ${comments.length} comments`);
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
    } else {
      core.info("No comments to add");
    }
    
    core.info("AI code review completed successfully");
  } catch (error) {
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Run the main function
main().catch((error) => {
  core.setFailed(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
