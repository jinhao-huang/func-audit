# func-audit

[简体中文](README.zh-CN.md)

Review one C or C++ function from a local dataset for potential vulnerabilities. Use the local web workspace or the CLI. Both send the function, retrieved historical cases, and requested source excerpts to your configured model and save the verdict, reasoning, and cited lines.

## Set up

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

## Open the audit workspace

From the repository root, run:

```sh
mise exec -- pnpm dev
```

Open the local URL printed in the terminal. Choose **New audit**, enter a sample ID from `data/test.jsonl` or paste a JSON sample with `idx` and `func`, then choose **Start audit**. An optional `target` (`1` for vulnerable, `0` for benign) lets the workspace grade the prediction. The model never receives this label.

Select a task to see its **Verdict**, cited **Evidence**, or **Tools**. Expand a tool call to inspect its arguments and output. You can close the tab while the server runs and reopen the report from the task list. **Download result.jsonl** exports a completed prediction for the course grader. The CLI and workspace share the same report database. To run the production build locally, use `mise exec -- pnpm build` followed by `mise exec -- pnpm start` from the repository root.

## Review a function

The CLI reads `test.jsonl`, with one JSON object per line. Each sample needs a nonnegative integer `idx` and a nonempty `func` string. To try it, save this line in a file named `test.jsonl`:

```json
{"idx":1,"func":"int identity(int value) {\n  return value;\n}"}
```

Pass the directory containing the file and the sample ID. For a course dataset stored in the repository's Git-ignored `data/` directory, use `--dataset-dir ./data` and an ID from its `test.jsonl`.

```sh
mise exec -- pnpm --silent audit:one --dataset-dir /path/to/dataset --idx 1
```

The JSON result includes `id` for this audit, `idx` for the dataset sample, and `model` for the model used. A `prediction` of `1` means the model identified a potential vulnerability. A `0` means it found none in the supplied function. The `reason` explains the verdict. Each `evidence` entry includes the original `source` excerpt and its inclusive `startLine` and `endLine`, counting from 1 within the function for entries without a file path. To save the JSON, append `> report.json` to the command.

## Review with repository context

For course samples with a `commit_url`, the same audit command downloads a temporary source snapshot from GitHub and extracts it with `tar`. A `target` of `1` selects the repair commit's sole parent, and `0` selects the repair commit. The CLI verifies the function's location before contacting the model. An unavailable revision, missing function, or ambiguous match fails the report. If the archive contains paths that differ only by case, set `TMPDIR` to an existing directory on a case-sensitive volume. Samples without a commit URL skip the snapshot.

Pi can use `grep(pattern)` across the snapshot, optionally limiting `path` to a directory or file. It can read specific lines with `read(path, startLine, endLine)`. A snapshot citation includes its relative `path` and uses file line numbers. The report's `context.snapshot` identifies the revision and function location. `context.lookups` preserves the tool arguments and returned text, including failed lookups. An empty list means no snapshot lookup ran. The model receives neither the dataset label nor the repair commit URL.

## Use historical cases

Place `knowledge.eval.jsonl` beside `test.jsonl` and run the same audit command. For the 7,578-row course release, prepare this copy once from the dataset directory. Lines 3643 and 3644 share a repair commit with test sample 187732.

```sh
awk 'NR != 3643 && NR != 3644' knowledge.jsonl > knowledge.eval.jsonl
```

The first call to `search_cases` builds a SQLite FTS5 index in `knowledge.eval.jsonl.sqlite` in the dataset directory, which must be writable. The CLI reuses the index until the knowledge file's size or modification time changes. Without the evaluation copy, the audit skips case retrieval.

When Pi needs a historical example, it can call `search_cases(query)`, using an API name, a short description, or a CWE. BM25 ranks matches across historical functions, descriptions, commit messages, and CVE/CWE identifiers. Each search returns up to three distinct CVEs, keeping the highest-ranked match for each.

`context.caseSearches` records Pi's queries in order. An empty list means Pi did not search. A failed query includes an `error` field. Each hit includes its one-based line in `knowledge.eval.jsonl`, identifiers, a description, and a code excerpt. An empty `hits` array means the search returned no eligible cases. Historical examples can guide the review, but every evidence citation must refer to the function or its snapshot.

## Reopen a report

Each audit gets its own record in `.func-audit.sqlite` in the project root. To reopen it, replace `1` below with the `id` from the JSON result. If the audit fails after creating the record, the error message includes the ID. An interactive terminal also shows the ID when the audit starts. Reading a report requires only the local database.

```sh
mise exec -- pnpm --silent report:show --id 1
```

The saved JSON record includes the start time, source, model, and status. A `completed` report includes the verdict and evidence. A `failed` report contains the error and a `null` prediction. If an audit process exits before saving a result, the workspace marks the report as failed when it next checks the task.
