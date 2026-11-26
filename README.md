# func-audit

[简体中文](README.zh-CN.md)

Audit a course pair of C or C++ functions and grade the two predictions together. Each function gets its own model session, source evidence, and report. Use the local workspace or the CLI.

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

## Submit a course evaluation

Place the course dataset at `data/raw/test.jsonl`. For historical case retrieval, add `data/raw/knowledge.jsonl`. You can keep the original course script `evaluation.py` alongside it for reference. Generated inputs go in `data/prepared/` and audit outputs in `data/results/`. Git ignores the entire `data/` directory.

Run `prepare` before the first audit and whenever either input changes.

```sh
mise run prepare
mise run audit 1
```

`prepare` writes each validated pair of adjacent samples to one line of `data/prepared/pairs.jsonl`, including both functions. If the knowledge file is present, it also writes `data/prepared/knowledge.eval.jsonl`, excluding cases whose `commit_url` appears in the test set.

`audit` accepts a pair number, a comma-separated selection such as `1-10,15`, or `all`. It prints a receipt such as `{"id":3,"pairs":11,"reports":22}` and exits while the evaluation continues. Within a run, repeated sample IDs share one report. Resubmitting creates a new run. Each model session sees only its own function and the context it requests.

The CLI and workspace share a background executor. The default limit is two simultaneous reports across all runs. To change it, set `FUNC_AUDIT_CONCURRENCY = "4"` under `[env]` in `mise.local.toml`. Change executor settings after the queue drains and restart any open development server. If the executor stops unexpectedly, the next CLI status check or workspace visit marks interrupted reports as failed and resumes queued work.

Use the run ID to inspect progress, read the latest grades, or export the finished evaluation:

```sh
mise run report 3
mise run score 3
mise run export 3 > data/results/predictions.jsonl
```

Each pair with two completed predictions receives a grade. **P-C** means both correct, **P-R** both reversed, **P-V** both predicted vulnerable, and **P-B** both predicted benign. `score` returns per-pair results and counts, including pending and failed pairs. Export requires all reports to succeed and writes one JSON line per distinct sample ID. The CLI and workspace store runs in `data/results/runs.sqlite`.

## Open the workspace

Run `mise run dev` and open the local URL. In **New audit → Course pairs**, enter a selection and check the pair and report counts before choosing **Start audit**. Select a run for live progress and grades. Expand a pair to open its reports. Active reports open on **Timeline**. Expand a tool call to inspect its arguments and result as they arrive. Finished reports open on **Verdict**. Select a citation in the verdict, timeline, or **Evidence** tab to jump to the corresponding lines in the submitted function or snapshot read. Closing the tab lets the audit continue in the background.

For an ad hoc review, select **Single function** and paste a JSON object such as `{"idx":1,"func":"int one() { return 1; }"}`. An optional binary `target` lets you compare that prediction with its reference label. To serve a production build locally, run `mise exec -- pnpm build` followed by `mise exec -- pnpm start`.

## Review with repository context

For course samples with a `commit_url`, the same audit command downloads a temporary source snapshot from GitHub and extracts it with `tar`. A `target` of `1` selects the repair commit's sole parent, and `0` selects the repair commit. The CLI verifies the function's location before contacting the model. An unavailable revision, missing function, or ambiguous match fails the report. If the archive contains paths that differ only by case, set `TMPDIR` to an existing directory on a case-sensitive volume. Samples without a commit URL skip the snapshot.

Pi can use `grep(pattern)` across the snapshot, optionally limiting `path` to a directory or file. It can read specific lines with `read(path, startLine, endLine)`. A snapshot citation includes its relative `path` and uses file line numbers. The report's `context.snapshot` identifies the revision and function location. `context.lookups` preserves the tool arguments and returned text, including failed lookups. An empty list means no snapshot lookup ran. The model receives neither the dataset label nor the repair commit URL.

## Use historical cases

The first call to `search_cases` builds a SQLite FTS5 index in `knowledge.eval.jsonl.sqlite` in `data/prepared/`, which must be writable. The CLI reuses the index until the knowledge file's size or modification time changes. Without the evaluation copy, the audit skips case retrieval.

When Pi needs a historical example, it can call `search_cases(query)`, using an API name, a short description, or a CWE. BM25 ranks matches across historical functions, descriptions, commit messages, and CVE/CWE identifiers. Each search returns up to three distinct CVEs, keeping the highest-ranked match for each.

`context.caseSearches` records Pi's queries in order. An empty list means Pi did not search. A failed query includes an `error` field. Each hit includes its one-based line in `knowledge.eval.jsonl`, CVE, CWE, description, commit message (`commitMessage`), and code excerpt. Long commit messages are excerpted, favoring matching terms. An empty `hits` array means the search returned no eligible cases. Historical examples can guide the review, but every evidence citation must refer to the function or its snapshot.
