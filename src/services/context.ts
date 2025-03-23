import { Octokit } from "@octokit/rest";
import * as core from "@actions/core";
import { CodebaseContext, FileTreeContext } from "../types";
import { getLanguageFromPath } from "../utils";

/**
 * Calculates similarity between two strings using Levenshtein distance
 */
function calculateSimilarity(str1: string, str2: string): number {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  
  if (longer.length === 0) return 1.0;
  
  return (longer.length - levenshteinDistance(longer, shorter)) / longer.length;
}

/**
 * Calculates Levenshtein distance between two strings
 */
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = Array(str2.length + 1).fill(null).map(() => 
    Array(str1.length + 1).fill(null)
  );

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Parses imports from file content based on file type
 */
function parseImports(content: string, filePath: string): { from: string; to: string; type: 'import' | 'require' | 'dependency' }[] {
  const language = getLanguageFromPath(filePath).toLowerCase();
  const imports: { from: string; to: string; type: 'import' | 'require' | 'dependency' }[] = [];

  switch (language) {
    case 'typescript':
    case 'javascript':
      // Match ES6 imports
      const es6Imports = content.match(/import\s+.*?from\s+['"]([^'"]+)['"]/g);
      if (es6Imports) {
        es6Imports.forEach(imp => {
          const match = imp.match(/from\s+['"]([^'"]+)['"]/);
          if (match) {
            imports.push({
              from: filePath,
              to: match[1],
              type: 'import'
            });
          }
        });
      }

      // Match require statements
      const requires = content.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/g);
      if (requires) {
        requires.forEach(req => {
          const match = req.match(/['"]([^'"]+)['"]/);
          if (match) {
            imports.push({
              from: filePath,
              to: match[1],
              type: 'require'
            });
          }
        });
      }
      break;

    case 'python':
      // Match Python imports
      const pythonImports = content.match(/^(?:from\s+([^\s]+)\s+import|import\s+([^\s]+))/gm);
      if (pythonImports) {
        pythonImports.forEach(imp => {
          const match = imp.match(/^(?:from\s+([^\s]+)\s+import|import\s+([^\s]+))/);
          if (match) {
            imports.push({
              from: filePath,
              to: match[1] || match[2],
              type: 'import'
            });
          }
        });
      }
      break;

    // Add more language-specific import parsing as needed
  }

  return imports;
}

/**
 * Gets dependencies from package.json or similar files
 */
async function getDependencies(octokit: Octokit, owner: string, repo: string): Promise<{ name: string; version: string; type: 'runtime' | 'dev' }[]> {
  const dependencies: { name: string; version: string; type: 'runtime' | 'dev' }[] = [];

  try {
    // Try to get package.json
    const packageJson = await octokit.repos.getContent({
      owner,
      repo,
      path: 'package.json'
    });

    if (packageJson.data && typeof packageJson.data === 'string') {
      const pkg = JSON.parse(packageJson.data);
      
      // Add runtime dependencies
      if (pkg.dependencies) {
        Object.entries(pkg.dependencies).forEach(([name, version]) => {
          dependencies.push({
            name,
            version: version as string,
            type: 'runtime'
          });
        });
      }

      // Add dev dependencies
      if (pkg.devDependencies) {
        Object.entries(pkg.devDependencies).forEach(([name, version]) => {
          dependencies.push({
            name,
            version: version as string,
            type: 'dev'
          });
        });
      }
    }
  } catch (error) {
    core.debug(`Could not fetch package.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  return dependencies;
}

/**
 * Gets codebase context for a file
 */
export async function getCodebaseContextForFile(
  filePath: string,
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<CodebaseContext> {
  try {
    // Get file content
    const fileContent = await octokit.repos.getContent({
      owner,
      repo,
      path: filePath
    });

    // Handle different response types from GitHub API
    let fileContentStr: string;
    if (Array.isArray(fileContent.data)) {
      throw new Error('Expected single file content, got array');
    } else if (typeof fileContent.data === 'object' && fileContent.data !== null) {
      if ('content' in fileContent.data && typeof fileContent.data.content === 'string') {
        fileContentStr = fileContent.data.content;
      } else {
        throw new Error('File content not found in response');
      }
    } else {
      throw new Error('Unexpected response format from GitHub API');
    }

    // Parse imports
    const imports = parseImports(fileContentStr, filePath);

    // Get related files
    const relatedFiles = await Promise.all(
      imports.map(async (imp) => {
        try {
          const content = await octokit.repos.getContent({
            owner,
            repo,
            path: imp.to
          });

          let relatedContentStr: string;
          if (Array.isArray(content.data)) {
            throw new Error('Expected single file content, got array');
          } else if (typeof content.data === 'object' && content.data !== null) {
            if ('content' in content.data && typeof content.data.content === 'string') {
              relatedContentStr = content.data.content;
            } else {
              throw new Error('File content not found in response');
            }
          } else {
            throw new Error('Unexpected response format from GitHub API');
          }

          return {
            path: imp.to,
            content: relatedContentStr,
            similarity: calculateSimilarity(fileContentStr, relatedContentStr)
          };
        } catch (error) {
          core.debug(`Could not fetch related file ${imp.to}: ${error instanceof Error ? error.message : String(error)}`);
          return null;
        }
      })
    );

    // Get dependencies
    const dependencies = await getDependencies(octokit, owner, repo);

    return {
      relevantFiles: relatedFiles.filter(Boolean) as CodebaseContext['relevantFiles'],
      imports,
      dependencies
    };
  } catch (error) {
    core.error(`Error getting codebase context for ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return {
      relevantFiles: [],
      imports: [],
      dependencies: []
    };
  }
}

/**
 * Gets file tree context for the repository
 */
export async function getFileTreeContext(
  octokit: Octokit,
  owner: string,
  repo: string
): Promise<FileTreeContext> {
  try {
    // Get repository tree
    const tree = await octokit.git.getTree({
      owner,
      repo,
      tree_sha: 'HEAD',
      recursive: '1'
    });

    // Build file tree structure
    const structure = tree.data.tree
      .filter(item => item.type === 'blob' || item.type === 'tree')
      .map(item => ({
        path: item.path || '',
        type: item.type === 'blob' ? 'file' as const : 'directory' as const,
        children: item.type === 'tree' ? [] : undefined
      }));

    // Get relationships (imports) for all files
    const relationships = await Promise.all(
      tree.data.tree
        .filter(item => item.type === 'blob' && item.path)
        .map(async (item) => {
          try {
            const content = await octokit.repos.getContent({
              owner,
              repo,
              path: item.path || ''
            });

            if (content.data && typeof content.data === 'string') {
              const imports = parseImports(content.data, item.path || '');
              return imports.map(imp => ({
                type: imp.type === 'require' ? 'import' as const : imp.type,
                from: item.path || '',
                to: imp.to
              }));
            }
            return [];
          } catch (error) {
            core.debug(`Could not process file ${item.path}: ${error instanceof Error ? error.message : String(error)}`);
            return [];
          }
        })
    );

    return {
      structure,
      relationships: relationships.flat()
    };
  } catch (error) {
    core.error(`Error getting file tree context: ${error instanceof Error ? error.message : String(error)}`);
    return {
      structure: [],
      relationships: []
    };
  }
} 