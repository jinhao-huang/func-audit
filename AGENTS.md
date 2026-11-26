# Repository Guidelines

## Project Structure

Keep CLI parsing and output in `src/audit-one.ts`. The CLI and the web worker share `src/audit.ts`. Keep HTTP handling in `app/routes/` and use shadcn/ui components for the workspace. Use `src/review.ts` for the Pi session, review prompt, and evidence validation. Keep model selection and credential loading in `src/project-api.ts`.

Keep sample selection and revision selection in the host. Give Pi the selected function, its relative location, and read-only tools scoped to that snapshot. Keep labels, commit URLs, revision IDs, and other versions outside the session. The CLI attaches `idx` to the finished report. Keep course datasets, credentials, and generated reports out of Git.

Preserve isolation from personal Pi settings and provider credentials when changing the API integration. Use the [README](README.md) for local setup. Update both language versions when a change affects configuration, workspace or CLI usage, or the report format.

## Coding Style

Indent TypeScript with two spaces. Use double quotes, semicolons, and camelCase for functions and variables. Use `.ts` extensions for relative imports and `node:` for built-in modules.

## Verification

Run `mise exec -- pnpm check` to type-check the source and `mise exec -- pnpm test` to check API configuration with a simulated model response. For workspace changes, run `mise exec -- pnpm test:web` to exercise submission, reconnection, and result download against a local mock. For argument changes, try `mise exec -- pnpm audit:one --help` and check that a missing sample exits with a nonzero status. For report changes, compare each evidence excerpt with the original function using one-based, inclusive line numbers. An out-of-range or whitespace-only citation must fail validation.

## Commits and Pull Requests

Use an imperative subject with a Conventional Commit prefix, following `feat: add single-function audit CLI with Pi`. In a pull request, describe the behavior change and how you verified it. For CLI changes, include the command and the relevant output or exit status.
