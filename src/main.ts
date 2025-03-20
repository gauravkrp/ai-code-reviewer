import * as core from "@actions/core";
import parseDiff, { File, Chunk, Change } from "parse-diff";
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
import { readFileSync } from "fs";

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
  
  // Improve chunk merging strategy to handle line number context better
  const mergedChunks: Chunk[] = [];
  let currentChunk: Chunk | null = null;
  
  // First, analyze the full file chunk distribution
  const chunkDistribution = file.chunks.map(chunk => ({
    start: chunk.newStart,
    end: chunk.newStart + chunk.newLines - 1,
    lines: chunk.newLines + chunk.oldLines,
    chunk
  }));
  
  core.debug(`Chunk distribution in file: ${JSON.stringify(chunkDistribution.map(c => 
    ({ start: c.start, end: c.end, lines: c.lines })))}`);
  
  // Check for large gaps between chunks
  const hasLargeGaps = chunkDistribution.some((chunk, idx) => {
    if (idx === 0) return false;
    const prevChunk = chunkDistribution[idx - 1];
    const gap = chunk.start - (prevChunk.end + 1);
    return gap > 100; // Consider gaps > 100 lines to be large
  });
  
  if (hasLargeGaps) {
    core.info(`File ${filePath} has large gaps between chunks, using cautious merging strategy`);
  }
  
  // Merge chunks with better context awareness
  for (let i = 0; i < file.chunks.length; i++) {
    const chunk = file.chunks[i];
    
    if (!currentChunk) {
      currentChunk = { ...chunk };
      continue;
    }
    
    const currentEnd = currentChunk.newStart + currentChunk.newLines - 1;
    const nextStart = chunk.newStart;
    const gap = nextStart - (currentEnd + 1);
    
    // Decide whether to merge based on several factors
    const currentTotalLines = currentChunk.newLines + currentChunk.oldLines;
    const nextTotalLines = chunk.newLines + chunk.oldLines;
    const mergedWouldBeTooLarge = (currentTotalLines + nextTotalLines) > MAX_CHUNK_TOTAL_LINES * 0.8;
    const gapIsTooLarge = gap > 50; // Don't merge chunks with more than 50 lines between them
    
    if (!mergedWouldBeTooLarge && !gapIsTooLarge) {
      // Calculate virtual lines for the gap
      const virtualGapChanges: Change[] = [];
      
      // Only add virtual context lines if there is an actual gap
      if (gap > 0) {
        // Add up to 5 context lines to help with continuity
        const contextLines = Math.min(gap, 5);
        for (let j = 0; j < contextLines; j++) {
          virtualGapChanges.push({
            type: 'normal',
            content: `// Context line ${j+1} of ${contextLines}`,
            normal: true
          } as Change);
        }
      }
      
      // Merge the chunks with any virtual context
      currentChunk.newLines = (chunk.newStart + chunk.newLines) - currentChunk.newStart;
      currentChunk.oldLines += chunk.oldLines;
      currentChunk.changes = [
        ...currentChunk.changes,
        ...virtualGapChanges,
        ...chunk.changes
      ];
    } else {
      // Don't merge - add current chunk and start a new one
      mergedChunks.push(currentChunk);
      currentChunk = { ...chunk };
      
      if (mergedWouldBeTooLarge) {
        core.debug(`Not merging chunks: combined size would exceed threshold (${currentTotalLines + nextTotalLines} lines)`);
      }
      if (gapIsTooLarge) {
        core.debug(`Not merging chunks: gap too large (${gap} lines between chunks)`);
      }
    }
  }
  
  // Add the last chunk if it exists
  if (currentChunk) {
    mergedChunks.push(currentChunk);
  }
  
  core.debug(`Merged ${file.chunks.length} chunks into ${mergedChunks.length} chunks for file ${filePath}`);
  
  // Log the merged chunk distribution for debugging
  mergedChunks.forEach((chunk, idx) => {
    core.debug(`Merged chunk #${idx+1}: lines ${chunk.newStart}-${chunk.newStart + chunk.newLines - 1} (${chunk.newLines + chunk.oldLines} total lines)`);
  });
  
  for (let i = 0; i < mergedChunks.length; i++) {
    const chunk = mergedChunks[i];
    core.debug(`Processing chunk ${i+1}/${mergedChunks.length}: lines ${chunk.newStart}-${chunk.newStart + chunk.newLines - 1}`);
    
    // Log more details about chunk content
    core.debug(`Chunk content preview: ${JSON.stringify(chunk.changes.slice(0, 3))}`);
    
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
    
    // Log prompt summary instead of full content
    const promptPreview = prompt.length > 100 
      ? prompt.substring(0, 100) + `... (total length: ${prompt.length} chars)`
      : prompt;
    core.debug(`Prompt preview for chunk ${i+1}: ${promptPreview}`);
    
    // Get AI response
    core.debug(`Sending chunk ${i+1} to AI for review`);
    const aiResponses = await getAIResponse(prompt, chunk, prDetails);
    
    if (!aiResponses || aiResponses.length === 0) {
      core.debug(`No AI review comments generated for chunk ${i+1} in ${filePath}`);
      continue;
    }

    core.info(`Received ${aiResponses.length} comments from AI for chunk ${i+1} in ${filePath}`);
    
    // Log some details about the AI responses for debugging
    if (aiResponses.length > 0) {
      core.debug(`AI response preview: ${JSON.stringify(aiResponses.slice(0, 1))}`);
      
      // Check for potentially problematic line numbers ahead of time
      const invalidLineNums = aiResponses.filter(r => {
        const lineNumber = Number(r.lineNumber);
        return isNaN(lineNumber) || lineNumber < chunk.newStart || lineNumber > chunk.newStart + chunk.newLines - 1;
      });
      
      if (invalidLineNums.length > 0) {
        core.warning(`Found ${invalidLineNums.length} responses with potentially invalid line numbers`);
        core.debug(`First invalid response: ${JSON.stringify(invalidLineNums[0])}`);
        core.debug(`Chunk range: ${chunk.newStart} to ${chunk.newStart + chunk.newLines - 1}`);
      }
    }
    
    // Process each AI response and create comments
    for (const response of aiResponses) {
      const comment = createComment(file, chunk, response);
      
      if (comment !== null) {
        core.debug(`Added comment at line ${comment.line} in ${comment.path}`);
        comments.push(comment);
      } else {
        core.error(`Failed to create comment for line ${response.lineNumber} in ${file.to}`);
        core.debug(`Response that failed: ${JSON.stringify(response)}`);
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
    
    // Add log file path for debugging
    if (process.env.RUNNER_DEBUG === '1') {
      core.info(`Debug mode enabled - full logs will be captured`);
    }
    
    // Validate configuration
    validateConfig();
    
    // Get PR details
    core.info("Fetching event details...");
    const prDetails = await getPRDetails();
    
    if (prDetails.eventType === 'pull_request') {
      core.info(`Processing PR #${prDetails.pull_number} in ${prDetails.owner}/${prDetails.repo}`);
      core.info(`PR Title: ${prDetails.title}`);
      if (prDetails.description) {
        core.info(`PR Description: ${prDetails.description.slice(0, 100)}${prDetails.description.length > 100 ? '...' : ''}`);
      }
    } else if (prDetails.eventType === 'push') {
      core.info(`Processing push to branch "${prDetails.ref}" in ${prDetails.owner}/${prDetails.repo}`);
      
      // If the title and description weren't populated yet, get them from the commit data
      if (prDetails.title === "Push event") {
        // Get the event data to extract commit information
        const eventPath = process.env.GITHUB_EVENT_PATH;
        if (eventPath) {
          const eventData = JSON.parse(readFileSync(eventPath, "utf8"));
          const commits = eventData.commits || [];
          
          core.info(`Commits: ${commits.length}`);
          
          // Use the commit messages for context
          if (commits.length > 0) {
            const latestCommit = commits[0];
            prDetails.title = latestCommit.message || 'Push event';
            
            // Create a description from commit messages
            prDetails.description = commits.map((commit: any, idx: number) => 
              `${idx+1}. ${commit.message || 'No message'} (${commit.id.substring(0, 7)})`
            ).join('\n');
            
            core.info(`Latest commit: ${latestCommit.message || 'No message'}`);
            core.debug(`Using commit messages as context: ${prDetails.description}`);
          }
        }
      }
    } else {
      core.info(`Processing ${prDetails.eventType || 'unknown'} event for ${prDetails.owner}/${prDetails.repo}`);
      core.info(`Event Title: ${prDetails.title}`);
    }
    
    // Get diff
    core.info("Fetching diff...");
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
    
    // Create review with comments
    if (comments.length > 0) {
      core.info(`\n=== Creating review with ${comments.length} comments ===`);
      
      // Log comments by file
      const commentsByFile = new Map<string, number>();
      for (const comment of comments) {
        const count = commentsByFile.get(comment.path) || 0;
        commentsByFile.set(comment.path, count + 1);
      }
      
      core.info("Comments by file:");
      for (const [file, count] of commentsByFile.entries()) {
        core.info(`- ${file}: ${count} comment(s)`);
      }
      
      // For push events, we can't create PR reviews, so we'll just log the comments
      if (prDetails.eventType === 'push') {
        core.info(`\nThis is a push event, so we'll log comments instead of creating a GitHub review`);
        
        // Log the comments in a readable format
        for (const comment of comments) {
          core.info(`\n${comment.path}:${comment.line} - ${comment.body.split('\n')[0]}...`);
        }
        
        const duration = (Date.now() - startTime) / 1000;
        core.info(`\n=== AI code review completed successfully in ${duration.toFixed(2)} seconds ===`);
        core.info(`Found ${comments.length} issues in ${filteredDiff.length} files`);
        
        return;
      }
      
      // For PR events, create the review in GitHub
      try {
        core.info("Submitting review to GitHub...");
        await createReviewComment(prDetails.owner, prDetails.repo, prDetails.pull_number, comments);
        core.info("Review successfully submitted to GitHub");
      } catch (error) {
        // If creating the review fails, log the error but don't fail the action
        core.error(`Failed to create review: ${error instanceof Error ? error.message : String(error)}`);
        
        // Log the comments so they're not lost
        core.info("\nHere are the comments that couldn't be submitted:");
        for (const comment of comments) {
          core.info(`\n${comment.path}:${comment.line} - ${comment.body.split('\n')[0]}...`);
        }
      }
    } else {
      core.info("No review comments to create");
    }
    
    const duration = (Date.now() - startTime) / 1000;
    core.info(`\n=== AI code review completed successfully in ${duration.toFixed(2)} seconds ===`);
  } catch (error) {
    const duration = (Date.now() - startTime) / 1000;
    core.error(`AI code review failed after ${duration.toFixed(2)} seconds`);
    
    // Enhanced error logging
    if (error instanceof Error) {
      core.setFailed(`Action failed: ${error.message}`);
      // Log complete error details for debugging
      core.debug(`Error name: ${error.name}`);
      core.debug(`Error message: ${error.message}`);
      
      if (error.stack) {
        core.debug(`Stack trace: ${error.stack}`);
      }
      
      // Log additional error properties
      const errorObj = error as any;
      if (errorObj.response) {
        core.debug(`API Response Status: ${errorObj.response.status}`);
        core.debug(`API Response Headers: ${JSON.stringify(errorObj.response.headers || {})}`);
        core.debug(`API Response Data: ${JSON.stringify(errorObj.response.data || {}, null, 2)}`);
      }
      
      // If there's a cause, log it too
      if (errorObj.cause) {
        core.debug(`Error cause: ${JSON.stringify(errorObj.cause, null, 2)}`);
      }
    } else {
      core.setFailed(`Action failed: ${String(error)}`);
      core.debug(`Full error object: ${JSON.stringify(error, null, 2)}`);
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
