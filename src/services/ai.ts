import * as core from "@actions/core";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { Chunk, File } from "parse-diff";
import { AIReviewResponse, AIResponseArray, ReviewComment } from "../types";
import { 
  AI_PROVIDER, 
  OPENAI_API_KEY, 
  OPENAI_API_MODEL, 
  ANTHROPIC_API_KEY, 
  ANTHROPIC_API_MODEL,
  DEFAULT_MAX_TOKENS,
  MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS,
  TOKEN_MULTIPLIER,
  MAX_RETRIES,
  RETRY_DELAY
} from "../config";
import { withRetry } from "./retry";
import { validateAIResponse, getLanguageFromPath } from "../utils";

// Initialize AI clients
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

/**
 * Creates a prompt for the AI based on the file and chunk
 */
export function createPrompt(file: File, chunk: Chunk, prDetails: { title: string, description: string }): string {
  const filePath = file.to || file.from || 'unknown';
  const language = getLanguageFromPath(filePath);
  
  // Create a context-aware prompt
  const prompt = `Review the following code changes in ${language} file '${filePath}':

${chunk.changes
	.map((change) => {
		const lineNumber = "ln" in change ? change.ln : "ln2" in change ? change.ln2 : 0;
		return `${lineNumber}: ${change.content}`;
	})
	.join("\n")} and take the pull request title and description into account when writing the response.
  
Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Analyze the code for SUBSTANTIVE issues related to:
1. Code quality and best practices 
2. Potential bugs or logical errors
3. Security vulnerabilities
4. Performance optimizations
5. Maintainability and readability

IMPORTANT: Focus ONLY on specific, actionable issues. DO NOT make generic observations about hardcoded values, presence of identifiers, or configuration entries unless they represent a concrete security risk or bug.
DO NOT suggest "verifying" or "ensuring" values without specific technical reasons.
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
- IMPORTANT: Remember that you're only seeing a portion of the file and your knowledge of the codebase is limited to what's shown in this diff.

Provide your code review feedback in JSON format with the following structure:
{
  "reviews": [
    {
      "lineNumber": <line number as integer>,
      "reviewComment": "<your specific, actionable feedback for this line>",
      "severity": "<one of: error, warning, info>",
      "filePath": "${filePath}"
    },
    ...
  ]
}`;

  return prompt;
}

/**
 * Gets AI response for a given prompt using the configured AI provider
 */
export async function getAIResponse(prompt: string, chunk?: Chunk, prDetails?: { title: string, description: string }): Promise<AIResponseArray | null> {
  try {
    core.debug(`Getting AI response using provider: ${AI_PROVIDER}`);
    
    if (AI_PROVIDER.toLowerCase() === "anthropic") {
      return await withRetry(() => getAnthropicResponse(prompt));
    } else {
      return await withRetry(() => getOpenAIResponse(prompt, chunk));
    }
  } catch (error) {
    core.error(`Error getting AI response after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`);
    
    // Log more detailed error information
    if (error instanceof Error && error.stack) {
      core.debug(`Error stack trace: ${error.stack}`);
    }
    
    return null;
  }
}

/**
 * Gets response from OpenAI API with enhanced error handling and validation
 */
async function getOpenAIResponse(prompt: string, chunk?: Chunk): Promise<AIResponseArray | null> {
  // Check if using o3 model family and adjust parameters accordingly
  const isOModel = OPENAI_API_MODEL.startsWith('o');
  
  // Base configuration for the API request - different for o3 and other models
  const baseConfig = isOModel ? {
    model: OPENAI_API_MODEL,
    max_completion_tokens: DEFAULT_MAX_TOKENS * 2, // Double the token limit to ensure complete responses
    response_format: { type: "json_object" as const }, // Using const assertion for type safety
  } : {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: DEFAULT_MAX_TOKENS * 2, // Double the token limit to ensure complete responses
  };

  // Adjust tokens based on chunk size
  let maxTokens = DEFAULT_MAX_TOKENS;
  if (chunk) {
    const totalLines = chunk.newLines + chunk.oldLines;
    if (totalLines > MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS) {
      maxTokens = DEFAULT_MAX_TOKENS * TOKEN_MULTIPLIER;
    }
  }

  try {
    core.debug(`Sending request to OpenAI API with model: ${OPENAI_API_MODEL} and ${isOModel ? 'max_completion_tokens' : 'max_tokens'}: ${maxTokens}`);
    
    const updatedConfig = { ...baseConfig };
    // Set the appropriate token parameter based on model
    if (isOModel) {
      updatedConfig.max_completion_tokens = maxTokens;
    } else {
      updatedConfig.max_tokens = maxTokens;
      updatedConfig.temperature = 0.2;
    }
    
    core.debug(`Final OpenAI config: ${JSON.stringify(updatedConfig)}`);
    
    const response = await withRetry(
      () => openai.chat.completions.create({
        ...updatedConfig,
        messages: [
          {
            role: "system",
            content: "You are a code review assistant. Your job is to analyze code changes and provide specific, actionable feedback. Focus ONLY on substantive issues like bugs, security vulnerabilities, and performance problems. DO NOT make generic observations about hardcoded values or suggest 'verifying' configuration values without specific technical reasons.",
          },
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "openai-api"
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
      core.error(`Failed to parse OpenAI response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      
      // Attempt to salvage JSON if it's truncated
      try {
        core.debug("Attempting to salvage truncated JSON response...");
        // Try to find the last complete review object without using 's' flag
        const contentNoNewlines = content.replace(/\n/g, ' ');
        const lastCompleteReviewMatch = contentNoNewlines.match(/"reviews"\s*:\s*\[\s*(.*?)(\}\s*\]|\}\s*,\s*\{)/);
        
        if (lastCompleteReviewMatch && lastCompleteReviewMatch[1]) {
          // Create a valid JSON structure with just the first complete review
          const salvaged = `{"reviews":[${lastCompleteReviewMatch[1]}]}`;
          const parsedSalvaged = JSON.parse(salvaged);
          
          if (parsedSalvaged.reviews && parsedSalvaged.reviews.length > 0) {
            core.info(`Salvaged ${parsedSalvaged.reviews.length} reviews from truncated JSON`);
            return parsedSalvaged.reviews.filter(validateAIResponse);
          }
        }
      } catch (salvageError) {
        core.debug(`Failed to salvage JSON: ${salvageError instanceof Error ? salvageError.message : String(salvageError)}`);
      }
      
      return null;
    }
  } catch (error) {
    core.error(`OpenAI API error: ${error instanceof Error ? error.message : String(error)}`);
    
    // Log additional error details for debugging
    if (error instanceof Error) {
      const errorObj = error as any;
      if (errorObj.response) {
        core.error(`API Response Status: ${errorObj.response.status}`);
        core.error(`API Response Data: ${JSON.stringify(errorObj.response.data || {})}`);
      }
      if (errorObj.stack) {
        core.debug(`Error Stack: ${errorObj.stack}`);
      }
    }
    
    return null;
  }
}

/**
 * Gets response from Anthropic API with enhanced error handling and validation
 */
async function getAnthropicResponse(prompt: string): Promise<AIResponseArray | null> {
  try {
    core.debug(`Sending request to Anthropic API with model: ${ANTHROPIC_API_MODEL}`);
    
    // Adjust max tokens based on model
    let maxTokens = 1024;
    if (ANTHROPIC_API_MODEL.includes('haiku')) {
      maxTokens = 800;
    } else if (ANTHROPIC_API_MODEL.includes('sonnet')) {
      maxTokens = 4096;
    } else if (ANTHROPIC_API_MODEL.includes('opus')) {
      maxTokens = 8192;
    }
    
    core.debug(`Using max_tokens: ${maxTokens} for Anthropic model: ${ANTHROPIC_API_MODEL}`);
    
    const response = await withRetry(
      () => anthropic.messages.create({
        model: ANTHROPIC_API_MODEL,
        max_tokens: maxTokens,
        temperature: 0.2,
        system: "You are a code review assistant that provides feedback in JSON format. Focus ONLY on substantive issues like bugs, security vulnerabilities, and performance problems. DO NOT make generic observations about hardcoded values or suggest 'verifying' configuration values without specific technical reasons. Always format your response as a valid JSON object with a 'reviews' array.",
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
      MAX_RETRIES,
      RETRY_DELAY,
      "anthropic-api"
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
      const parsedResponse = JSON.parse(textContent);
      const reviews = parsedResponse.reviews || [];
      
      // Validate each review
      const validReviews = reviews.filter(validateAIResponse);
      if (validReviews.length !== reviews.length) {
        core.warning(`Filtered out ${reviews.length - validReviews.length} invalid reviews`);
      }
      
      return validReviews;
    } catch (parseError) {
      core.error(`Failed to parse Anthropic response: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      return null;
    }
  } catch (error) {
    core.error(`Anthropic API error: ${error instanceof Error ? error.message : String(error)}`);
    
    // Log additional error details for debugging
    if (error instanceof Error) {
      const errorObj = error as any;
      if (errorObj.response) {
        core.error(`API Response Status: ${errorObj.response.status}`);
        core.error(`API Response Data: ${JSON.stringify(errorObj.response.data || {})}`);
      }
      if (errorObj.status) {
        core.error(`API Status: ${errorObj.status}`);
      }
      if (errorObj.stack) {
        core.debug(`Error Stack: ${errorObj.stack}`);
      }
    }
    
    return null;
  }
}

/**
 * Creates a review comment from an AI response
 */
export function createComment(file: File, chunk: Chunk, aiResponse: AIReviewResponse): ReviewComment | null {
  if (!file.to) {
    return null;
  }

  // Validate the line number is within the chunk's range
  const lineNumber = Number(aiResponse.lineNumber);
  if (isNaN(lineNumber) || lineNumber < chunk.newStart || lineNumber > chunk.newStart + chunk.newLines - 1) {
    core.warning(`Invalid line number ${lineNumber} for chunk starting at ${chunk.newStart}`);
    return null;
  }

  // Format the comment body to properly handle code suggestions
  let formattedComment = aiResponse.reviewComment;
  
  // If the comment contains code suggestions, format them properly
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  if (codeBlockRegex.test(formattedComment)) {
    // Replace code blocks with properly formatted ones
    formattedComment = formattedComment.replace(codeBlockRegex, (match, lang, code) => {
      // If no language is specified, try to detect it from the file extension
      const language = lang || getLanguageFromPath(file.to || '').toLowerCase();
      return `\`\`\`${language}\n${code.trim()}\n\`\`\``;
    });
  }

  // Create the comment
  return {
    path: file.to,
    line: lineNumber,
    body: formattedComment,
    side: 'RIGHT' as const // We always comment on the new version
  };
} 