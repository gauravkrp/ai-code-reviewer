import * as core from "@actions/core";
import parseDiff, { File, Chunk } from "parse-diff";
import minimatch from "minimatch";
import { ReviewComment, PRDetails } from "./types";
import { 
  AI_PROVIDER, 
  MAX_FILES, 
  EXCLUDE_PATTERNS,
  OPENAI_API_KEY,
  OPENAI_API_MODEL,
  ANTHROPIC_API_KEY,
  ANTHROPIC_API_MODEL,
  MAX_CHUNK_TOTAL_LINES,
  MAX_FILE_TOTAL_LINES
} from "./config";
import { isFileTooLarge, isChunkTooLarge } from "./utils";
import { getPRDetails, getDiff, createReviewComment } from "./services/github";
import { getAIResponse, createComment, createPrompt } from "./services/ai";

// Constants for configuration
const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");

/**
 * Filters files based on exclude patterns
 * Removes files that match any of the exclude patterns specified in configuration
 * 
 * @param parsedDiff - Array of files from the parsed diff
 * @returns Filtered array of files
 */
function filterFiles(parsedDiff: File[]): File[] {
  if (EXCLUDE_PATTERNS.length === 0) {
    core.debug('No exclude patterns specified, skipping file filtering');
    return parsedDiff;
  }
  
  core.info(`Filtering files with exclude patterns: ${EXCLUDE_PATTERNS.join(', ')}`);
  
  const originalCount = parsedDiff.length;
  const filtered = parsedDiff.filter((file) => {
    if (!file.to) {
      core.debug(`Skipping file without path (probably deleted): ${file.from || 'unknown'}`);
      return false;
    }
    
    const shouldExclude = EXCLUDE_PATTERNS.some((pattern) => minimatch(file.to!, pattern));
    
    if (shouldExclude) {
      core.debug(`Excluding file: ${file.to} (matched exclude pattern)`);
    }
    
    return !shouldExclude;
  });
  
  const excludedCount = originalCount - filtered.length;
  if (excludedCount > 0) {
    core.info(`Excluded ${excludedCount} files based on patterns`);
  }
  
  return filtered;
}

/**
 * Validates the configuration based on the selected AI provider
 * Ensures required API keys are present and logs the active configuration
 * 
 * @throws Error if required API keys are missing
 */
function validateConfig(): void {
  core.debug('Validating configuration...');
  
  if (AI_PROVIDER.toLowerCase() === "anthropic") {
    if (!ANTHROPIC_API_KEY) {
      const error = "ANTHROPIC_API_KEY is required when using Anthropic as the AI provider";
      core.error(error);
      throw new Error(error);
    }
    core.info(`Using Anthropic as AI provider with model: ${ANTHROPIC_API_MODEL}`);
  } else {
    // Default to OpenAI
    if (!OPENAI_API_KEY) {
      const error = "OPENAI_API_KEY is required when using OpenAI as the AI provider";
      core.error(error);
      throw new Error(error);
    }
    core.info(`Using OpenAI as AI provider with model: ${OPENAI_API_MODEL}`);
  }
  
  if (!GITHUB_TOKEN) {
    const error = "GITHUB_TOKEN is required for accessing GitHub API";
    core.error(error);
    throw new Error(error);
  }
  
  core.debug('Configuration validation successful');
}

/**
 * Processes a file's diff and generates review comments
 * Breaks down the file into chunks and processes each chunk individually
 * 
 * @param file - The file to process
 * @param prDetails - Pull request details
 * @returns Array of review comments
 */
async function processFile(file: File, prDetails: PRDetails): Promise<ReviewComment[]> {
  const filePath = file.to || file.from || 'unknown';
  core.debug(`Beginning to process file: ${filePath}`);
  
  if (isFileTooLarge(file)) {
    core.info(`Skipping file ${filePath}: File exceeds size limits`);
    return [];
  }

  const comments: ReviewComment[] = [];
  core.debug(`File has ${file.chunks.length} chunks to process`);
  
  // Merge small chunks together
  const mergedChunks: Chunk[] = [];
  let currentChunk: Chunk | null = null;
  
  for (const chunk of file.chunks) {
    if (!currentChunk) {
      currentChunk = { ...chunk };
    } else {
      // If the current chunk is small and the next chunk is small, merge them
      const currentTotalLines = currentChunk.newLines + currentChunk.oldLines;
      const nextTotalLines = chunk.newLines + chunk.oldLines;
      
      if (currentTotalLines < 200 && nextTotalLines < 200) {
        // Merge chunks
        currentChunk.newLines += chunk.newLines;
        currentChunk.oldLines += chunk.oldLines;
        currentChunk.changes = [...currentChunk.changes, ...chunk.changes];
      } else {
        // Add current chunk and start a new one
        mergedChunks.push(currentChunk);
        currentChunk = { ...chunk };
      }
    }
  }
  
  // Add the last chunk if it exists
  if (currentChunk) {
    mergedChunks.push(currentChunk);
  }
  
  core.debug(`Merged ${file.chunks.length} chunks into ${mergedChunks.length} chunks`);
  
  for (let i = 0; i < mergedChunks.length; i++) {
    const chunk = mergedChunks[i];
    core.debug(`Processing chunk ${i+1}/${mergedChunks.length}: lines ${chunk.newStart}-${chunk.newStart + chunk.newLines - 1}`);
    
    if (isChunkTooLarge(chunk)) {
      core.info(`Skipping chunk ${i+1} in ${filePath}: Chunk exceeds size limits`);
      continue;
    }

    // Skip chunks with no new lines
    if (chunk.newLines === 0) {
      core.debug(`Skipping chunk ${i+1} in ${filePath}: No new lines to review`);
      continue;
    }

    // Create a prompt for the AI
    const prompt = createPrompt(file, chunk, prDetails);
    
    // Get AI response
    core.debug(`Sending chunk ${i+1} to AI for review`);
    const aiResponses = await getAIResponse(prompt, chunk, prDetails);
    
    if (!aiResponses || aiResponses.length === 0) {
      core.debug(`No AI review comments generated for chunk ${i+1} in ${filePath}`);
      continue;
    }

    core.info(`Received ${aiResponses.length} comments from AI for chunk ${i+1} in ${filePath}`);
    
    // Process each AI response and create comments
    for (const response of aiResponses) {
      const comment = createComment(file, chunk, response);
      
      if (comment !== null) {
        core.debug(`Added comment at line ${comment.line} in ${comment.path}`);
        comments.push(comment);
      } else {
        core.debug(`Failed to create comment for line ${response.lineNumber} (invalid or out of range)`);
      }
    }
  }

  core.info(`Generated ${comments.length} comments for file ${filePath}`);
  return comments;
}

/**
 * Analyzes code diffs using AI and generates review comments
 * Orchestrates the processing of all files in the diff, with concurrency control
 * 
 * @param parsedDiff - Array of files from the parsed diff
 * @param prDetails - Pull request details
 * @returns Array of all review comments across files
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
    core.info(`Limiting analysis to first ${MAX_FILES} files as per MAX_FILES setting (${parsedDiff.length - MAX_FILES} files excluded)`);
  }

  // Track analysis stats
  let processedFiles = 0;
  let skippedFiles = 0;
  let erroredFiles = 0;
  const startTime = Date.now();

  // Process files in parallel with a concurrency limit
  const CONCURRENT_FILES = 3;
  core.info(`Processing files with concurrency level: ${CONCURRENT_FILES}`);
  
  for (let i = 0; i < filesToAnalyze.length; i += CONCURRENT_FILES) {
    const batchNumber = Math.floor(i / CONCURRENT_FILES) + 1;
    const batchSize = Math.min(CONCURRENT_FILES, filesToAnalyze.length - i);
    const fileBatch = filesToAnalyze.slice(i, i + CONCURRENT_FILES);
    
    core.info(`Processing batch ${batchNumber} with ${batchSize} files (${i+1}-${i+batchSize} of ${filesToAnalyze.length})`);
    
    const fileCommentsPromises = fileBatch.map(async (file) => {
      const filePath = file.to || file.from || 'unknown';
      
      if (file.to === "/dev/null") {
        core.debug(`Skipping deleted file: ${file.from}`);
        skippedFiles++;
        return [];
      }
      
      // Skip files that are too large
      if (isFileTooLarge(file)) {
        skippedFiles++;
        return [];
      }
      
      try {
        core.info(`\nAnalyzing file: ${filePath}`);
        core.info(`Changes: +${file.additions} -${file.deletions} lines`);
        
        // Use the processFile function to handle each file
        return await processFile(file, prDetails);
      } catch (error) {
        // Log the error but continue processing other files
        erroredFiles++;
        core.warning(`Error processing file ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
        return [];
      }
    });
    
    try {
      const fileComments = await Promise.all(fileCommentsPromises);
      const batchComments = fileComments.flat();
      core.info(`Batch ${batchNumber} complete: Generated ${batchComments.length} comments`);
      comments.push(...batchComments);
    } catch (error) {
      core.warning(`Error processing file batch ${batchNumber}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  
  const duration = (Date.now() - startTime) / 1000;
  core.info(`\nAnalysis complete in ${duration.toFixed(2)} seconds:`);
  core.info(`- Processed files: ${processedFiles}`);
  core.info(`- Skipped files: ${skippedFiles}`);
  core.info(`- Errored files: ${erroredFiles}`);
  core.info(`- Generated comments: ${comments.length}`);
  
  return comments;
}

/**
 * Main function that orchestrates the entire code review process
 * Handles configuration, PR details, diff parsing, code analysis, and comment creation
 */
export async function main() {
  const startTime = Date.now();
  try {
    core.info("=== Starting AI code review ===");
    
    // Provide more detailed model information
    const modelInfo = AI_PROVIDER === 'openai' 
      ? `${OPENAI_API_MODEL}${OPENAI_API_MODEL.startsWith('o3-') ? ' (using max_completion_tokens)' : ' (using max_tokens)'}`
      : ANTHROPIC_API_MODEL;
    
    core.info(`Configuration:
- AI Provider: ${AI_PROVIDER}
- Model: ${modelInfo}
- Max Files: ${MAX_FILES > 0 ? MAX_FILES : 'No limit'}
- Exclude Patterns: ${EXCLUDE_PATTERNS.length > 0 ? EXCLUDE_PATTERNS.join(', ') : 'None'}
- Chunk Size Limits: ${MAX_CHUNK_TOTAL_LINES} lines
- File Size Limits: ${MAX_FILE_TOTAL_LINES} lines`);
    
    // Validate configuration
    validateConfig();
    
    // Get PR details
    core.info("Fetching PR details...");
    const prDetails = await getPRDetails();
    core.info(`Processing PR #${prDetails.pull_number} in ${prDetails.owner}/${prDetails.repo}`);
    core.info(`PR Title: ${prDetails.title}`);
    if (prDetails.description) {
      core.info(`PR Description: ${prDetails.description.slice(0, 100)}${prDetails.description.length > 100 ? '...' : ''}`);
    }
    
    // Get diff
    core.info("Fetching PR diff...");
    const diff = await getDiff(prDetails.owner, prDetails.repo, prDetails.pull_number);
    
    if (!diff) {
      core.info("No diff found or unsupported event");
      return;
    }
    
    // Parse and filter diff
    core.info("Parsing diff...");
    const parsedDiff = parseDiff(diff);
    core.info(`\nFound ${parsedDiff.length} changed files:`);
    parsedDiff.forEach(file => {
      core.info(`- ${file.to || file.from || 'unknown'} (+${file.additions} -${file.deletions})`);
    });
    
    // Summary of file types
    const fileExtensions = new Map<string, number>();
    parsedDiff.forEach(file => {
      const ext = (file.to || "").split('.').pop() || "unknown";
      fileExtensions.set(ext, (fileExtensions.get(ext) || 0) + 1);
    });
    
    core.info("File types breakdown:");
    fileExtensions.forEach((count, ext) => {
      core.info(`- ${ext}: ${count} file(s)`);
    });
    
    // Filter files based on exclude patterns
    const filteredDiff = filterFiles(parsedDiff);
    core.info(`\nAnalyzing ${filteredDiff.length} files after filtering (excluded ${parsedDiff.length - filteredDiff.length})`);
    
    // Analyze code and create comments
    core.info("\n=== Starting code analysis ===");
    const comments = await analyzeCode(filteredDiff, prDetails);
    
    // Create review if there are comments
    if (comments.length > 0) {
      // Group comments by file for better overview
      const commentsByFile = new Map<string, ReviewComment[]>();
      comments.forEach(comment => {
        const file = comment.path;
        if (!commentsByFile.has(file)) {
          commentsByFile.set(file, []);
        }
        commentsByFile.get(file)!.push(comment);
      });
      
      core.info(`\n=== Creating review with ${comments.length} comments ===`);
      core.info("Comments by file:");
      commentsByFile.forEach((fileComments, path) => {
        core.info(`- ${path}: ${fileComments.length} comment(s)`);
      });
      
      comments.forEach(comment => {
        const previewLength = 60;
        const preview = comment.body.length > previewLength ? 
          `${comment.body.slice(0, previewLength)}...` : comment.body;
        core.debug(`- ${comment.path}:${comment.line} - ${preview}`);
      });
      
      core.info("\nSubmitting review to GitHub...");
      await createReviewComment(
        prDetails.owner,
        prDetails.repo,
        prDetails.pull_number,
        comments
      );
      core.info("Review successfully submitted to GitHub");
    } else {
      core.info("\nNo comments to add. All code looks good!");
    }
    
    const duration = (Date.now() - startTime) / 1000;
    core.info(`\n=== AI code review completed successfully in ${duration.toFixed(2)} seconds ===`);
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    core.error(`AI code review failed after ${duration.toFixed(2)} seconds`);
    core.setFailed(`Action failed: ${error instanceof Error ? error.message : String(error)}`);
    
    // Log stack trace for debugging
    if (error instanceof Error && error.stack) {
      core.debug(`Stack trace: ${error.stack}`);
    }
  }
}

// Only run the main function if this file is being run directly
if (require.main === module) {
  main().catch((error) => {
    core.setFailed(`Unhandled error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
