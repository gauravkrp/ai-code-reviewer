import * as core from "@actions/core";
import { MAX_RETRIES, RETRY_DELAY, MAX_RETRY_DELAY, RATE_LIMIT_DELAY } from "../config";

// Track last API call time for rate limiting
const API_CALL_QUEUE = new Map<string, number>();

/**
 * Adds rate limiting to API calls
 */
async function withRateLimit<T>(
  operation: () => Promise<T>,
  apiName: string
): Promise<T> {
  const now = Date.now();
  const lastCallTime = API_CALL_QUEUE.get(apiName) || 0;
  const timeToWait = Math.max(0, lastCallTime + RATE_LIMIT_DELAY - now);
  
  if (timeToWait > 0) {
    core.debug(`Rate limiting: Waiting ${timeToWait}ms before calling ${apiName}`);
    await delay(timeToWait);
  }
  
  API_CALL_QUEUE.set(apiName, Date.now());
  return operation();
}

/**
 * Helper function to delay execution
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Helper function to retry an async operation with exponential backoff
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  delayMs: number = RETRY_DELAY,
  apiName?: string
): Promise<T> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Add rate limiting if apiName is provided
      if (apiName) {
        return await withRateLimit(() => operation(), apiName);
      } else {
        return await operation();
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      
      // Check for rate limiting errors and adjust delay
      if (error instanceof Error) {
        const errorMsg = error.message.toLowerCase();
        if (
          errorMsg.includes('rate limit') || 
          errorMsg.includes('too many requests') ||
          errorMsg.includes('429')
        ) {
          // For rate limit errors, use a longer delay with exponential backoff
          delayMs = Math.min(delayMs * 3, MAX_RETRY_DELAY);
          core.warning(`Rate limit detected, increasing delay to ${delayMs}ms`);
        }
      }
      
      if (attempt < maxRetries) {
        core.warning(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`);
        await delay(delayMs * attempt); // Exponential backoff
      }
    }
  }
  
  throw lastError;
} 