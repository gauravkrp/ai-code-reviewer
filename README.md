# AI Code Reviewer

AI Code Reviewer is a GitHub Action that leverages OpenAI's GPT-4 or Anthropic's Claude models to provide intelligent feedback and suggestions on
your pull requests. This powerful tool helps improve code quality and saves developers time by automating the code
review process.

## Features

- Reviews pull requests using OpenAI's GPT-4 or Anthropic's Claude models.
- Provides intelligent comments and suggestions for improving your code.
- Filters out files that match specified exclude patterns.
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
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: freeedcom/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "openai" # Optional: defaults to "openai"
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          OPENAI_API_MODEL: "gpt-4-1106-preview" # Optional: defaults to "gpt-4"
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
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
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: freeedcom/ai-codereviewer@main
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          AI_PROVIDER: "anthropic"
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          ANTHROPIC_API_MODEL: "claude-3-7-sonnet-20250219" # Optional: defaults to "claude-3-7-sonnet-20250219"
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
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
        uses: freeedcom/ai-codereviewer@main
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
```

4. Customize the `exclude` input if you want to ignore certain file patterns from being reviewed.

5. Commit the changes to your repository, and AI Code Reviewer will start working on your future pull requests.

## How It Works

The AI Code Reviewer GitHub Action retrieves the pull request diff, filters out excluded files, and sends code chunks to
the selected AI provider (OpenAI or Anthropic). It then generates review comments based on the AI's response and adds them to the pull request.

## Contributing

Contributions are welcome! Please feel free to submit issues or pull requests to improve the AI Code Reviewer GitHub
Action.

Let the maintainer generate the final package (`yarn build` & `yarn package`).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for more information.
