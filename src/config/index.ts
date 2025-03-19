import * as core from "@actions/core";

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