import { readFileSync } from "fs";
import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import parseDiff from "parse-diff";
import { PRDetails, ReviewComment } from "../types";
import { GITHUB_TOKEN, MAX_RETRIES, RETRY_DELAY } from "../config";
import { withRetry } from "./retry";

// Initialize GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Fetches pull request details from GitHub
 */
export async function getPRDetails(): Promise<PRDetails> {
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

    const prResponse = await withRetry(
      () => octokit.pulls.get({
        owner: repository.owner.login,
        repo: repository.name,
        pull_number: number,
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "github-api-get-pr"
    );

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
export async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string> {
  try {
    if (!process.env.GITHUB_EVENT_PATH) {
      throw new Error("GITHUB_EVENT_PATH environment variable is not set");
    }

    const eventData = JSON.parse(
      readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
    );

    // Log the event type for debugging
    core.debug(`Processing GitHub event type: ${eventData.action || 'unknown'}`);

    // If this is a pull request event, get the diff from the event payload
    if (eventData.pull_request) {
      core.info("Processing pull request event - getting full PR diff");
      const response = await withRetry(
        () => octokit.pulls.get({
          owner,
          repo,
          pull_number,
          mediaType: { format: "diff" },
        }),
        MAX_RETRIES,
        RETRY_DELAY,
        "github-api-get-diff"
      );
      
      // @ts-expect-error - response.data is a string when mediaType.format is "diff"
      return response.data;
    }

    // For other events (like push), get the diff between the current and previous commit
    if (eventData.commits && eventData.commits.length > 0) {
      core.info("Processing push event - getting diff between commits");
      const currentCommit = eventData.after;
      const previousCommit = eventData.before;
      
      if (!currentCommit || !previousCommit) {
        throw new Error("Missing commit information in event payload");
      }

      core.debug(`Comparing commits: ${previousCommit} -> ${currentCommit}`);
      const response = await withRetry(
        () => octokit.repos.compareCommits({
          owner,
          repo,
          base: previousCommit,
          head: currentCommit,
          mediaType: { format: "diff" },
        }),
        MAX_RETRIES,
        RETRY_DELAY,
        "github-api-compare-commits"
      );
      
      // @ts-expect-error - response.data is a string when mediaType.format is "diff"
      return response.data;
    }

    throw new Error("Unsupported event type or missing commit information");
  } catch (error) {
    core.error(`Failed to get diff: ${error instanceof Error ? error.message : String(error)}`);
    throw error;
  }
}

/**
 * Creates a review on the pull request with the generated comments
 */
export async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: ReviewComment[]
): Promise<void> {
  try {
    // Get the latest commit ID
    const { data: pullRequest } = await withRetry(
      () => octokit.pulls.get({
        owner,
        repo,
        pull_number,
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "github-api-get-pr"
    );

    const commitId = pullRequest.head.sha;
    if (!commitId) {
      throw new Error("Failed to get commit ID from pull request");
    }

    // Get the diff to validate file paths and line numbers
    const prDiff = await withRetry(
      () => octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        repo,
        pull_number,
        mediaType: {
          format: 'diff'
        }
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "github-api-get-diff"
    );

    const parsedDiff = parseDiff(prDiff.data as unknown as string);
    const validFiles = new Set(parsedDiff.map(file => file.to).filter(Boolean));
    
    // Enhanced validation with diff awareness
    const validatedComments = comments.filter(comment => {
      // Validate path exists in current PR diff
      if (!validFiles.has(comment.path)) {
        core.warning(`File path ${comment.path} not found in PR diff - skipping comment`);
        return false;
      }
      
      // Find the file in the diff
      const diffFile = parsedDiff.find(file => file.to === comment.path);
      if (!diffFile) {
        core.warning(`File ${comment.path} not found in parsed diff - skipping comment`);
        return false;
      }
      
      // Check if the line number is within any chunk's range
      const isLineInAnyChunk = diffFile.chunks.some(chunk => {
        const chunkEndLine = chunk.newStart + chunk.newLines - 1;
        return comment.line >= chunk.newStart && comment.line <= chunkEndLine;
      });
      
      if (!isLineInAnyChunk) {
        core.warning(`Line ${comment.line} in file ${comment.path} not found in any diff chunk - skipping comment`);
        return false;
      }
      
      // Validate other aspects
      if (typeof comment.line !== 'number' || comment.line <= 0) {
        core.warning(`Invalid line number ${comment.line} for file ${comment.path} - skipping comment`);
        return false;
      }
      
      if (!comment.body || comment.body.trim() === "") {
        core.warning(`Empty comment body at line ${comment.line} for file ${comment.path} - skipping comment`);
        return false;
      }
      
      return true;
    });

    if (validatedComments.length === 0) {
      core.warning("No valid comments after enhanced validation");
      return;
    }

    // Process comments in batches with improved error handling
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < validatedComments.length; i += BATCH_SIZE) {
      batches.push(validatedComments.slice(i, i + BATCH_SIZE));
    }

    let successCount = 0;
    let failureCount = 0;
    const failedComments: ReviewComment[] = [];

    for (const batch of batches) {
      try {
        // Validate batch before sending
        const validBatch = batch.filter(comment => {
          // Additional validation for the batch
          if (!comment.path || !comment.body || !comment.line) {
            core.warning(`Invalid comment in batch: ${JSON.stringify(comment)}`);
            return false;
          }
          return true;
        });

        if (validBatch.length === 0) {
          core.warning("No valid comments in batch after additional validation");
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
        if (errorMessage.includes("path is invalid") || 
            errorMessage.includes("line number") || 
            errorMessage.includes("diff hunk")) {
          core.warning("Attempting to identify and remove problematic comments for future batches");
        }
      }
    }

    // Log results
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