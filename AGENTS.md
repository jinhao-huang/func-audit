# Repository Guidelines

## Project Structure

This CLI reviews one C or C++ function from a local JSONL dataset. Use `src/audit-one.ts` for argument parsing, sample selection, and JSON output. Use `src/review.ts` for the Pi session, review prompt, and evidence validation.

Pass only the selected row's `func` to `reviewFunction`. The CLI attaches `idx` to the finished report. Keep labels and commit URLs outside the model session, and store course datasets, model credentials, and generated reports outside the repository.

## Local Development

Run these commands from the repository root.

1. `mise install` installs the Node.js and pnpm versions pinned in `mise.toml`.
2. `mise exec -- pnpm install --frozen-lockfile` installs dependencies from the lockfile.
3. `mise exec -- pnpm check` type-checks the source. Node runs the TypeScript entry point directly.

To review a sample, configure a model provider in Pi and point the CLI at the directory containing `test.jsonl`. The command prints the report to stdout.

```sh
mise exec -- pnpm audit:one --dataset-dir "$HOME/Downloads/dataset" --idx 194963
```

## Coding Style

Indent TypeScript with two spaces. Use double quotes, semicolons, and camelCase for functions and variables. Use `.ts` extensions for relative imports and `node:` for built-in modules.

## Verification

The project currently uses type checking and targeted CLI runs. For argument changes, try `mise exec -- pnpm audit:one --help` and check that a missing sample exits with a nonzero status. For report changes, compare each evidence excerpt with the original function using one-based, inclusive line numbers. An out-of-range or whitespace-only citation must fail validation.

## Commits and Pull Requests

Use an imperative subject with a Conventional Commit prefix, following `feat: add single-function audit CLI with Pi`. In a pull request, describe the behavior change and how you verified it. For CLI changes, include the command and the relevant output or exit status.
