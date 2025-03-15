import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";

const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
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
 * Gets AI response for a given prompt
 */
async function getAIResponse(prompt: string): Promise<AIReviewResponse[] | null> {
  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    core.debug(`Sending request to OpenAI API with model: ${OPENAI_API_MODEL}`);
    
    const response = await openai.chat.completions.create({
      ...queryConfig,
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
      core.warning(`Failed to parse AI response as JSON: ${content}`);
      return null;
    }
  } catch (error) {
    core.error(`Error calling OpenAI API: ${error instanceof Error ? error.message : String(error)}`);
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
 * Main function
 */
async function main() {
  try {
    core.info("Starting AI code review");
    
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
