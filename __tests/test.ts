import { readFileSync, writeFileSync } from 'fs';
import * as core from '@actions/core';
import { main } from './src/main';
import { Octokit } from '@octokit/rest';
import { jest } from '@jest/globals';

// Mock GitHub Action environment
process.env.GITHUB_EVENT_PATH = './test/fixtures/pull_request.json';
process.env.GITHUB_TOKEN = process.env.GITHUB_TOKEN || 'test-token';
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-openai-key';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-anthropic-key';

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
  }
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

// Mock Octokit
const mockOctokit = {
  pulls: {
    get: jest.fn().mockResolvedValue({
      data: {
        title: 'Test PR',
        body: 'This is a test PR for local testing',
        number: 1
      }
    } as any)
  },
  repos: {
    compareCommits: jest.fn().mockResolvedValue({
      data: testDiff
    } as any)
  }
};

jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => mockOctokit)
}));

// Mock core.getInput
const originalGetInput = core.getInput;
// @ts-expect-error - We need to mock this for testing
core.getInput = (name: string): string => {
  switch (name) {
    case 'GITHUB_TOKEN':
      return process.env.GITHUB_TOKEN || 'test-token';
    case 'OPENAI_API_KEY':
      return process.env.OPENAI_API_KEY || 'test-openai-key';
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

// Run the main function
console.log('Starting local test...');
main().then(() => {
  console.log('Test completed successfully');
}).catch((error: Error) => {
  console.error('Test failed:', error);
  process.exit(1);
}); 