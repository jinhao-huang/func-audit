# func-audit

[简体中文](README.zh-CN.md)

Review one C or C++ function from a local dataset for potential vulnerabilities. The CLI sends the function and any requested source excerpts to your configured model. It prints a JSON report with the verdict, reasoning, and cited lines.

## Set up the CLI

With mise installed, run these commands from the repository root:

```sh
mise trust
mise install
mise run setup
```

This installs Node.js, pnpm, ripgrep, and the project dependencies. Setup also creates `mise.local.toml`, which Git ignores. Running setup again preserves your settings.

In `mise.local.toml`, uncomment `FUNC_AUDIT_API_KEY` under `[env]` and enter your project API key. You can also export it in your shell. The default endpoint is `https://api.deepseek.com` and the default model is `deepseek-flash`.

To use another OpenAI-compatible endpoint, set these two entries under the same `[env]` heading. Use the API root, including any required `/v1` prefix, and the exact model ID your endpoint accepts. The CLI appends `/chat/completions`.

```toml
FUNC_AUDIT_BASE_URL = "https://gateway.example/v1"
FUNC_AUDIT_MODEL = "team/custom-deployment"
```

## Review a function

The CLI reads `test.jsonl`, with one JSON object per line. Each sample needs a nonnegative integer `idx` and a nonempty `func` string. To try it, save this line in a file named `test.jsonl`:

```json
{"idx":1,"func":"int identity(int value) {\n  return value;\n}"}
```

Pass the directory containing the file and the sample ID:

```sh
mise exec -- pnpm --silent audit:one --dataset-dir /path/to/dataset --idx 1
```

The JSON result includes `id` for this audit, `idx` for the dataset sample, and `model` for the model used. A `prediction` of `1` means the model identified a potential vulnerability. A `0` means it found none in the supplied function. The `reason` explains the verdict. Each `evidence` entry includes the original `source` excerpt and its inclusive `startLine` and `endLine`, counting from 1 within the function for entries without a file path. To save the JSON, append `> report.json` to the command.

## Review with repository context

For course samples with a `commit_url`, the same audit command downloads a temporary source snapshot from GitHub and extracts it with `tar`. A `target` of `1` selects the repair commit's sole parent, and `0` selects the repair commit. The CLI verifies the function's location before contacting the model. An unavailable revision, missing function, or ambiguous match fails the report. If the archive contains paths that differ only by case, set `TMPDIR` to an existing directory on a case-sensitive volume. Samples containing only `idx` and `func` use the function alone.

Pi can use `grep(pattern)` across the snapshot, optionally limiting `path` to a directory or file. It can read specific lines with `read(path, startLine, endLine)`. A snapshot citation includes its relative `path` and uses file line numbers. The report's `context.snapshot` identifies the revision and function location. `context.lookups` preserves the tool arguments and returned text, including failed lookups. An empty list means no snapshot lookup ran. The model receives neither the dataset label nor the repair commit URL.

## Reopen a report

Each audit gets its own record in `.func-audit.sqlite` in the project root. To reopen it, replace `1` below with the `id` from the JSON result. If the audit fails after creating the record, the error message includes the ID. An interactive terminal also shows the ID when the audit starts. Reading a report requires only the local database.

```sh
mise exec -- pnpm --silent report:show --id 1
```

The saved JSON record includes the start time, source, model, and status. A `completed` report includes the verdict and evidence. A `failed` report contains the error and a `null` prediction. If the process exits before it can record the outcome, the status remains `started`.
