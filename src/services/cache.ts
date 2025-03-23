import * as core from "@actions/core";
import * as cache from "@actions/cache";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { AIReviewResponse, ReviewComment } from "../types";

// Cache configuration
const CACHE_ENABLED = core.getInput("CACHE_ENABLED") === "true";
const CACHE_KEY_PREFIX = core.getInput("CACHE_KEY_PREFIX") || "ai-review-";
const CACHE_TTL_DAYS = parseInt(core.getInput("CACHE_TTL_DAYS") || "7", 10);
const TEMP_CACHE_DIR = path.join(os.tmpdir(), "ai-review-cache");

// Make sure the cache directory exists
if (!fs.existsSync(TEMP_CACHE_DIR)) {
  fs.mkdirSync(TEMP_CACHE_DIR, { recursive: true });
}

/**
 * Generate a hash for the input string
 */
function generateHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * Generate a cache key for code review results
 */
function generateReviewCacheKey(repoFullName: string, filePath: string, codeContent: string): string {
  const contentHash = generateHash(codeContent);
  return `${CACHE_KEY_PREFIX}review-${repoFullName}-${generateHash(filePath)}-${contentHash}`;
}

/**
 * Generate a cache key for comment history
 */
function generateHistoryCacheKey(repoFullName: string, prNumber: number): string {
  return `${CACHE_KEY_PREFIX}history-${repoFullName}-${prNumber}`;
}

/**
 * Ensures the cache directory exists
 */
function ensureCacheDir(): void {
  if (!fs.existsSync(TEMP_CACHE_DIR)) {
    try {
      fs.mkdirSync(TEMP_CACHE_DIR, { recursive: true });
      core.debug(`Created cache directory at ${TEMP_CACHE_DIR}`);
    } catch (error) {
      core.warning(`Failed to create cache directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/**
 * Cache AI review results
 */
export async function cacheReviewResults(
  repoFullName: string,
  filePath: string,
  codeContent: string,
  results: AIReviewResponse[]
): Promise<boolean> {
  if (!CACHE_ENABLED) return false;

  try {
    ensureCacheDir();
    const cacheKey = generateReviewCacheKey(repoFullName, filePath, codeContent);
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Add timestamp for TTL checking
    const cacheData = {
      timestamp: Date.now(),
      ttlDays: CACHE_TTL_DAYS,
      results
    };
    
    // Write to temp file
    fs.writeFileSync(cachePath, JSON.stringify(cacheData));
    
    // Save to GitHub Actions Cache
    await cache.saveCache([cachePath], cacheKey);
    
    core.debug(`Cached review results for ${filePath} with key ${cacheKey}`);
    return true;
  } catch (error) {
    // Cache errors shouldn't fail the workflow
    core.warning(`Failed to cache review results: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Get cached AI review results
 */
export async function getCachedReviewResults(
  repoFullName: string,
  filePath: string,
  codeContent: string
): Promise<AIReviewResponse[] | null> {
  if (!CACHE_ENABLED) return null;

  try {
    ensureCacheDir();
    const cacheKey = generateReviewCacheKey(repoFullName, filePath, codeContent);
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Try to restore from cache
    const cacheHit = await cache.restoreCache([cachePath], cacheKey);
    
    if (!cacheHit) {
      core.debug(`Cache miss for ${filePath}`);
      return null;
    }
    
    // Read the cached data
    const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    
    // Check if cache has expired
    const timestamp = cacheData.timestamp || 0;
    const ttlDays = cacheData.ttlDays || CACHE_TTL_DAYS;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    
    if (Date.now() - timestamp > ttlMs) {
      core.debug(`Cache expired for ${filePath}`);
      return null;
    }
    
    core.info(`Cache hit for ${filePath}`);
    return cacheData.results;
  } catch (error) {
    core.warning(`Error retrieving cached review results: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Store comment history for duplicate detection
 */
export async function storeCommentHistory(
  repoFullName: string,
  prNumber: number,
  comments: ReviewComment[]
): Promise<boolean> {
  if (!CACHE_ENABLED) return false;

  try {
    ensureCacheDir();
    const cacheKey = generateHistoryCacheKey(repoFullName, prNumber);
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Check if we already have a history file
    let existingComments: ReviewComment[] = [];
    
    // Try to restore from cache first
    const cacheHit = await cache.restoreCache([cachePath], cacheKey);
    
    if (cacheHit) {
      try {
        existingComments = JSON.parse(fs.readFileSync(cachePath, "utf8")).comments || [];
      } catch (parseError) {
        core.debug(`Failed to parse existing comment history: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    
    // Combine existing and new comments, avoiding duplicates
    const combinedComments = [...existingComments];
    
    for (const comment of comments) {
      if (!combinedComments.some(c => 
        c.path === comment.path && 
        c.line === comment.line && 
        c.body === comment.body
      )) {
        combinedComments.push(comment);
      }
    }
    
    // Write combined comments to temp file
    fs.writeFileSync(cachePath, JSON.stringify({
      timestamp: Date.now(),
      ttlDays: CACHE_TTL_DAYS,
      comments: combinedComments
    }));
    
    // Save to GitHub Actions Cache
    await cache.saveCache([cachePath], cacheKey);
    
    core.debug(`Stored ${comments.length} comments in history for PR #${prNumber}`);
    return true;
  } catch (error) {
    core.warning(`Failed to store comment history: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/**
 * Get comment history for PR
 */
export async function getCommentHistory(
  repoFullName: string,
  prNumber: number
): Promise<ReviewComment[]> {
  if (!CACHE_ENABLED) return [];

  try {
    ensureCacheDir();
    const cacheKey = generateHistoryCacheKey(repoFullName, prNumber);
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Try to restore from cache
    const cacheHit = await cache.restoreCache([cachePath], cacheKey);
    
    if (!cacheHit) {
      core.debug(`No comment history cache for PR #${prNumber}`);
      return [];
    }
    
    // Read the cached data
    const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    
    // Check if cache has expired
    const timestamp = cacheData.timestamp || 0;
    const ttlDays = cacheData.ttlDays || CACHE_TTL_DAYS;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    
    if (Date.now() - timestamp > ttlMs) {
      core.debug(`Comment history cache expired for PR #${prNumber}`);
      return [];
    }
    
    core.debug(`Retrieved ${cacheData.comments?.length || 0} historical comments for PR #${prNumber}`);
    return cacheData.comments || [];
  } catch (error) {
    core.warning(`Failed to get comment history: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

/**
 * Track common issues across the repository
 */
export async function trackCommonIssue(
  repoFullName: string,
  issueType: string,
  count: number = 1
): Promise<void> {
  if (!CACHE_ENABLED) return;

  try {
    ensureCacheDir();
    const cacheKey = `${CACHE_KEY_PREFIX}issues-${repoFullName}`;
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Try to restore from cache
    let issues: Record<string, number> = {};
    const cacheHit = await cache.restoreCache([cachePath], cacheKey);
    
    if (cacheHit) {
      try {
        issues = JSON.parse(fs.readFileSync(cachePath, "utf8")).issues || {};
      } catch (parseError) {
        core.debug(`Failed to parse existing issues: ${parseError instanceof Error ? parseError.message : String(parseError)}`);
      }
    }
    
    // Update issue count
    issues[issueType] = (issues[issueType] || 0) + count;
    
    // Write to temp file
    fs.writeFileSync(cachePath, JSON.stringify({
      timestamp: Date.now(),
      ttlDays: CACHE_TTL_DAYS,
      issues
    }));
    
    // Save to GitHub Actions Cache
    await cache.saveCache([cachePath], cacheKey);
  } catch (error) {
    core.debug(`Failed to track common issue: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Get common issues for a repository
 */
export async function getCommonIssues(
  repoFullName: string
): Promise<Record<string, number>> {
  if (!CACHE_ENABLED) return {};

  try {
    ensureCacheDir();
    const cacheKey = `${CACHE_KEY_PREFIX}issues-${repoFullName}`;
    const cachePath = path.join(TEMP_CACHE_DIR, `${cacheKey}.json`);
    
    // Try to restore from cache
    const cacheHit = await cache.restoreCache([cachePath], cacheKey);
    
    if (!cacheHit) {
      return {};
    }
    
    // Read the cached data
    const cacheData = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    
    // Check if cache has expired
    const timestamp = cacheData.timestamp || 0;
    const ttlDays = cacheData.ttlDays || CACHE_TTL_DAYS;
    const ttlMs = ttlDays * 24 * 60 * 60 * 1000;
    
    if (Date.now() - timestamp > ttlMs) {
      return {};
    }
    
    return cacheData.issues || {};
  } catch (error) {
    core.warning(`Failed to get common issues: ${error instanceof Error ? error.message : String(error)}`);
    return {};
  }
} 