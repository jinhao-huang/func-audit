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

## Run a course pair

Place the course dataset at `data/raw/test.jsonl`. For historical case retrieval, add `data/raw/knowledge.jsonl`. You can keep the original course script `evaluation.py` alongside it for reference. Generated inputs go in `data/prepared/` and audit outputs in `data/results/`. Git ignores the entire `data/` directory.

Run `prepare` before the first audit and whenever either input changes.

```sh
mise run prepare
mise run audit 1
```

`prepare` writes each validated pair of adjacent samples to one line of `data/prepared/pairs.jsonl`, including both functions. If the knowledge file is present, it also writes `data/prepared/knowledge.eval.jsonl`, excluding cases whose `commit_url` appears in the test set.

`audit 1` runs the first pair in two independent sessions. Each session receives only its own function, requested source excerpts, and retrieved historical cases. The host keeps the reference labels and the other sample outside the session.

The audit prints JSON with the new run `id` and both report summaries. Each retry creates a separate run. If either audit fails, the command exits with an error containing the run ID, and you can still open both reports. To inspect, score, or export a run, use its ID (here, `3`):

```sh
mise run report 3
mise run score 3
mise run export 3 > data/results/predictions.jsonl
```

The project calculates the course grade from the two reference labels and predictions saved with the run. It returns **P-C** for both correct, **P-R** for both reversed, **P-V** for both predicted vulnerable, and **P-B** for both predicted benign. Scoring and export require two completed reports. The export contains one `{"idx":...,"prediction":...}` record per sample. The CLI and workspace store runs in `data/results/runs.sqlite`.

## Open the workspace

Run `mise run dev` and open the local URL. Select **New audit → Course pair**, enter the pair number, and choose **Start audit**. Select a run to see its progress and course grade. Expand it to open either report. **Verdict** shows the prediction and reasoning, **Evidence** shows the cited source lines, and **Tools** shows each call's arguments and output. You can close the tab while the server works and reopen it later.

For an ad hoc review, select **Single function** and paste a JSON object such as `{"idx":1,"func":"int one() { return 1; }"}`. An optional binary `target` lets you compare that prediction with its reference label. To serve a production build locally, run `mise exec -- pnpm build` followed by `mise exec -- pnpm start`.

## Review with repository context

For course samples with a `commit_url`, the same audit command downloads a temporary source snapshot from GitHub and extracts it with `tar`. A `target` of `1` selects the repair commit's sole parent, and `0` selects the repair commit. The CLI verifies the function's location before contacting the model. An unavailable revision, missing function, or ambiguous match fails the report. If the archive contains paths that differ only by case, set `TMPDIR` to an existing directory on a case-sensitive volume. Samples without a commit URL skip the snapshot.

Pi can use `grep(pattern)` across the snapshot, optionally limiting `path` to a directory or file. It can read specific lines with `read(path, startLine, endLine)`. A snapshot citation includes its relative `path` and uses file line numbers. The report's `context.snapshot` identifies the revision and function location. `context.lookups` preserves the tool arguments and returned text, including failed lookups. An empty list means no snapshot lookup ran. The model receives neither the dataset label nor the repair commit URL.

## Use historical cases

The first call to `search_cases` builds a SQLite FTS5 index in `knowledge.eval.jsonl.sqlite` in `data/prepared/`, which must be writable. The CLI reuses the index until the knowledge file's size or modification time changes. Without the evaluation copy, the audit skips case retrieval.

When Pi needs a historical example, it can call `search_cases(query)`, using an API name, a short description, or a CWE. BM25 ranks matches across historical functions, descriptions, commit messages, and CVE/CWE identifiers. Each search returns up to three distinct CVEs, keeping the highest-ranked match for each.

`context.caseSearches` records Pi's queries in order. An empty list means Pi did not search. A failed query includes an `error` field. Each hit includes its one-based line in `knowledge.eval.jsonl`, identifiers, a description, and a code excerpt. An empty `hits` array means the search returned no eligible cases. Historical examples can guide the review, but every evidence citation must refer to the function or its snapshot.
