import { readFileSync, writeFileSync } from 'fs';
import * as core from '@actions/core';
import * as dotenv from 'dotenv';
import { Octokit } from '@octokit/rest';

// Load environment variables from .env file
dotenv.config();

// Debug: Log environment variables
console.log('Environment variables:');
console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');
console.log('ANTHROPIC_API_KEY:', process.env.ANTHROPIC_API_KEY ? 'Present' : 'Missing');

// Set environment variables directly
const openaiKey = process.env.OPENAI_API_KEY;
if (!openaiKey) {
  console.error('OPENAI_API_KEY is required');
  process.exit(1);
}

// Mock Octokit client
const mockOctokit = {
  pulls: {
    get: async ({ owner, repo, pull_number }: any) => {
      return {
        data: {
          title: "Test PR",
          body: "This is a test PR for local testing",
          number: pull_number
        }
      };
    }
  },
  repos: {
    compareCommits: async () => {
      return {
        data: readFileSync('./test/fixtures/test.diff', 'utf8')
      };
    }
  }
};

// @ts-expect-error - We need to mock this for testing
Octokit.prototype.pulls = mockOctokit.pulls;
// @ts-expect-error - We need to mock this for testing
Octokit.prototype.repos = mockOctokit.repos;

// Mock core.getInput BEFORE importing main
const originalGetInput = core.getInput;
// @ts-expect-error - We need to mock this for testing
core.getInput = (name: string): string => {
  console.log(`Getting input for: ${name}`);
  switch (name) {
    case 'GITHUB_TOKEN':
      return 'test-token';
    case 'OPENAI_API_KEY':
      console.log('Returning OpenAI key:', openaiKey);
      return openaiKey;
    case 'ANTHROPIC_API_KEY':
      return process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';
    case 'AI_PROVIDER':
      return 'openai';
    case 'OPENAI_API_MODEL':
      return 'o3-mini';
    case 'ANTHROPIC_API_MODEL':
      return 'claude-3-7-sonnet-20250219';
    case 'exclude':
      return 'yarn.lock,dist/**';
    default:
      return originalGetInput(name);
  }
};

// Now import main after mocking
import { main } from './src/main';

// Mock GitHub Action environment
process.env.GITHUB_EVENT_PATH = './test/fixtures/pull_request.json';

// Create test fixtures directory if it doesn't exist
const fs = require('fs');
if (!fs.existsSync('./test/fixtures')) {
  fs.mkdirSync('./test/fixtures', { recursive: true });
}

// Create a test pull request event
const pullRequestEvent = {
  action: "opened",
  pull_request: {
    number: 1,
    title: "Test PR",
    body: "This is a test PR for local testing",
    base: {
      sha: "base-sha"
    },
    head: {
      sha: "head-sha"
    }
  },
  repository: {
    name: "test-repo",
    owner: {
      login: "test-owner"
    }
  },
  number: 1
};

// Write the test event to a file
writeFileSync('./test/fixtures/pull_request.json', JSON.stringify(pullRequestEvent, null, 2));

// Create a test diff
const testDiff = `diff --git a/test.ts b/test.ts
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/test.ts
@@ -0,0 +1,10 @@
+function test() {
+    console.log("Hello World");
+}
+
+// This is a test function
+function add(a: number, b: number): number {
+    return a + b;
+}
+
+test();
+add(1, 2);
`;

// Write the test diff to a file
writeFileSync('./test/fixtures/test.diff', testDiff);

// Run the main function
console.log('Starting AI test...');
console.log('API Key being used:', openaiKey);
console.log('AI Provider:', core.getInput('AI_PROVIDER'));
console.log('OpenAI Model:', core.getInput('OPENAI_API_MODEL'));

main().then(() => {
  console.log('AI test completed successfully');
}).catch((error: Error) => {
  console.error('AI test failed:', error);
  process.exit(1);
}); 