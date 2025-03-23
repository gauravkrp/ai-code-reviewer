import * as core from "@actions/core";

// Model-specific configurations
export interface ModelConfig {
  maxTokens: number;
  contextWindow: number;
  tokenMultiplier: number;
}

export const MODEL_CONFIGS: Record<string, ModelConfig> = {
  // OpenAI models
  'gpt-4': { maxTokens: 4096, contextWindow: 8192, tokenMultiplier: 1 },
  'gpt-4-turbo': { maxTokens: 4096, contextWindow: 128000, tokenMultiplier: 1 },
  'gpt-3.5-turbo': { maxTokens: 4096, contextWindow: 16385, tokenMultiplier: 1 },
  'o3-mini': { maxTokens: 4096, contextWindow: 128000, tokenMultiplier: 1 },
  
  // Anthropic models
  'claude-3-opus': { maxTokens: 8192, contextWindow: 200000, tokenMultiplier: 1 },
  'claude-3-sonnet': { maxTokens: 8192, contextWindow: 200000, tokenMultiplier: 1 },
  'claude-3-haiku': { maxTokens: 8192, contextWindow: 200000, tokenMultiplier: 1 },
  'claude-2.1': { maxTokens: 8192, contextWindow: 200000, tokenMultiplier: 1 },
  'claude-2': { maxTokens: 8192, contextWindow: 100000, tokenMultiplier: 1 },
  'claude-3-7-sonnet-20250219': { maxTokens: 8192, contextWindow: 200000, tokenMultiplier: 1 },
  
  // Default fallback
  'default': { maxTokens: 4096, contextWindow: 8192, tokenMultiplier: 1 }
};

// Get model config based on provider and model name
export function getModelConfig(provider: string, model: string): ModelConfig {
  const modelKey = model.toLowerCase();
  const config = MODEL_CONFIGS[modelKey];
  
  if (!config) {
    core.warning(`No specific config found for model ${model}, using default configuration`);
    return MODEL_CONFIGS.default;
  }
  
  return config;
}

// AI Provider Configuration
export const AI_PROVIDER: string = core.getInput("AI_PROVIDER") || "openai";
export const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
export const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL") || "o3-mini";
export const ANTHROPIC_API_KEY: string = core.getInput("ANTHROPIC_API_KEY");
export const ANTHROPIC_API_MODEL: string = core.getInput("ANTHROPIC_API_MODEL") || "claude-3-7-sonnet-20250219";

// GitHub Configuration
export const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
export const MAX_FILES: number = parseInt(core.getInput("MAX_FILES") || "0", 10);
export const EXCLUDE_PATTERNS: string[] = core
  .getInput("exclude")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Features Configuration
export const ENABLE_SUMMARY: boolean = core.getInput("ENABLE_SUMMARY") !== "false"; // Enabled by default
export const ENABLE_AUTO_FIX: boolean = core.getInput("ENABLE_AUTO_FIX") !== "false"; // Enabled by default
export const ENABLE_AUTO_PR: boolean = core.getInput("ENABLE_AUTO_PR") === "true"; // Disabled by default

// Suggestion Strategy: 'auto-fix-first', 'ai-first', or 'ai-only'
export const SUGGESTION_STRATEGY: string = core.getInput("SUGGESTION_STRATEGY") || "auto-fix-first";

// Review Focus Configuration - what areas to focus on during review
export const REVIEW_FOCUS: string[] = core
  .getInput("REVIEW_FOCUS")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Default review criteria if none specified
export const DEFAULT_REVIEW_CRITERIA = [
  "code_quality",
  "bugs",
  "security",
  "performance",
  "maintainability",
  "testability"
];

// Get the actual criteria to use (default or user-provided)
export const REVIEW_CRITERIA = REVIEW_FOCUS.length > 0 ? REVIEW_FOCUS : DEFAULT_REVIEW_CRITERIA;

// Retry Configuration
export const MAX_RETRIES = 3;
export const RETRY_DELAY = 1000; // 1 second
export const MAX_RETRY_DELAY = 30000; // 30 seconds maximum delay

// Token Configuration
export const DEFAULT_MAX_TOKENS = 2500;
export const MAX_CHUNK_SIZE_FOR_DEFAULT_TOKENS = 500; // lines
export const TOKEN_MULTIPLIER = 3; // Increase tokens by 3x for large chunks

// Rate Limiting and Memory Management
export const RATE_LIMIT_DELAY = 1000; // 1 second between API calls
export const MAX_CHUNK_TOTAL_LINES = 2000; // Skip chunks larger than this
export const MAX_FILE_TOTAL_LINES = 5000; // Skip files larger than this

// Language Mapping
export const LANGUAGE_MAP: { [key: string]: string } = {
  'js': 'JavaScript',
  'jsx': 'React',
  'ts': 'TypeScript',
  'tsx': 'React TypeScript',
  'py': 'Python',
  'java': 'Java',
  'cpp': 'C++',
  'c': 'C',
  'cs': 'C#',
  'go': 'Go',
  'rb': 'Ruby',
  'php': 'PHP',
  'swift': 'Swift',
  'kt': 'Kotlin',
  'rs': 'Rust',
  'scala': 'Scala',
  'r': 'R',
  'm': 'Objective-C',
  'mm': 'Objective-C++',
  'h': 'C/C++ Header',
  'hpp': 'C++ Header',
  'sh': 'Shell',
  'bash': 'Bash',
  'zsh': 'Zsh',
  'fish': 'Fish',
  'sql': 'SQL',
  'html': 'HTML',
  'css': 'CSS',
  'scss': 'SCSS',
  'less': 'Less',
  'json': 'JSON',
  'yaml': 'YAML',
  'yml': 'YAML',
  'toml': 'TOML',
  'md': 'Markdown',
  'rst': 'reStructuredText',
  'tex': 'LaTeX',
  'vue': 'Vue',
  'svelte': 'Svelte',
  'astro': 'Astro',
}; 