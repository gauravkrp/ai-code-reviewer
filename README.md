# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages OpenAI's GPT-4 or Anthropic's Claude models to provide intelligent feedback and suggestions on
your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process.

## Features

- Reviews pull requests using OpenAI's GPT-4 or Anthropic's Claude models.
- Provides intelligent comments and suggestions for improving your code.
- Generates comprehensive review summaries for quick understanding of key issues.
- Offers inline code suggestions using GitHub's suggestion syntax for easy fixes.
- Includes automated fix recommendations for common coding issues.
- Can automatically create a PR that applies all suggested fixes.
- Customizable review focus areas (code quality, security, performance, etc.).
- Filters out files that match specified exclude patterns.
- Supports both pull requests and direct code pushes to branches.
- Avoids duplicate comments by tracking existing issues and resolved items.
- Detects stale branches to help maintain repository health.
- Uses GitHub Actions cache to improve performance and reduce API costs.
- Easy to set up and integrate into your GitHub workflow.

## Setup

### Using OpenAI

1. To use this GitHub Action with OpenAI, you need an OpenAI API key. If you don't have one, sign up for an API key
   at [OpenAI](https://beta.openai.com/signup).

2. Add the OpenAI API key as a GitHub Secret in your repository with the name `OPENAI_API_KEY`. You can find more
   information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/code_review.yml` file in your repository and add the following content:

```yaml
name: AI Code Review

on:
  pull_request:
    types:
      - opened
      - synchronize
  push:
    branches:
      - main
      - develop
      - 'feature/**'
      - 'bugfix/**'
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: gauravkrp/ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "openai" # Optional: defaults to "openai"
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4-1106-preview" # Optional: defaults to "gpt-4"
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
          # Review customization
          ENABLE_SUMMARY: "true" # Optional: generate a summary of all review findings (default: true)
          ENABLE_AUTO_FIX: "true" # Optional: generate automated fixes for common issues (default: true)
          ENABLE_AUTO_PR: "false" # Optional: create a PR that applies all suggested fixes (default: false)
          REVIEW_FOCUS: "security,performance,bugs" # Optional: customize review focus areas
          SUGGESTION_STRATEGY: "auto-fix-first" # Optional: controls the suggestion strategy (default: auto-fix-first)
          # Cache configuration (all optional)
          CACHE_ENABLED: "true"  # Enable caching (default)
          CACHE_KEY_PREFIX: "acr-"  # Custom prefix for cache keys
          CACHE_TTL_DAYS: "7"  # Cache entries expire after 7 days
```

### Using Anthropic

1. To use this GitHub Action with Anthropic, you need an Anthropic API key. If you don't have one, sign up for an API key
   at [Anthropic](https://console.anthropic.com/).

2. Add the Anthropic API key as a GitHub Secret in your repository with the name `ANTHROPIC_API_KEY`.

3. Create a `.github/workflows/code_review.yml` file in your repository and add the following content:

```yaml
name: AI Code Review

on:
  pull_request:
    types:
      - opened
      - synchronize
  push:
    branches:
      - main
      - develop
      - 'feature/**'
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: gauravkrp/ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "anthropic"
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_API_MODEL: "claude-3-7-sonnet-20250219" # Optional: defaults to "claude-3-7-sonnet-20250219"
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
          # Review customization
          ENABLE_SUMMARY: "true" # Optional: generate a summary of all review findings
          ENABLE_AUTO_FIX: "true" # Optional: generate automated fixes for common issues
          ENABLE_AUTO_PR: "false" # Optional: create a PR that applies all suggested fixes
          REVIEW_FOCUS: "security,performance,maintainability" # Optional: customize review focus areas
          SUGGESTION_STRATEGY: "auto-fix-first" # Optional: controls the suggestion strategy
          # Cache configuration
          CACHE_ENABLED: "true"
          CACHE_TTL_DAYS: "14"  # Keep cache for 2 weeks
```

### Using Repository Variables for Flexibility

You can also use GitHub repository variables to switch between AI providers without changing your workflow file:

```yaml
name: AI Code Review

on:
  pull_request:
    types:
      - opened
      - synchronize
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: gauravkrp/ai-code-reviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: ${{ vars.AI_PROVIDER || 'openai' }}
          # OpenAI configuration
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: ${{ vars.OPENAI_API_MODEL || 'gpt-4-1106-preview' }}
          # Anthropic configuration
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_API_MODEL: ${{ vars.ANTHROPIC_API_MODEL || 'claude-3-7-sonnet-20250219' }}
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
          # Review customization using repository variables
          ENABLE_SUMMARY: ${{ vars.ENABLE_SUMMARY || 'true' }}
          ENABLE_AUTO_FIX: ${{ vars.ENABLE_AUTO_FIX || 'true' }}
          ENABLE_AUTO_PR: ${{ vars.ENABLE_AUTO_PR || 'false' }}
          REVIEW_FOCUS: ${{ vars.REVIEW_FOCUS || 'code_quality,bugs,security,performance,maintainability' }}
          SUGGESTION_STRATEGY: ${{ vars.SUGGESTION_STRATEGY || 'auto-fix-first' }}
          # Cache configuration using repository variables
          CACHE_ENABLED: ${{ vars.CACHE_ENABLED || 'true' }}
          CACHE_KEY_PREFIX: ${{ vars.CACHE_KEY_PREFIX || 'acr-' }}
          CACHE_TTL_DAYS: ${{ vars.CACHE_TTL_DAYS || '7' }}
```

4. Customize the `exclude` input if you want to ignore certain file patterns from being reviewed.

5. Commit the changes to your repository, and AI Code Reviewer will start working on your future pull requests.

## How It Works

The AI Code Reviewer GitHub Action retrieves the pull request diff, filters out excluded files, and sends code chunks to
the selected AI provider (OpenAI or Anthropic). It then generates review comments based on the AI's response and adds them to the pull request.

### Review Customization

You can customize how the AI reviewer focuses on your code:

1. **Review Focus Areas**: Control which aspects of code quality the AI should prioritize:
   ```yaml
   REVIEW_FOCUS: "security,performance,bugs,maintainability,testability"
   ```
   Available focus areas include:
   - `code_quality`: General code quality and best practices
   - `bugs`: Logical errors and potential bugs
   - `security`: Security vulnerabilities
   - `performance`: Performance issues and optimizations
   - `maintainability`: Code readability and maintainability
   - `testability`: Test coverage and testability concerns
   - `documentation`: Missing or incorrect documentation
   - `accessibility`: Accessibility issues
   - `compatibility`: Browser or device compatibility issues
   - `dependencies`: Outdated or unnecessary dependencies
   - `duplication`: Code duplication or redundancy
   - `naming`: Naming conventions and clarity
   - `architecture`: Architectural design issues
   - `standards`: Compliance with standards and conventions

   If not specified, a balanced default selection is used.

2. **Review Summary**: Enable or disable AI-generated summaries of all review comments:
   ```yaml
   ENABLE_SUMMARY: "true"  # or "false" to disable
   ```
   When enabled (default), the AI will provide a comprehensive summary at the beginning of the review, highlighting key issues and patterns found across files.

3. **Branch Staleness Detection**: The action includes utilities to detect stale branches based on the last commit date, helping maintain repository hygiene.

### Code Suggestions and Automated Fixes

The AI Code Reviewer now provides direct code suggestions rather than just comments:

1. **Inline Code Suggestions**: 
   - Automatically formats suggestions using GitHub's suggestion blocks
   - Allows users to apply fixes with a single click
   - Provides clear descriptions of what each fix does

2. **Automated Fix Detection**:
   - Automatically detects and suggests fixes for common issues
   - Provides pattern-matching for typical problems like:
     - Unused variables
     - Missing null checks
     - Debugging statements left in code
     - Promise chains that could use async/await
     - Missing type annotations
   - Can be enabled/disabled with the `ENABLE_AUTO_FIX` configuration option

These suggestions appear directly in the review comments with a "Suggested Fix" section that users can apply with a single click, making it much easier to implement the AI's recommendations.

To control the suggestion behavior, use the `SUGGESTION_STRATEGY` option:

```yaml
# Choose one of these strategies:
SUGGESTION_STRATEGY: "auto-fix-first" # Try automated fixes first, fallback to AI suggestions (default)
SUGGESTION_STRATEGY: "ai-first"       # Use AI suggestions if available, fallback to automated fixes 
SUGGESTION_STRATEGY: "ai-only"        # Only use AI-generated suggestions, never automated fixes
```

This allows you to prioritize the more reliable auto-fixes for common patterns, or prefer the AI's custom suggestions when they're available.

### Automatic Fix PRs

You can enable the system to automatically create a pull request that applies all suggested fixes:

```yaml
ENABLE_AUTO_PR: "true"  # Default is "false"
```

When enabled, the system will:
1. Collect all suggestions from the review comments
2. Create a new branch based on the PR's head branch
3. Apply all suggestions to the appropriate files
4. Create a new PR that targets the original PR's branch
5. Include a detailed description of all the applied fixes

This completely automates the process of applying fixes - instead of clicking each suggestion individually, you can simply review and merge the auto-fix PR.

### Support for Code Pushes

In addition to pull request reviews, the action can also analyze code changes pushed directly to branches. When detecting a push event:

1. It retrieves only the diff from the specific commits that were pushed
2. For the first commit in a repository, it properly handles the special case
3. Instead of creating PR review comments (which aren't available for pushes), it outputs the analysis in the action logs

### Duplicate Comment Prevention

To avoid creating redundant feedback, the action implements intelligent comment deduplication:

1. **Line-based detection**: Skips comments on lines that already have existing comments
2. **Semantic similarity**: Detects when a new comment is semantically similar to an existing one (even if on slightly different lines)
3. **Resolved comment tracking**: Avoids re-suggesting issues that have already been resolved in previous reviews
4. **Proximity awareness**: Considers nearby lines when determining whether a comment would be redundant

This ensures that the review process remains helpful without creating noise from repeated suggestions.

### Caching Support

The action uses GitHub Actions' built-in cache to improve performance and reduce API costs:

1. **AI Response Caching**: 
   - Caches responses for specific code chunks to avoid repeating identical API calls
   - Significantly reduces token usage and API costs for similar code patterns
   - Faster reviews as cached responses are retrieved instantly

2. **Comment History Caching**:
   - Preserves a history of past comments to enhance duplicate detection
   - Works across workflow runs to maintain state
   - Combines with GitHub's API to ensure comprehensive duplicate detection

3. **Analytics Tracking**:
   - Records common issue types found in the repository
   - Builds insights about code quality trends over time
   - Uses configurable TTL to maintain relevant information

You can configure caching with the following options:

```yaml
- name: AI Code Reviewer
  uses: gauravkrp/ai-code-reviewer@main
  with:
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    # Cache configuration
    CACHE_ENABLED: "true"  # Optional: Enable/disable caching (default: true)
    CACHE_KEY_PREFIX: "my-repo-"  # Optional: Custom prefix for cache keys (default: ai-review-)
    CACHE_TTL_DAYS: "14"  # Optional: Days to keep cache entries (default: 7)
```

Caching is enabled by default but can be disabled by setting `CACHE_ENABLED: "false"` if needed.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub
Action.

Let the maintainer generate the final package (`yarn build` & `yarn package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
