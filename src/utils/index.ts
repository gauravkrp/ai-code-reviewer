import * as core from "@actions/core";
import { Chunk, File } from "parse-diff";
import { MAX_CHUNK_TOTAL_LINES, MAX_FILE_TOTAL_LINES, LANGUAGE_MAP } from "../config";
import { AIReviewResponse } from "../types";

/**
 * Helper function to delay execution
 */
export function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely validates a file is within size limits
 */
export function isFileTooLarge(file: File): boolean {
	const totalLines = file.additions + file.deletions;
	if (totalLines > MAX_FILE_TOTAL_LINES) {
		core.warning(`Skipping file ${file.to}: Too large (${totalLines} lines)`);
		return true;
	}
	return false;
}

/**
 * Safely validates a chunk is within size limits
 */
export function isChunkTooLarge(chunk: Chunk): boolean {
	const totalLines = chunk.newLines + chunk.oldLines;
	if (totalLines > MAX_CHUNK_TOTAL_LINES) {
		core.warning(`Skipping chunk: Too large (${totalLines} lines)`);
		return true;
	}
	return false;
}

/**
 * Gets the programming language from a file path
 */
export function getLanguageFromPath(filePath: string): string {
	const extension = filePath.split(".").pop()?.toLowerCase() || "";
	return LANGUAGE_MAP[extension] || "Unknown";
}

/**
 * Validates an AI response
 */
export function validateAIResponse(response: any): response is AIReviewResponse {
	// Validate line number is a positive integer
	const lineNumber = Number(response.lineNumber);
	if (isNaN(lineNumber) || lineNumber <= 0) {
		core.warning(`Invalid line number in AI response: ${response.lineNumber}`);
		return false;
	}

	// Validate review comment is not empty and has reasonable length
	if (!response.reviewComment || response.reviewComment.trim().length === 0) {
		core.warning("Empty review comment received from AI");
		return false;
	}

	if (response.reviewComment.length > 65536) {
		// GitHub's max comment length
		core.warning("Review comment exceeds GitHub's maximum length");
		return false;
	}

	// Validate file path exists and is a string
	if (!response.filePath || typeof response.filePath !== "string") {
		core.warning("Invalid or missing file path in AI response");
		return false;
	}

	// Validate severity is one of the allowed values
	const validSeverities = ["error", "warning", "info"];
	if (!validSeverities.includes(response.severity)) {
		core.warning(`Invalid severity level in AI response: ${response.severity}`);
		return false;
	}

	return true;
}

/**
 * Check if a branch is stale based on last commit date
 * @param lastCommitDate The date of the last commit
 * @param daysThreshold Number of days after which a branch is considered stale
 * @returns Object with isStale flag and age in days
 */
export function isBranchStale(lastCommitDate: string, daysThreshold: number = 30): { isStale: boolean; ageInDays: number } {
	const commitDate = new Date(lastCommitDate);
	const today = new Date();
	
	// Calculate the difference in days
	const diffTime = Math.abs(today.getTime() - commitDate.getTime());
	const ageInDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
	
	return {
		isStale: ageInDays > daysThreshold,
		ageInDays
	};
}
