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
	RETRY_DELAY,
	REVIEW_CRITERIA,
} from "../config";
import { withRetry } from "./retry";
import { validateAIResponse, getLanguageFromPath } from "../utils";
import { getCachedReviewResults, cacheReviewResults } from "./cache";

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
export function createPrompt(file: File, chunk: Chunk, prDetails: { title: string; description: string }): string {
	// Determine the file path and language based on the provided file object
	const filePath = file.to || file.from || "unknown";
	const language = getLanguageFromPath(filePath);

	// Log condensed chunk information for debugging purposes
	core.debug(
		`Creating prompt for ${filePath} (${language}): ${chunk.changes.length} changes, newLines=${chunk.newLines}, oldLines=${chunk.oldLines}`
	);

	// Helper function to format each code change
	const formatChange = (change: any): string => {
		// Use nullish coalescing to select the appropriate line number
		const lineNumber = change.ln ?? change.ln2 ?? 0;
		return `${lineNumber}: ${change.content}`;
	};

	// Combine all formatted changes into one string
	const changesStr = chunk.changes.map(formatChange).join("\n");
	
	// Map review criteria to human-readable instructions
	const criteriaToInstructions: Record<string, string> = {
		"code_quality": "Code quality and best practices.",
		"bugs": "Bugs or logical errors.",
		"security": "Security vulnerabilities.",
		"performance": "Performance problems.",
		"maintainability": "Maintainability and readability.",
		"testability": "Test coverage and testability issues.",
		"documentation": "Missing or incorrect documentation.",
		"accessibility": "Accessibility issues.",
		"compatibility": "Browser or device compatibility concerns.",
		"dependencies": "Outdated or unnecessary dependencies.",
		"duplication": "Code duplication or redundancy.",
		"naming": "Naming conventions and clarity.",
		"architecture": "Architectural or design issues.",
		"standards": "Compliance with standards and conventions."
	};
	
	// Generate the focus areas for the review based on configured criteria
	const focusAreas = REVIEW_CRITERIA
		.map((criteria, index) => `${index + 1}. ${criteriaToInstructions[criteria] || criteria}`)
		.join("\n");

	// Define the review instructions as a separate constant for clarity and easier updates
	const reviewInstructions = `Review the code diff for actionable issues only. Focus on:
${focusAreas}

Instructions:
- Provide specific feedback only if issues are detected; otherwise, return an empty JSON array.
- Use GitHub Markdown format and output only JSON inside a code block.
- Use the PR title and description solely as overall context; review only the provided code diff.
- Do not comment on hardcoded values, naming, or configuration entries unless they pose a concrete risk.
- For newly added imports or variables, flag them only if they are unused.
- Always include a concrete code example when suggesting a fix.
- Do not suggest adding inline comments to the code.
- For each issue found, provide a concrete code suggestion with a complete fix when possible.

Return your review only as a JSON array of objects with the following structure:
{
  "reviews": [
    {
      "lineNumber": <line number as integer>,
      "reviewComment": "<your specific, actionable feedback for this line>",
      "severity": "<one of: error, warning, info>",
      "filePath": "${filePath}",
      "suggestion": {
        "code": "<suggested code that fixes the issue>",
        "description": "<brief description of what the fix does>"
      }
    },
    ...
  ]
}

The "suggestion" field is optional but should be included whenever you can provide a specific fix.`;

	// Build and return the complete prompt string using a template literal
	return `Review the following code changes in ${language} file '${filePath}':

${changesStr}

Pull request title: ${prDetails.title}
Pull request description:
---
${prDetails.description}
---

${reviewInstructions}`;
}

/**
 * Gets AI response for a given prompt using the configured AI provider
 * With GitHub Actions cache support
 */
export async function getAIResponse(
	prompt: string,
	chunk?: Chunk,
	prDetails?: { title: string; description: string; owner?: string; repo?: string },
	file?: File
): Promise<AIResponseArray | null> {
	try {
		// Check cache first if we have file and repo info
		if (file && prDetails && prDetails.owner && prDetails.repo && chunk) {
			const repoFullName = `${prDetails.owner}/${prDetails.repo}`;
			const filePath = file.to || file.from || "unknown";

			// Create a string representation of the code chunk for caching
			const codeText = chunk.changes.map((change) => `${change.type}|${change.content}`).join("\n");

			// Try to get cached response
			const cachedResponse = await getCachedReviewResults(repoFullName, filePath, codeText);
			if (cachedResponse) {
				core.info(`Using cached AI response for ${filePath}`);
				return cachedResponse;
			}
		}

		// No cache hit, call the AI API
		core.debug(`Getting AI response using provider: ${AI_PROVIDER}`);

		let response: AIResponseArray | null;
		if (AI_PROVIDER.toLowerCase() === "anthropic") {
			response = await withRetry(() => getAnthropicResponse(prompt));
		} else {
			response = await withRetry(() => getOpenAIResponse(prompt, chunk));
		}

		// Cache the result if we have file and repo info
		if (response && file && prDetails && prDetails.owner && prDetails.repo && chunk) {
			const repoFullName = `${prDetails.owner}/${prDetails.repo}`;
			const filePath = file.to || file.from || "unknown";

			// Create a string representation of the code chunk for caching
			const codeText = chunk.changes.map((change) => `${change.type}|${change.content}`).join("\n");

			await cacheReviewResults(repoFullName, filePath, codeText, response);
		}

		return response;
	} catch (error) {
		core.error(
			`Error getting AI response after ${MAX_RETRIES} attempts: ${error instanceof Error ? error.message : String(error)}`
		);

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
	const isOModel = OPENAI_API_MODEL.startsWith("o");

	// Base configuration for the API request - different for o3 and other models
	const baseConfig = isOModel
		? {
				model: OPENAI_API_MODEL,
				max_completion_tokens: DEFAULT_MAX_TOKENS * 2, // Double the token limit to ensure complete responses
				response_format: { type: "json_object" as const }, // Using const assertion for type safety
			}
		: {
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
		core.debug(
			`Sending request to OpenAI API with model: ${OPENAI_API_MODEL} and ${
				isOModel ? "max_completion_tokens" : "max_tokens"
			}: ${maxTokens}`
		);

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
			() =>
				openai.chat.completions.create({
					...updatedConfig,
					messages: [
						{
							role: "system",
							content:
								"You are a code review assistant. Your job is to analyze code changes and provide specific, actionable feedback. Focus ONLY on substantive issues like bugs, security vulnerabilities, and performance problems. DO NOT make generic observations about hardcoded values or suggest 'verifying' configuration values without specific technical reasons.",
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

		// Minimal logging during normal operation - only log essential details
		core.debug(
			`OpenAI response: model=${response.model}, finish_reason=${response.choices[0]?.finish_reason}, content_length=${
				response.choices[0]?.message?.content?.length || 0
			}`
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
			// In case of error, log more detailed information including content
			core.error(
				`Failed to parse OpenAI response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
			);

			// Log the full response details for debugging when there's an error
			core.debug(
				`Full OpenAI response details: ${JSON.stringify(
					{
						id: response.id,
						object: response.object,
						model: response.model,
						created: response.created,
						choices: response.choices.map((c) => ({
							index: c.index,
							finish_reason: c.finish_reason,
							content_length: c.message?.content?.length || 0,
						})),
					},
					null,
					2
				)}`
			);

			// Log the raw content that failed to parse - only a limited preview in normal logs
			const previewLength = 200;
			core.error(
				`Content preview (${content.length} chars): ${content.substring(0, previewLength)}${
					content.length > previewLength ? "..." : ""
				}`
			);

			// But log full content in debug for troubleshooting
			core.debug(`Full content that failed to parse (${content.length} chars): ${content}`);

			// Attempt to salvage JSON if it's truncated
			try {
				core.debug("Attempting to salvage truncated JSON response...");

				// Log the content length
				core.debug(`Content length: ${content.length} characters`);

				// Try to find the last complete review object without using 's' flag
				const contentNoNewlines = content.replace(/\n/g, " ");
				const lastCompleteReviewMatch = contentNoNewlines.match(/"reviews"\s*:\s*\[\s*(.*?)(\}\s*\]|\}\s*,\s*\{)/);

				if (lastCompleteReviewMatch && lastCompleteReviewMatch[1]) {
					// Create a valid JSON structure with just the first complete review
					const salvaged = `{"reviews":[${lastCompleteReviewMatch[1]}]}`;
					core.debug(`Salvaged JSON attempt: ${salvaged}`);

					const parsedSalvaged = JSON.parse(salvaged);

					if (parsedSalvaged.reviews && parsedSalvaged.reviews.length > 0) {
						core.info(`Salvaged ${parsedSalvaged.reviews.length} reviews from truncated JSON`);

						// Log each salvaged review
						parsedSalvaged.reviews.forEach((review: any, idx: number) => {
							core.debug(`Salvaged review ${idx + 1}: ${JSON.stringify(review)}`);
						});

						return parsedSalvaged.reviews.filter(validateAIResponse);
					}
				}

				// Try another approach - look for complete objects in array
				const objectMatches = content.match(/\{[^{}]*\}/g);
				if (objectMatches && objectMatches.length > 0) {
					core.debug(`Found ${objectMatches.length} potential JSON objects in response`);

					// Try to parse each one
					const validObjects = [];
					for (const objStr of objectMatches) {
						try {
							const obj = JSON.parse(objStr);
							if (obj && typeof obj === "object" && validateAIResponse(obj)) {
								validObjects.push(obj);
							}
						} catch (e) {
							// Ignore parsing errors for individual objects
						}
					}

					if (validObjects.length > 0) {
						core.info(`Salvaged ${validObjects.length} review objects directly from content`);
						return validObjects;
					}
				}
			} catch (salvageError) {
				core.debug(
					`Failed to salvage JSON: ${salvageError instanceof Error ? salvageError.message : String(salvageError)}`
				);
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
		if (ANTHROPIC_API_MODEL.includes("haiku")) {
			maxTokens = 800;
		} else if (ANTHROPIC_API_MODEL.includes("sonnet")) {
			maxTokens = 4096;
		} else if (ANTHROPIC_API_MODEL.includes("opus")) {
			maxTokens = 8192;
		}

		core.debug(`Using max_tokens: ${maxTokens} for Anthropic model: ${ANTHROPIC_API_MODEL}`);

		const response = await withRetry(
			() =>
				anthropic.messages.create({
					model: ANTHROPIC_API_MODEL,
					max_tokens: maxTokens,
					temperature: 0.2,
					system:
						"You are a code review assistant that provides feedback in JSON format. Focus ONLY on substantive issues like bugs, security vulnerabilities, and performance problems. DO NOT make generic observations about hardcoded values or suggest 'verifying' configuration values without specific technical reasons. Always format your response as a valid JSON object with a 'reviews' array.",
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

		// Minimal logging during normal operation
		const contentBlocks = response.content?.filter((block) => block.type === "text") || [];
		const totalLength = contentBlocks.reduce((sum, block) => sum + ("text" in block ? block.text.length : 0), 0);

		core.debug(
			`Anthropic response: model=${response.model}, stop_reason=${response.stop_reason}, content_blocks=${contentBlocks.length}, total_length=${totalLength}`
		);

		// Process the content blocks from the response
		let textContent = "";

		// The content property is an array of content blocks
		if (response.content && Array.isArray(response.content)) {
			// Find text blocks and concatenate their content
			for (const block of response.content) {
				if (block.type === "text" && "text" in block) {
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
			// In case of error, log more detailed information
			core.error(
				`Failed to parse Anthropic response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
			);

			// Log more details about the response in debug when there's an error
			core.debug(
				`Full Anthropic response details: ${JSON.stringify(
					{
						id: response.id,
						model: response.model,
						stop_reason: response.stop_reason,
						stop_sequence: response.stop_sequence,
						usage: response.usage,
						content_blocks: response.content?.length || 0,
					},
					null,
					2
				)}`
			);

			// Log content preview in error logs
			const previewLength = 200;
			core.error(
				`Content preview (${textContent.length} chars): ${textContent.substring(0, previewLength)}${
					textContent.length > previewLength ? "..." : ""
				}`
			);

			// Full content in debug logs
			core.debug(`Full content that failed to parse (${textContent.length} chars): ${textContent}`);

			return null;
		}
	} catch (error) {
		core.error(`Anthropic API error: ${error instanceof Error ? error.message : String(error)}`);

		// Log additional error details for debugging
		if (error instanceof Error) {
			const errorObj = error as any;
			if (errorObj.response) {
				core.error(`API Response Status: ${errorObj.response.status}`);
				core.debug(`API Response Headers: ${JSON.stringify(errorObj.response.headers || {})}`);
				core.debug(`API Response Data: ${JSON.stringify(errorObj.response.data || {}, null, 2)}`);
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
		core.debug(`Cannot create comment: File path is missing in the diff`);
		return null;
	}

	// Validate AI response
	if (!aiResponse || typeof aiResponse !== "object") {
		core.error(`Invalid AI response format: ${JSON.stringify(aiResponse)}`);
		return null;
	}

	// Validate the line number is within the chunk's range
	const lineNumber = Number(aiResponse.lineNumber);
	if (isNaN(lineNumber)) {
		core.error(`Invalid line number format in AI response: ${aiResponse.lineNumber}`);
		core.debug(`Full AI response: ${JSON.stringify(aiResponse, null, 2)}`);
		return null;
	}

	// Check if line number is outside chunk range
	if (lineNumber < chunk.newStart || lineNumber > chunk.newStart + chunk.newLines - 1) {
		core.warning(`Invalid line number ${lineNumber} for chunk starting at ${chunk.newStart}`);
		core.debug(
			`Chunk details: start=${chunk.newStart}, lines=${chunk.newLines}, end=${chunk.newStart + chunk.newLines - 1}`
		);
		core.debug(`Full AI response: ${JSON.stringify(aiResponse, null, 2)}`);

		// FOR SALVAGING INVALID LINE COMMENTS: Adjust the line number to fit within the chunk range
		// Instead of discarding, fix the line number to be within the valid range
		const adjustedLineNumber = Math.min(Math.max(lineNumber, chunk.newStart), chunk.newStart + chunk.newLines - 1);

		core.info(`Adjusting line number from ${lineNumber} to ${adjustedLineNumber} to fit within valid range`);

		// Format the comment body to properly handle code suggestions
		let formattedComment = `**Note: This comment was originally for line ${lineNumber} but was adjusted to fit in the viewable diff.**\n\n${aiResponse.reviewComment}`;
        
		// Determine the appropriate emoji based on severity
		let emoji = "💬";
		if (aiResponse.severity === "error") {
			emoji = "⛔";
		} else if (aiResponse.severity === "warning") {
			emoji = "⚠️";
		} else if (aiResponse.severity === "info") {
			emoji = "ℹ️";
		}
		
		// Add severity prefix
		formattedComment = `${emoji} **${aiResponse.severity.toUpperCase()}**\n\n${formattedComment}`;
		
		// Add suggestion if available
		if (aiResponse.suggestion && aiResponse.suggestion.code) {
			formattedComment += `\n\n**Suggested Fix**:\n${aiResponse.suggestion.description}\n\`\`\`suggestion\n${aiResponse.suggestion.code}\n\`\`\``;
		}

		// If the comment contains code blocks, format them properly
		const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
		if (codeBlockRegex.test(formattedComment)) {
			// Replace code blocks with properly formatted ones (except suggestion blocks)
			formattedComment = formattedComment.replace(codeBlockRegex, (match, lang, code) => {
				if (match.includes("```suggestion")) {
					return match; // Leave suggestion blocks unchanged
				}
				// If no language is specified, try to detect it from the file extension
				const language = lang || getLanguageFromPath(file.to || "").toLowerCase();
				return `\`\`\`${language}\n${code.trim()}\n\`\`\``;
			});
		}

		// Create adjusted comment
		return {
			path: file.to,
			line: adjustedLineNumber,
			body: formattedComment,
			side: "RIGHT" as const,
		};
	}

	// Format the comment with emoji and severity
	let emoji = "💬";
	if (aiResponse.severity === "error") {
		emoji = "⛔";
	} else if (aiResponse.severity === "warning") {
		emoji = "⚠️";
	} else if (aiResponse.severity === "info") {
		emoji = "ℹ️";
	}
	
	// Format the comment body
	let formattedComment = `${emoji} **${aiResponse.severity.toUpperCase()}**\n\n${aiResponse.reviewComment}`;
	
	// Add suggestion if available
	if (aiResponse.suggestion && aiResponse.suggestion.code) {
		formattedComment += `\n\n**Suggested Fix**:\n${aiResponse.suggestion.description}\n\`\`\`suggestion\n${aiResponse.suggestion.code}\n\`\`\``;
	}

	// If the comment contains code blocks, format them properly
	const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
	if (codeBlockRegex.test(formattedComment)) {
		// Replace code blocks with properly formatted ones (except suggestion blocks)
		formattedComment = formattedComment.replace(codeBlockRegex, (match, lang, code) => {
			if (match.includes("```suggestion")) {
				return match; // Leave suggestion blocks unchanged
			}
			// If no language is specified, try to detect it from the file extension
			const language = lang || getLanguageFromPath(file.to || "").toLowerCase();
			return `\`\`\`${language}\n${code.trim()}\n\`\`\``;
		});
	}

	// Create the comment
	return {
		path: file.to,
		line: lineNumber,
		body: formattedComment,
		side: "RIGHT" as const, // We always comment on the new version
	};
}

/**
 * Generates a comprehensive summary of all review comments for a pull request
 * @param allComments Array of all generated review comments across files
 * @param prDetails Pull request details
 * @returns A formatted markdown summary
 */
export async function generateReviewSummary(
	allComments: ReviewComment[],
	prDetails: { title: string; description: string }
): Promise<string> {
	// Skip if no comments
	if (allComments.length === 0) {
		return "No issues found in this pull request.";
	}

	// Create a summary prompt
	const fileCommentMap = new Map<string, ReviewComment[]>();
	
	// Group comments by file
	allComments.forEach(comment => {
		if (!fileCommentMap.has(comment.path)) {
			fileCommentMap.set(comment.path, []);
		}
		fileCommentMap.get(comment.path)?.push(comment);
	});
	
	// Format comment data for the prompt
	const commentSummaries = [];
	for (const [file, comments] of fileCommentMap.entries()) {
		commentSummaries.push(`File: ${file}\nIssues: ${comments.length}\n${comments.map(c => `- Line ${c.line}: ${c.body.split('\n')[0]}`).join('\n')}`);
	}
	
	const prompt = `Generate a concise but insightful summary of the following code review comments for a pull request.
	
Title: ${prDetails.title}
Description: ${prDetails.description}

Review comments by file:
${commentSummaries.join('\n\n')}

Provide a summary that includes:
1. A brief overview of the main categories of issues found
2. The most critical issues that should be addressed
3. Any patterns or recurring problems
4. Actionable recommendations for the developer

Format the response as Markdown with appropriate sections and bullet points.`;

	try {
		let summaryResponse;
		if (AI_PROVIDER.toLowerCase() === "anthropic") {
			const response = await anthropic.messages.create({
				model: ANTHROPIC_API_MODEL,
				max_tokens: 1000,
				temperature: 0.2,
				system: "You are an expert code reviewer summarizing pull request feedback.",
				messages: [{ role: "user", content: prompt }],
			});
			summaryResponse = response.content[0].type === "text" 
			  ? response.content[0].text 
			  : "Failed to get text response from Anthropic";
		} else {
			const isOModel = OPENAI_API_MODEL.startsWith("o");
			const response = await openai.chat.completions.create({
				model: OPENAI_API_MODEL,
				messages: [
					{ role: "system", content: "You are an expert code reviewer summarizing pull request feedback." },
					{ role: "user", content: prompt }
				],
				temperature: 0.2,
				...(isOModel 
					? { max_completion_tokens: 1000 } 
					: { max_tokens: 1000 })
			});
			summaryResponse = response.choices[0].message.content || "";
		}
		
		return summaryResponse;
	} catch (error) {
		core.warning(`Failed to generate review summary: ${error instanceof Error ? error.message : String(error)}`);
		// Fallback to simple summary
		return `## Code Review Summary\n\nFound ${allComments.length} issues across ${fileCommentMap.size} files.`;
	}
}
