# func-audit

[English](README.md)

func-audit 按对评测课程数据集中的 C 或 C++ 函数。每个函数有独立的模型会话和审计报告，两份预测按课程规则一起评分。工作台和命令行都可以提交评测。

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

## 提交课程评测

把课程测试集放在 `data/raw/test.jsonl`。如需检索历史案例，把知识库放在 `data/raw/knowledge.jsonl`。课程原版脚本 `evaluation.py` 可以放在同一目录供查阅。`data/prepared/` 存放评测用的输入，`data/results/` 存放审计结果。Git 忽略整个 `data/` 目录。

首次审计前先运行 `prepare`。测试集或知识库有改动时，重新运行即可。

```sh
mise run prepare
mise run audit 1
```

`prepare` 校验相邻的两条样本，将两侧的函数和审计所需字段写入 `data/prepared/pairs.jsonl` 的同一行。如果提供了知识库，命令还会排除 `commit_url` 出现在测试集中的案例，将其余记录写入 `data/prepared/knowledge.eval.jsonl`。

`audit` 接受单个对号、用逗号分隔的范围（如 `1-10,15`），或表示全部样本对的 `all`。提交成功后，命令输出运行号、样本对数和报告数，例如 `{"id":3,"pairs":11,"reports":22}`，随后退出。评测在后台继续。同一批中重复出现的样本 ID 共用一份报告；再次提交会创建新的运行。每个模型会话只接收自己的函数和按需查询的上下文。

CLI 和工作台共用一个后台执行器，默认同时处理两份报告。要调整上限，在 `mise.local.toml` 的 `[env]` 下设置 `FUNC_AUDIT_CONCURRENCY = "4"`。请等队列清空后再修改执行器配置，并重启已打开的开发服务。执行器意外退出后，下次打开工作台或用 CLI 查看运行时，已中断的报告会标记为失败，仍在排队的报告会继续执行。

用运行号查看进度、读取当前评分，或在整批成功后导出预测。

```sh
mise run report 3
mise run score 3
mise run export 3 > data/results/predictions.jsonl
```

每对样本的两份预测齐全后就能评分。**P-C** 表示两侧均判对，**P-R** 表示两侧均判错，**P-V** 表示都判为有漏洞，**P-B** 表示都判为无漏洞。`score` 输出逐对成绩和分类计数，单列等待结果和执行失败的样本对。全部报告成功后可以导出，每个样本 ID 对应一行预测。工作台和命令行共用本地数据库 `data/results/runs.sqlite`。

## 打开工作台

运行 `mise run dev`，打开终端显示的本地地址。选择 **New audit → Course pairs**，输入范围，核对样本对数和报告数后点击 **Start audit**。点击左侧的运行可查看整批进度和逐对成绩，展开样本对可打开报告。**Verdict** 显示判断和理由，**Evidence** 显示引用的源码，**Tools** 可以展开查看调用参数和返回值。关闭页面后评测仍会继续。

临时检查一个函数时，选择 **Single function**，粘贴一条 JSON，例如 `{"idx":1,"func":"int one() { return 1; }"}`。可选的 `target` 取值为 0 或 1，用于核对这份报告的判断。如需运行生产构建，在仓库根目录依次执行 `mise exec -- pnpm build` 和 `mise exec -- pnpm start`。

## 结合仓库源码审计

课程样本带有 `commit_url` 时，运行同一条命令即可从 GitHub 下载临时源码快照，并用 `tar` 解压。`target` 为 `1` 时取修复提交的唯一父版本，为 `0` 时取修复提交本身。CLI 会先在快照中定位函数。版本不可用、找不到函数或匹配到多处时，报告会记录失败原因。如果快照含有仅大小写不同的路径，请将 `TMPDIR` 设为区分大小写的卷上已有的目录。样本没有提交链接时，CLI 会跳过快照。

Pi 用 `grep(pattern)` 搜索整个快照，传入可选的 `path` 可将范围缩小到目录或单个文件。需要看原文时，Pi 用 `read(path, startLine, endLine)` 读取指定行。引用仓库源码的证据带有相对路径 `path`，行号从文件开头算起。报告的 `context.snapshot` 记录版本和函数位置，`context.lookups` 保存工具参数、返回的原文或错误。列表为空表示本次没有执行仓库查询。模型看不到样本标签和修复提交链接。

## 使用历史案例

首次调用 `search_cases` 时会在 `data/prepared/` 中创建 SQLite FTS5 索引 `knowledge.eval.jsonl.sqlite`，因此目录需要可写。后续审计复用索引，知识库文件大小或修改时间变化时会自动重建。目录里没有评测副本时，CLI 会跳过案例检索。

Pi 读到需要参考历史案例的代码时，可以调用 `search_cases(query)`，用 API 名称、简短的英文描述或 CWE 编号查询。检索范围包括历史函数、漏洞描述、提交说明及 CVE、CWE 编号。结果按 BM25 排序，每个 CVE 只保留排名最高的一条，每次最多返回三个不同 CVE 的案例。

报告的 `context.caseSearches` 按执行顺序保存 Pi 的查询，列表为空表示 Pi 没有调用检索工具。查询失败时，`error` 记录失败原因。每条结果都包含从 1 开始的评测副本行号、CVE、CWE、描述、提交说明（`commitMessage`）和源码摘录。提交说明过长时，优先摘录命中词附近的原文。`hits` 为空表示这次没有找到符合条件的案例。历史案例供分析时参考，报告中的证据仍须引用当前函数或快照源码。
