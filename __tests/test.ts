// First, load dotenv and set all environment variables
import dotenv from 'dotenv';
dotenv.config();

// Set all required environment variables BEFORE any other imports
process.env.GITHUB_EVENT_PATH = './__tests/fixtures/pull_request.json';
process.env.INPUT_GITHUB_TOKEN = process.env.GITHUB_TOKEN;
process.env.INPUT_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
process.env.INPUT_AI_PROVIDER = 'openai';
process.env.INPUT_OPENAI_API_MODEL = 'o3-mini';
// Exclude lock files and limit files for testing
process.env.INPUT_EXCLUDE = '**/*lock.json,**/yarn.lock,**/package-lock.json';
process.env.INPUT_MAX_FILES = '5';  // Limit to first 5 files for testing

// Set up logging for AI responses
process.env.ACTIONS_STEP_DEBUG = 'true';  // Enable debug logging
process.env.ACTIONS_RUNNER_DEBUG = 'true';  // Enable runner debugging

// Now import other dependencies
import { readFileSync, writeFileSync } from 'fs';
import * as core from '@actions/core';
import { Octokit } from '@octokit/rest';
import { main } from '../src/main';

// Initialize Octokit with your token
const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

async function getPRDetails() {
  try {
    const { data: pr } = await octokit.pulls.get({
      owner: 'CarbonNYC',
      repo: 'thera-fe',
      pull_number: 1881
    });

    return {
      base: {
        sha: pr.base.sha,
        ref: pr.base.ref
      },
      head: {
        sha: pr.head.sha,
        ref: pr.head.ref
      },
      title: pr.title,
      body: pr.body || ""
    };
  } catch (error) {
    console.error('Failed to fetch PR details:', error);
    throw error;
  }
}

// Main execution
async function run() {
  try {
    console.log('Fetching PR details...');
    const prDetails = await getPRDetails();
    console.log('PR details fetched:', {
      base: { sha: prDetails.base.sha, ref: prDetails.base.ref },
      head: { sha: prDetails.head.sha, ref: prDetails.head.ref }
    });

    // Set up environment for the actual PR
    const PR_EVENT = {
      action: "opened",
      number: 1881,
      pull_request: {
        number: 1881,
        title: prDetails.title,
        body: prDetails.body,
        base: prDetails.base,
        head: prDetails.head
      },
      repository: {
        name: "thera-fe",
        owner: {
          login: "CarbonNYC"
        }
      }
    };

    // Create fixtures directory if it doesn't exist
    const fs = require('fs');
    if (!fs.existsSync('./__tests/fixtures')) {
      fs.mkdirSync('./__tests/fixtures', { recursive: true });
    }

    // Write PR event data
    writeFileSync('./__tests/fixtures/pull_request.json', JSON.stringify(PR_EVENT, null, 2));

    // Log environment setup for debugging
    console.log('\nEnvironment setup:');
    console.log('- GITHUB_TOKEN:', process.env.INPUT_GITHUB_TOKEN ? '✓ Set' : '✗ Not set');
    console.log('- OPENAI_API_KEY:', process.env.INPUT_OPENAI_API_KEY ? '✓ Set' : '✗ Not set');
    console.log('- AI_PROVIDER:', process.env.INPUT_AI_PROVIDER);
    console.log('- OPENAI_API_MODEL:', process.env.INPUT_OPENAI_API_MODEL);
    console.log('- EXCLUDE:', process.env.INPUT_EXCLUDE);
    console.log('- MAX_FILES:', process.env.INPUT_MAX_FILES);

    // Run the main function with actual API calls
    console.log('\nStarting review of PR #1881...');
    await main();
    console.log('Review completed successfully');
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

// Run the async function
run();
