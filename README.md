# func-audit

[简体中文](README.zh-CN.md)

Review one C or C++ function from a local dataset for potential vulnerabilities. The CLI sends the selected function to your configured model and prints a JSON report with the model's verdict, its reasoning, and excerpts from the function. Dataset labels and commit URLs stay local.

## Set up the CLI

With mise installed, run these commands from the repository root:

```sh
mise trust
mise install
mise run setup
```

This installs the pinned Node.js and pnpm versions and the project dependencies. Setup also creates `mise.local.toml`, which Git ignores. Running setup again preserves your settings.

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

The report includes `idx`, `model`, `prediction`, `reason`, and `evidence`. A prediction of `1` means the model identified a potential vulnerability. A `0` means it found none in the supplied function. Each evidence entry includes the original `source` excerpt and its inclusive `startLine` and `endLine`, counting from 1 within the function. To save the report, append `> report.json` to the command.
