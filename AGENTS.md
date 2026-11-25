# Repository Guidelines

## Project Structure

This CLI reviews one C or C++ function from a local JSONL dataset. Use `src/audit-one.ts` for argument parsing, sample selection, and JSON output. Use `src/review.ts` for the Pi session, review prompt, and evidence validation.

Pass only the selected row's `func` to `reviewFunction`. The CLI attaches `idx` to the finished report. Keep labels and commit URLs outside the model session. Keep course datasets, credentials, and generated reports out of Git.

## Local Development

Run these commands from the repository root.

1. `mise install` installs the Node.js and pnpm versions pinned in `mise.toml`.
2. `mise run setup` creates a gitignored `mise.local.toml` and installs dependencies from the lockfile. Running it again preserves your settings.
3. `mise exec -- pnpm check` type-checks the source. Node runs the TypeScript entry point directly.

Set `FUNC_AUDIT_API_KEY` in the shell or uncomment it in `mise.local.toml`. To use an OpenAI-compatible gateway, set its API root (including any `/v1` prefix) and the exact model or deployment ID it accepts.

```toml
[env]
FUNC_AUDIT_API_KEY = "<project API key>"
FUNC_AUDIT_BASE_URL = "https://gateway.example/v1"
FUNC_AUDIT_MODEL = "team/custom-deployment"
```

The CLI appends `/chat/completions` to the API root and sends the model ID verbatim. The defaults use DeepSeek's official endpoint and `deepseek-flash` (V4.1 Flash). Point the CLI at the directory containing `test.jsonl` to print a report to stdout.

```sh
mise exec -- pnpm audit:one --dataset-dir "$HOME/Downloads/dataset" --idx 194963
```

## Coding Style

Indent TypeScript with two spaces. Use double quotes, semicolons, and camelCase for functions and variables. Use `.ts` extensions for relative imports and `node:` for built-in modules.

## Verification

Run `mise exec -- pnpm test` to check API configuration with a simulated model response. For argument changes, try `mise exec -- pnpm audit:one --help` and check that a missing sample exits with a nonzero status. For report changes, compare each evidence excerpt with the original function using one-based, inclusive line numbers. An out-of-range or whitespace-only citation must fail validation.

## Commits and Pull Requests

Use an imperative subject with a Conventional Commit prefix, following `feat: add single-function audit CLI with Pi`. In a pull request, describe the behavior change and how you verified it. For CLI changes, include the command and the relevant output or exit status.
