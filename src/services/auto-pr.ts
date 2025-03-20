import * as core from "@actions/core";
import { Octokit } from "@octokit/rest";
import { ReviewComment } from "../types";
import { GITHUB_TOKEN } from "../config";

// Initialize GitHub client
const octokit = new Octokit({ auth: GITHUB_TOKEN });

/**
 * Creates a pull request with suggested fixes
 * @param owner Repository owner
 * @param repo Repository name 
 * @param baseBranch Base branch (usually the PR branch)
 * @param comments Review comments containing suggestions
 * @returns PR number if successful, null otherwise
 */
export async function createFixPR(
  owner: string,
  repo: string,
  baseBranch: string,
  prNumber: number,
  comments: ReviewComment[]
): Promise<number | null> {
  try {
    // Extract only comments with suggestions
    const suggestionComments = comments.filter(comment => 
      comment.body.includes("```suggestion")
    );
    
    if (suggestionComments.length === 0) {
      core.info("No suggestions to apply - skipping fix PR creation");
      return null;
    }
    
    // Create a new branch for the fixes
    const fixBranchName = `auto-fix-pr-${prNumber}-${Date.now()}`;
    const newBranchRef = `refs/heads/${fixBranchName}`;
    
    // Get the base branch ref to use as starting point
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${baseBranch}`
    });
    
    // Create the new branch
    await octokit.git.createRef({
      owner,
      repo,
      ref: newBranchRef,
      sha: refData.object.sha
    });
    
    core.info(`Created fix branch: ${fixBranchName} from ${baseBranch}`);
    
    // Apply each suggestion to files
    const fileChanges = new Map<string, { content: string, message: string[] }>();
    
    for (const comment of suggestionComments) {
      await applyFix(owner, repo, baseBranch, fixBranchName, comment, fileChanges);
    }
    
    // Commit the changes
    for (const [filePath, change] of fileChanges.entries()) {
      const message = change.message.length > 1 
        ? `Apply ${change.message.length} suggestions to ${filePath}` 
        : change.message[0];
        
      await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filePath,
        message,
        content: Buffer.from(change.content).toString('base64'),
        branch: fixBranchName
      });
      
      core.info(`Updated file ${filePath} in branch ${fixBranchName}`);
    }
    
    // Create a pull request with all the fixes
    const { data: pullRequest } = await octokit.pulls.create({
      owner,
      repo,
      title: `🤖 Auto-fixes for PR #${prNumber}`,
      body: `This PR applies suggested fixes from the AI code review for PR #${prNumber}.
      
## Applied Fixes:
${Array.from(fileChanges.entries()).map(([file, change]) => 
  `- ${file}: ${change.message.join(', ')}`
).join('\n')}`,
      head: fixBranchName,
      base: baseBranch
    });
    
    core.info(`Created fix PR #${pullRequest.number}: ${pullRequest.html_url}`);
    
    return pullRequest.number;
  } catch (error) {
    core.error(`Failed to create fix PR: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Extracts and applies a suggestion to a file
 */
async function applyFix(
  owner: string,
  repo: string,
  baseBranch: string,
  fixBranch: string,
  comment: ReviewComment,
  fileChanges: Map<string, { content: string, message: string[] }>
): Promise<void> {
  try {
    const filePath = comment.path;
    
    // Extract the suggestion code from the comment
    const suggestionMatch = comment.body.match(/```suggestion\s*([\s\S]*?)\s*```/);
    if (!suggestionMatch) {
      core.debug(`No valid suggestion found in comment for ${filePath}:${comment.line}`);
      return;
    }
    
    const suggestionCode = suggestionMatch[1];
    
    // Get the file content
    let fileContent: string;
    
    if (fileChanges.has(filePath)) {
      // Use already modified content if we've already changed this file
      fileContent = fileChanges.get(filePath)!.content;
    } else {
      // Get content from GitHub - use the base branch, not the fix branch,
      // since we're getting the original file to modify
      const { data } = await octokit.repos.getContent({
        owner,
        repo,
        path: filePath,
        ref: baseBranch // This is correct - we want the original file from the base branch
      });
      
      if (Array.isArray(data) || !('content' in data)) {
        throw new Error(`${filePath} is a directory or doesn't have content`);
      }
      
      fileContent = Buffer.from(data.content, 'base64').toString();
    }
    
    // Split the file content into lines
    const lines = fileContent.split('\n');
    
    // Apply the suggestion at the specified line
    if (comment.line > 0 && comment.line <= lines.length) {
      lines[comment.line - 1] = suggestionCode;
    } else {
      core.warning(`Line ${comment.line} is out of bounds for file ${filePath}`);
      return;
    }
    
    // Recreate the file content
    const newContent = lines.join('\n');
    
    // Extract the description from the comment for the commit message
    let description = "Apply suggestion";
    const descMatch = comment.body.match(/\*\*Suggested Fix\*\*:\s*(.*?)\n/);
    if (descMatch) {
      description = descMatch[1].trim();
    }
    
    // Save the changes to be committed later
    if (fileChanges.has(filePath)) {
      fileChanges.get(filePath)!.content = newContent;
      fileChanges.get(filePath)!.message.push(description);
    } else {
      fileChanges.set(filePath, { 
        content: newContent, 
        message: [description]
      });
    }
    
    core.debug(`Applied suggestion to ${filePath}:${comment.line}`);
  } catch (error) {
    core.warning(`Failed to apply fix to ${comment.path}:${comment.line}: ${error instanceof Error ? error.message : String(error)}`);
  }
} 