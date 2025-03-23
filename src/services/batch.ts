import * as core from "@actions/core";
import { File, Chunk } from "parse-diff";
import { BatchedReviewRequest } from "../types";
import { getLanguageFromPath } from "../utils";
import { getCodebaseContextForFile } from "./context";

/**
 * Estimates the number of tokens in a string
 */
function estimateTokens(str: string): number {
  // Rough estimation: 1 token ≈ 4 characters
  return Math.ceil(str.length / 4);
}

/**
 * Splits a file into chunks based on size limits
 */
function splitFileIntoChunks(file: File): Chunk[] {
  const chunks: Chunk[] = [];
  let currentChunk: Chunk | null = null;

  for (const change of file.chunks) {
    if (!currentChunk) {
      currentChunk = { ...change };
      continue;
    }

    const currentTotalLines = currentChunk.newLines + currentChunk.oldLines;
    const nextTotalLines = change.newLines + change.oldLines;

    // If merging would exceed size limit, start new chunk
    if (currentTotalLines + nextTotalLines > 1000) { // Adjust this limit as needed
      chunks.push(currentChunk);
      currentChunk = { ...change };
    } else {
      // Merge chunks
      currentChunk.newLines = change.newStart + change.newLines - currentChunk.newStart;
      currentChunk.oldLines += change.oldLines;
      currentChunk.changes = [...currentChunk.changes, ...change.changes];
    }
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

/**
 * Prepares batched review requests
 */
export async function prepareBatchedReviewRequests(
  files: File[],
  prDetails: { title: string; description: string },
  maxTokens: number,
  octokit: any,
  owner: string,
  repo: string
): Promise<BatchedReviewRequest[]> {
  const batches: BatchedReviewRequest[] = [];
  let currentBatch: BatchedReviewRequest = {
    files: [],
    prContext: {
      title: prDetails.title,
      description: prDetails.description
    }
  };

  let currentTokenCount = 0;

  for (const file of files) {
    if (!file.to) {
      core.debug(`Skipping deleted file: ${file.from}`);
      continue;
    }

    // Get codebase context for the file
    const context = await getCodebaseContextForFile(file.to, octokit, owner, repo);

    // Split file into chunks
    const chunks = splitFileIntoChunks(file);

    // Calculate tokens for this file's chunks and context
    const fileTokens = estimateTokens(
      chunks.map(chunk => chunk.changes.map(c => c.content).join('\n')).join('\n') +
      context.relevantFiles.map(f => f.content).join('\n')
    );

    if (currentTokenCount + fileTokens > maxTokens) {
      // Start new batch
      if (currentBatch.files.length > 0) {
        batches.push(currentBatch);
      }
      currentBatch = {
        files: [],
        prContext: {
          title: prDetails.title,
          description: prDetails.description
        }
      };
      currentTokenCount = 0;
    }

    currentBatch.files.push({
      path: file.to,
      language: getLanguageFromPath(file.to),
      chunks: chunks.map(chunk => ({
        changes: chunk.changes.map(c => c.content).join('\n'),
        lineRange: {
          start: chunk.newStart,
          end: chunk.newStart + chunk.newLines - 1
        }
      }))
    });

    currentTokenCount += fileTokens;
  }

  // Add the last batch if it has files
  if (currentBatch.files.length > 0) {
    batches.push(currentBatch);
  }

  core.info(`Created ${batches.length} batches for ${files.length} files`);
  batches.forEach((batch, idx) => {
    core.debug(`Batch ${idx + 1}: ${batch.files.length} files`);
  });

  return batches;
}

/**
 * Creates a prompt for a batched review request
 */
export function createBatchedPrompt(batch: BatchedReviewRequest): string {
  const fileContents = batch.files.map(file => {
    const chunks = file.chunks.map(chunk => 
      `File: ${file.path}\nLanguage: ${file.language}\nLines ${chunk.lineRange.start}-${chunk.lineRange.end}:\n${chunk.changes}`
    ).join('\n\n');
    return chunks;
  }).join('\n\n');

  return `Review the following code changes across multiple files:

${fileContents}

Pull request title: ${batch.prContext.title}
Pull request description:
---
${batch.prContext.description}
---

Focus on:
1. Code quality and best practices
2. Bugs or logical errors
3. Security vulnerabilities
4. Performance problems
5. Maintainability and readability
6. Test coverage and testability
7. Missing or incorrect documentation
8. Accessibility issues
9. Browser or device compatibility
10. Dependencies and their versions
11. Code duplication
12. Naming conventions
13. Architectural concerns
14. Standards compliance

Provide specific and actionable feedback in JSON format.`;
} 