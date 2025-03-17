import { Octokit } from '@octokit/rest';
import * as core from '@actions/core';

// Test GitHub token
async function testGitHubToken() {
  try {
    const token = process.env.GITHUB_TOKEN || 'test-token';
    console.log('Testing GitHub token...');
    
    // Create Octokit instance
    const octokit = new Octokit({ auth: token });
    
    // Try to get authenticated user
    const { data: user } = await octokit.users.getAuthenticated();
    console.log('GitHub token is valid!');
    console.log('Authenticated as:', user.login);
    
    // Test repository access
    const { data: repo } = await octokit.repos.get({
      owner: 'test-owner',
      repo: 'test-repo'
    });
    console.log('Repository access successful!');
    console.log('Repository:', repo.name);
    
  } catch (error) {
    console.error('GitHub token test failed:', error);
    process.exit(1);
  }
}

// Run the test
testGitHubToken(); 