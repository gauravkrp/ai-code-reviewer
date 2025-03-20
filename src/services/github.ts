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
    
    // Handle different event types
    if (eventData.pull_request) {
      // Pull request event
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
        eventType: 'pull_request'
      };
    } else if (eventData.commits && eventData.commits.length > 0) {
      // Push event
      const { repository, ref, after } = eventData;
      
      if (!repository) {
        throw new Error("Invalid event data: missing repository information");
      }
      
      // For push events, we don't have a pull number, so we'll use 0 as a placeholder
      return {
        owner: repository.owner.login || repository.owner.name,
        repo: repository.name,
        pull_number: 0, // Placeholder for push events
        title: "Push event", // Will be replaced with commit message in main.ts
        description: "", // Will be populated with commit messages in main.ts
        ref: ref?.replace('refs/heads/', ''), // Branch name
        commit: after, // The current commit SHA
        eventType: 'push'
      };
    } else {
      // Handle other event types gracefully
      let owner = '';
      let repo = '';
      
      // Try to extract repository info from various places in the event data
      if (eventData.repository) {
        owner = eventData.repository.owner?.login || eventData.repository.owner?.name || '';
        repo = eventData.repository.name || '';
      }
      
      // Fallback to environment variables if necessary
      if (!owner || !repo) {
        const githubRepository = process.env.GITHUB_REPOSITORY || '';
        const [repoOwner, repoName] = githubRepository.split('/');
        owner = owner || repoOwner;
        repo = repo || repoName;
      }
      
      if (!owner || !repo) {
        throw new Error("Could not determine repository owner and name from event data");
      }
      
      return {
        owner,
        repo,
        pull_number: 0,
        title: "GitHub event",
        description: `Event type: ${eventData.action || 'unknown'}`,
        eventType: 'other'
      };
    }
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
    const eventType = eventData.action || (eventData.commits ? 'push' : 'unknown');
    core.debug(`Processing GitHub event type: ${eventType}`);

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

    // For push events, get only the diff of the pushed commits
    if (eventData.commits && eventData.commits.length > 0) {
      core.info("Processing push event - getting diff of pushed commits only");
      
      // For push events, we should only analyze the pushed commits, not the entire PR
      const currentCommit = eventData.after;
      const baseCommit = eventData.before;
      
      if (!currentCommit) {
        throw new Error("Missing commit information in event payload");
      }

      // If it's the first commit in a repo, use a different approach
      if (baseCommit === '0000000000000000000000000000000000000000') {
        core.debug(`First commit detected: ${currentCommit}`);
        // Get the commit details to get its files
        const response = await withRetry(
          () => octokit.repos.getCommit({
            owner,
            repo,
            ref: currentCommit
          }),
          MAX_RETRIES,
          RETRY_DELAY,
          "github-api-get-commit"
        );
        
        // Construct a proper diff for each file in the commit
        let manualDiff = "";
        for (const file of response.data.files || []) {
          manualDiff += `diff --git a/${file.filename} b/${file.filename}\n`;
          
          if (file.status === 'added') {
            manualDiff += `new file mode 100644\n`;
            manualDiff += `index 0000000..${file.sha.substring(0, 7)}\n`;
            manualDiff += `--- /dev/null\n`;
            manualDiff += `+++ b/${file.filename}\n`;
            
            // Get the actual content of the file
            try {
              const contentResponse = await withRetry(
                () => octokit.repos.getContent({
                  owner,
                  repo,
                  path: file.filename,
                  ref: currentCommit
                }),
                MAX_RETRIES,
                RETRY_DELAY,
                "github-api-get-content"
              );
              
              if ('content' in contentResponse.data && contentResponse.data.content) {
                const content = Buffer.from(contentResponse.data.content, 'base64').toString('utf8');
                const lines = content.split('\n');
                
                manualDiff += `@@ -0,0 +1,${lines.length} @@\n`;
                lines.forEach(line => {
                  manualDiff += `+${line}\n`;
                });
              } else {
                // Fallback if we can't get content
                manualDiff += `@@ -0,0 +1,${file.additions} @@\n`;
                manualDiff += `+// Added ${file.additions} lines (content not available)\n`;
              }
            } catch (contentError) {
              core.warning(`Failed to get content for ${file.filename}: ${contentError instanceof Error ? contentError.message : String(contentError)}`);
              manualDiff += `@@ -0,0 +1,${file.additions} @@\n`;
              manualDiff += `+// Added ${file.additions} lines (content not available)\n`;
            }
          } else if (file.status === 'modified') {
            manualDiff += `index ${file.sha.substring(0, 7)}..${file.sha.substring(0, 7)} 100644\n`;
            manualDiff += `--- a/${file.filename}\n`;
            manualDiff += `+++ b/${file.filename}\n`;
            manualDiff += `@@ -1,${file.changes - file.additions} +1,${file.changes - file.deletions} @@\n`;
            
            // For modified files, we'd need the patch info
            if (file.patch) {
              manualDiff += file.patch;
            } else {
              manualDiff += `// Modified file with ${file.additions} additions and ${file.deletions} deletions\n`;
            }
          } else if (file.status === 'removed') {
            manualDiff += `deleted file mode 100644\n`;
            manualDiff += `index ${file.sha.substring(0, 7)}..0000000\n`;
            manualDiff += `--- a/${file.filename}\n`;
            manualDiff += `+++ /dev/null\n`;
            manualDiff += `@@ -1,${file.deletions} +0,0 @@\n`;
            manualDiff += `// Removed ${file.deletions} lines\n`;
          }
        }
        
        return manualDiff;
      }

      core.debug(`Comparing pushed commits: ${baseCommit} -> ${currentCommit}`);
      const response = await withRetry(
        () => octokit.repos.compareCommits({
          owner,
          repo,
          base: baseCommit,
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
    const validatedComments = await Promise.all(comments.map(async (comment) => {
      // Additional logging for each comment being validated
      core.debug(`Validating comment: ${comment.path}:${comment.line}`);

      // Validate path exists in current PR diff
      if (!validFiles.has(comment.path)) {
        core.warning(`File path ${comment.path} not found in PR diff - skipping comment`);
        return null;
      }
      
      // Find the file in the diff
      const diffFile = parsedDiff.find(file => file.to === comment.path);
      if (!diffFile) {
        core.warning(`File ${comment.path} not found in parsed diff - skipping comment`);
        return null;
      }
      
      // Check if the line number is within any chunk's range
      const isLineInAnyChunk = diffFile.chunks.some(chunk => {
        const chunkEndLine = chunk.newStart + chunk.newLines - 1;
        return comment.line >= chunk.newStart && comment.line <= chunkEndLine;
      });
      
      if (!isLineInAnyChunk) {
        core.warning(`Line ${comment.line} in file ${comment.path} not found in any diff chunk - skipping comment`);
        
        // Log the available chunks for debugging
        const chunkRanges = diffFile.chunks.map(chunk => {
          return `${chunk.newStart}-${chunk.newStart + chunk.newLines - 1}`;
        }).join(', ');
        core.debug(`Available chunks in ${comment.path}: ${chunkRanges}`);
        
        // Attempt to validate line against full file content via GitHub API
        try {
          core.debug(`Attempting to validate line ${comment.line} against full file content...`);
          
          // Get the file content from GitHub to check if line is valid in full file
          const fileContentResponse = await withRetry(
            () => octokit.repos.getContent({
              owner,
              repo,
              path: comment.path,
              ref: commitId
            }),
            MAX_RETRIES,
            RETRY_DELAY,
            "github-api-get-content"
          );
          
          if ('content' in fileContentResponse.data && fileContentResponse.data.content) {
            const fileContent = Buffer.from(fileContentResponse.data.content, 'base64').toString('utf8');
            const fileLines = fileContent.split('\n');
            
            if (comment.line <= fileLines.length) {
              core.info(`Line ${comment.line} exists in full file (outside diff chunks) - keeping comment`);
              
              // Adjust comment to point to a valid line in the diff if possible
              const nearestChunk = diffFile.chunks
                .map(chunk => ({
                  chunk,
                  start: chunk.newStart,
                  end: chunk.newStart + chunk.newLines - 1,
                  distance: Math.min(
                    Math.abs(comment.line - chunk.newStart),
                    Math.abs(comment.line - (chunk.newStart + chunk.newLines - 1))
                  )
                }))
                .sort((a, b) => a.distance - b.distance)[0];
              
              if (nearestChunk) {
                core.info(`Adjusting line ${comment.line} to ${nearestChunk.start} (nearest valid line in diff chunk)`);
                
                // Create an adjusted copy of the comment
                const adjustedComment = {
                  ...comment,
                  line: nearestChunk.start,
                  body: `**Note: This comment was originally for line ${comment.line} but was adjusted to fit in the viewable diff.**\n\n${comment.body}`
                };
                
                return adjustedComment;
              }
            } else {
              core.debug(`Line ${comment.line} exceeds file length (${fileLines.length} lines) - skipping comment`);
            }
          }
        } catch (error) {
          core.debug(`Failed to validate line against full file content: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        return null;
      }
      
      // Validate other aspects
      if (typeof comment.line !== 'number' || comment.line <= 0) {
        core.warning(`Invalid line number ${comment.line} for file ${comment.path} - skipping comment`);
        return null;
      }
      
      if (!comment.body || comment.body.trim() === "") {
        core.warning(`Empty comment body at line ${comment.line} for file ${comment.path} - skipping comment`);
        return null;
      }
      
      core.debug(`Validated comment at ${comment.path}:${comment.line} - valid`);
      return comment;
    }));

    // Filter out null values from the validated comments
    const filteredComments = validatedComments.filter(comment => comment !== null) as ReviewComment[];

    if (filteredComments.length === 0) {
      core.warning("No valid comments after enhanced validation");
      
      if (comments.length > 0) {
        core.debug(`All ${comments.length} comments were filtered out during validation`);
        // Log a preview of the first few invalid comments
        const MAX_PREVIEW = 3;
        comments.slice(0, MAX_PREVIEW).forEach((comment, idx) => {
          core.debug(`Invalid comment ${idx+1}: ${JSON.stringify(comment)}`);
        });
        if (comments.length > MAX_PREVIEW) {
          core.debug(`...and ${comments.length - MAX_PREVIEW} more invalid comments`);
        }
      }
      
      return;
    }

    // Process comments in batches with improved error handling
    const BATCH_SIZE = 10;
    const batches = [];
    for (let i = 0; i < filteredComments.length; i += BATCH_SIZE) {
      batches.push(filteredComments.slice(i, i + BATCH_SIZE));
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
        
        // Log more detailed info only for debug logs
        if (error instanceof Error) {
          // Log the full error details to debug
          core.debug(`Full error details: ${JSON.stringify({
            name: error.name,
            message: error.message,
            stack: error.stack
          }, null, 2)}`);
          
          // Log the request details that caused the failure
          const errorObj = error as any;
          if (errorObj.request) {
            core.debug(`Request method: ${errorObj.request.method}`);
            core.debug(`Request path: ${errorObj.request.path}`);
          }
          
          // Log the response details if available
          if (errorObj.response) {
            core.debug(`Response status: ${errorObj.response.status}`);
            core.debug(`Response headers: ${JSON.stringify(errorObj.response.headers || {})}`);
            core.debug(`Response data: ${JSON.stringify(errorObj.response.data || {}, null, 2)}`);
          }
        }
        
        // Try to extract the invalid comment from the error message
        if (errorMessage.includes("path is invalid") || 
            errorMessage.includes("line number") || 
            errorMessage.includes("diff hunk")) {
          core.warning("Attempting to identify and remove problematic comments for future batches");
          
          // Log the current batch that failed for debugging
          core.debug(`Failed batch comments: ${JSON.stringify(batch.map(comment => ({
            path: comment.path,
            line: comment.line,
            bodyLength: comment.body?.length || 0
          })), null, 2)}`);
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