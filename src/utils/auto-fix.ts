import * as core from "@actions/core";
import { Chunk, File } from "parse-diff";
import { AIReviewResponse } from "../types";
import { getLanguageFromPath } from "./index";

/**
 * Pattern definitions for auto-fixing common issues
 */
interface FixPattern {
  pattern: RegExp;
  language: string;
  description: string;
  fix: (match: RegExpExecArray, lineContent: string) => string | null;
}

/**
 * Catalog of fix patterns for common issues
 */
const FIX_PATTERNS: FixPattern[] = [
  // JavaScript/TypeScript unused variables
  {
    pattern: /const\s+(\w+)\s*=.+?;\s*(?:\/\/.*)?$/,
    language: "typescript",
    description: "Fix unused variable with _ prefix",
    fix: (match, content) => {
      // Only suggest if it appears to be an unused variable (based on review comment)
      if (content.includes("unused") || content.includes("not used")) {
        const varName = match[1];
        return content.replace(/const\s+(\w+)/, `const _${varName}`);
      }
      return null;
    }
  },
  
  // JavaScript/TypeScript missing null checks
  {
    pattern: /(\w+)\.(\w+)/g,
    language: "typescript",
    description: "Add optional chaining for safer property access",
    fix: (match, content) => {
      // Only suggest if it appears to be a null check issue
      if (content.includes("null") || content.includes("undefined") || content.includes("TypeError")) {
        const obj = match[1];
        return content.replace(`${obj}.`, `${obj}?.`);
      }
      return null;
    }
  },
  
  // JavaScript/TypeScript console.log statements
  {
    pattern: /console\.log\(/,
    language: "typescript",
    description: "Remove console.log statement",
    fix: (match, content) => {
      if (content.includes("debug") || content.includes("production") || content.includes("remove console")) {
        // Find the full statement including the semicolon
        const fullStatement = content.match(/console\.log\(.+?\);?/);
        if (fullStatement) {
          return content.replace(fullStatement[0], '');
        }
      }
      return null;
    }
  },
  
  // JavaScript/TypeScript promise handling
  {
    pattern: /(\w+)\.then\(/,
    language: "typescript",
    description: "Use async/await instead of promise chains",
    fix: (match, content) => {
      if (content.includes("async/await") || content.includes("promise chain")) {
        const promiseVar = match[1];
        return `await ${promiseVar}`;
      }
      return null;
    }
  },
  
  // Missing type annotations
  {
    pattern: /(const|let|var)\s+(\w+)\s*=/,
    language: "typescript",
    description: "Add type annotation",
    fix: (match, content) => {
      if (content.includes("type") || content.includes("annotation")) {
        const declaration = match[1];
        const varName = match[2];
        // Try to infer the type from the content
        let type = "any";
        
        if (content.includes("string") || content.match(/['"`]/)) {
          type = "string";
        } else if (content.includes("number") || content.match(/\d+/)) {
          type = "number";
        } else if (content.includes("boolean") || content.includes("true") || content.includes("false")) {
          type = "boolean";
        } else if (content.includes("array") || content.match(/\[\]/)) {
          type = "any[]";
        } else if (content.includes("object") || content.match(/\{.*\}/)) {
          type = "Record<string, any>";
        }
        
        return content.replace(`${declaration} ${varName} =`, `${declaration} ${varName}: ${type} =`);
      }
      return null;
    }
  }
];

/**
 * Tries to apply automated fixes to issues found by the AI
 * @param file The file being analyzed
 * @param chunk The code chunk
 * @param aiResponse The AI's review response
 * @returns The AI response with added suggestion if a fix was found
 */
export function tryAutomaticFix(
  file: File,
  chunk: Chunk,
  aiResponse: AIReviewResponse
): AIReviewResponse {
  // If the AI already provided a suggestion, don't override it
  if (aiResponse.suggestion && aiResponse.suggestion.code) {
    return aiResponse;
  }
  
  // Get the file language
  const language = getLanguageFromPath(file.to || file.from || "");
  
  // Find the actual line content from the chunk
  const lineIndex = aiResponse.lineNumber - chunk.newStart;
  const lineChange = chunk.changes[lineIndex];
  
  if (!lineChange || !lineChange.content) {
    return aiResponse;
  }
  
  const lineContent = lineChange.content;
  core.debug(`Trying to auto-fix: ${lineContent}`);
  
  // Find matching fix patterns for this language and issue
  const relevantPatterns = FIX_PATTERNS.filter(pattern => 
    (pattern.language === language.toLowerCase() || pattern.language === '*') &&
    pattern.pattern.test(lineContent)
  );
  
  for (const pattern of relevantPatterns) {
    pattern.pattern.lastIndex = 0; // Reset regex state
    const match = pattern.pattern.exec(lineContent);
    
    if (match) {
      const fixedCode = pattern.fix(match, aiResponse.reviewComment);
      
      if (fixedCode) {
        core.info(`Found automatic fix for issue at ${file.to}:${aiResponse.lineNumber}`);
        
        // Return the AI response with the added suggestion
        return {
          ...aiResponse,
          suggestion: {
            code: fixedCode,
            description: `Auto-fix: ${pattern.description}`
          }
        };
      }
    }
  }
  
  return aiResponse;
} 