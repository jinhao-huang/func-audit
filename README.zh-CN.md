# func-audit

[English](README.md)

func-audit 用于检查本地数据集中的 C 或 C++ 函数。每次运行时，CLI 会把选定的函数发给你配置的模型。输出的 JSON 报告说明模型是否发现潜在漏洞，并给出判断理由和引用的源码。数据集中的标签和提交链接保留在本地。

## 配置运行环境

安装 mise 后，在仓库根目录运行以下命令。

```sh
mise trust
mise install
mise run setup
```

这些命令会安装项目指定版本的 Node.js、pnpm 和项目依赖。首次运行 `mise run setup` 会创建 `mise.local.toml`。Git 会忽略这个文件，再次运行 setup 也会保留已有配置。

打开 `mise.local.toml`，在 `[env]` 下取消 `FUNC_AUDIT_API_KEY` 这一行的注释，填入项目的 API 密钥。也可以在 shell 中导出同名环境变量。默认 API 地址是 `https://api.deepseek.com`，默认模型是 `deepseek-flash`。

如果使用其他兼容 OpenAI 的服务，在同一个 `[env]` 下设置 API 根地址和服务接受的模型 ID。如果服务要求路径包含 `/v1`，请把它写进根地址。CLI 会在根地址后追加 `/chat/completions`。

```toml
FUNC_AUDIT_BASE_URL = "https://gateway.example/v1"
FUNC_AUDIT_MODEL = "team/custom-deployment"
```

## 检查一个函数

CLI 从 `test.jsonl` 读取数据，每行一个 JSON 对象。`idx` 是非负整数，`func` 是包含函数源码的非空字符串。要试跑一次，可以将下面这行保存为 `test.jsonl`。

```json
{"idx":1,"func":"int identity(int value) {\n  return value;\n}"}
```

把命令中的 `/path/to/dataset` 换成存放 `test.jsonl` 的目录。`--idx 1` 选中上面的样本。

```sh
mise exec -- pnpm --silent audit:one --dataset-dir /path/to/dataset --idx 1
```

报告中的 `idx` 和 `model` 分别记录样本编号和所用模型。`prediction` 为 `1` 表示模型发现了潜在漏洞，为 `0` 表示模型在这个函数中未发现漏洞。`reason` 给出判断理由。`evidence` 中的每条记录都包含源码片段 `source` 及其起止行号 `startLine` 和 `endLine`。行号从函数的第 1 行算起，包含首尾两行。要保存报告，在命令末尾加上 `> report.json`。
