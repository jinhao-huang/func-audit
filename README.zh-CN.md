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

## 评测一对课程样本

把课程测试集放在 `data/raw/test.jsonl`。课程原版脚本 `evaluation.py` 可以放在同一目录供查阅。`data/prepared/` 存放评测用的输入，`data/results/` 存放审计结果。Git 忽略整个 `data/` 目录。

首次使用时先生成配对清单。更换数据集或调整记录顺序后，需要重新生成清单。

```sh
mise run prepare
mise run audit 1
```

`prepare` 按课程规则校验相邻记录，将每对样本的两个编号写成 `data/prepared/pairs.jsonl` 中的一行。`audit 1` 选中第 1 对，分别启动两次独立审计。每个会话只接收自己的函数、按需读取的源码和检索到的案例。配对关系和参考标签由宿主管理。

命令输出本次运行的 `id` 和两份报告的摘要。重跑同一对会得到新的运行号。如果一侧失败，命令会以非零状态退出，错误信息里有运行号，两份报告仍可查看。假设这次的运行号是 `3`，可以这样查看、评分和导出：

```sh
mise run report 3
mise run score 3
mise run export 3 > data/results/predictions.jsonl
```

两份报告都完成后，项目按课程规则，用本次保存的标签和预测计算成绩。**P-C** 表示两侧均判对，**P-R** 表示两侧均判错，**P-V** 表示都判为有漏洞，**P-B** 表示都判为无漏洞。导出文件每行包含一条样本的 `idx` 和 `prediction`。工作台和命令行共用本地数据库 `data/results/runs.sqlite`。

## 打开工作台

运行 `mise run dev`，打开终端显示的本地地址。选择 **New audit → Course pair**，输入课程对号，点击 **Start audit**。点击左侧的一次运行可查看完成进度和课程成绩，展开后可以选择其中任一报告。**Verdict** 显示判断和理由，**Evidence** 显示引用的源码，**Tools** 可以展开查看调用参数和返回值。服务运行期间可关闭页面，稍后再打开。

临时检查一个函数时，选择 **Single function**，粘贴一条 JSON，例如 `{"idx":1,"func":"int one() { return 1; }"}`。可选的 `target` 取值为 0 或 1，用于核对这份报告的判断。如需运行生产构建，在仓库根目录依次执行 `mise exec -- pnpm build` 和 `mise exec -- pnpm start`。

## 结合仓库源码审计

课程样本带有 `commit_url` 时，运行同一条命令即可从 GitHub 下载临时源码快照，并用 `tar` 解压。`target` 为 `1` 时取修复提交的唯一父版本，为 `0` 时取修复提交本身。CLI 会先在快照中定位函数。版本不可用、找不到函数或匹配到多处时，报告会记录失败原因。如果快照含有仅大小写不同的路径，请将 `TMPDIR` 设为区分大小写的卷上已有的目录。样本没有提交链接时，CLI 会跳过快照。

Pi 用 `grep(pattern)` 搜索整个快照，传入可选的 `path` 可将范围缩小到目录或单个文件。需要看原文时，Pi 用 `read(path, startLine, endLine)` 读取指定行。引用仓库源码的证据带有相对路径 `path`，行号从文件开头算起。报告的 `context.snapshot` 记录版本和函数位置，`context.lookups` 保存工具参数、返回的原文或错误。列表为空表示本次没有执行仓库查询。模型看不到样本标签和修复提交链接。

## 使用历史案例

运行 `mise run prepare` 后，在仓库根目录执行下面的命令，生成评测用的知识库。这条命令适用于含 7,578 条记录的课程原版。原库第 3643、3644 行与测试样本 187732 来自同一修复提交，生成副本时跳过这两行。

```sh
awk 'NR != 3643 && NR != 3644' data/raw/knowledge.jsonl > data/prepared/knowledge.eval.jsonl
```

首次调用 `search_cases` 时会在 `data/prepared/` 中创建 SQLite FTS5 索引 `knowledge.eval.jsonl.sqlite`，因此目录需要可写。后续审计复用索引，知识库文件大小或修改时间变化时会自动重建。目录里没有评测副本时，CLI 会跳过案例检索。

Pi 读到需要参考历史案例的代码时，可以调用 `search_cases(query)`，用 API 名称、简短的英文描述或 CWE 编号查询。检索范围包括历史函数、漏洞描述、提交说明及 CVE、CWE 编号。结果按 BM25 排序，每个 CVE 只保留排名最高的一条，每次最多返回三个不同 CVE 的案例。

报告的 `context.caseSearches` 按执行顺序保存 Pi 的查询，列表为空表示 Pi 没有调用检索工具。查询失败时，`error` 记录失败原因。每个命中都附有从 1 开始的评测副本行号、CVE、CWE、描述和源码摘录。`hits` 为空表示这次没有找到符合条件的案例。历史案例供分析时参考，报告中的证据仍须引用当前函数或快照源码。
