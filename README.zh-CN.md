# func-audit

[English](README.md)

func-audit 用于检查本地数据集中的 C 或 C++ 函数。CLI 把选定的函数和模型按需读取的源码片段发给你配置的模型。输出的 JSON 报告说明模型是否发现潜在漏洞，并给出判断理由和引用的源码。

## 配置运行环境

安装 mise 后，在仓库根目录运行以下命令。

```sh
mise trust
mise install
mise run setup
```

这些命令会安装项目指定版本的 Node.js、pnpm、ripgrep 和项目依赖。首次运行 `mise run setup` 会创建 `mise.local.toml`。Git 会忽略这个文件，再次运行 setup 也会保留已有配置。

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

输出的 JSON 中，`id` 是本次审计的报告编号，`idx` 是数据集中的样本编号，`model` 是所用模型。`prediction` 为 `1` 表示模型发现了潜在漏洞，为 `0` 表示模型在这个函数中未发现漏洞。`reason` 给出判断理由。`evidence` 中的每条记录都包含源码片段 `source` 及其起止行号 `startLine` 和 `endLine`。引用不带文件路径时，行号从函数的第 1 行算起，包含首尾两行。要保存 JSON，在命令末尾加上 `> report.json`。

## 结合仓库源码审计

课程样本带有 `commit_url` 时，运行同一条命令即可从 GitHub 下载临时源码快照，并用 `tar` 解压。`target` 为 `1` 时取修复提交的唯一父版本，为 `0` 时取修复提交本身。CLI 会先在快照中定位函数。版本不可用、找不到函数或匹配到多处时，报告会记录失败原因。如果快照含有仅大小写不同的路径，请将 `TMPDIR` 设为区分大小写的卷上已有的目录。只含 `idx` 和 `func` 的样本仍可单独审计。

Pi 用 `grep(pattern)` 搜索整个快照，传入可选的 `path` 可将范围缩小到目录或单个文件。需要看原文时，Pi 用 `read(path, startLine, endLine)` 读取指定行。引用仓库源码的证据带有相对路径 `path`，行号从文件开头算起。报告的 `context.snapshot` 记录版本和函数位置，`context.lookups` 保存工具参数、返回的原文或错误。列表为空表示本次没有执行仓库查询。模型看不到样本标签和修复提交链接。

## 按 ID 查看报告

每次审计都会在项目根目录的 `.func-audit.sqlite` 中生成一条独立记录。把下面命令里的 `1` 换成 JSON 结果中的 `id`，即可从本地数据库读取报告。如果创建记录后审计失败，可以从错误信息里找到 ID。在交互终端运行时，审计一开始就能看到这个 ID。

```sh
mise exec -- pnpm --silent report:show --id 1
```

保存的 JSON 记录包含开始时间、函数源码、模型和状态。`completed` 表示审计完成，可以查看判断结果和引用的证据。`failed` 表示审计失败，记录中会给出错误原因，预测值为 `null`。如果进程在写入结果前退出，状态会停留在 `started`。
