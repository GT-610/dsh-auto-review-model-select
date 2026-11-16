[English](README.en-US.md)

# dsh-auto-review-model-select

让 DeepSeek Harness 的「自动审查」改用指定模型，并把不合规的裁决输出就地修正。

## 为什么需要

DSH 的 Auto review 是**逐调用**的模型授权门：每次工具调用执行前，都会用当前 agent 最近一次请求的 provider/model 再问一次模型。它有两个硬约束：

- **路由写死**：reviewer 读的是 `session.requestHeader().config`，所以永远跟着主模型走，没有配置项。
- **协议很窄**：回复必须是「0..n 个 reasoning 块 + 恰好 1 个 text 块」，text 里是六种合法 JSON 形状之一，且 finish 必须是 `stop`。通用模型经常带前后缀、代码围栏、给 `allow` 加 `reason`，或输出被 `max-tokens` 截断——这些都会变成 `AUTO_REVIEW_FAILED`，**调用被拦下且不会重试，也不会转人工**。

这个插件解决第二类问题，并顺带把路由变成可配置的。

## 它做什么

1. **换审查模型**：把 `auto-review` 请求重新派发到你指定的 provider/model（留空则跟随主模型）。
2. **格式提醒**：在 reviewer 的 system prompt 末尾再强调一次 JSON 协议。
3. **修复输出**：在流层面把回复归一化——容忍夹叙、代码围栏、多余 `reason`、`low + deny`、`high + allow`、`max-tokens` 截断、甚至被写成 tool call 的裁决。
4. **失败兜底**：确实读不出裁决时，默认降级为 `medium + deny`，在 `ask` 审批策略下变成一次普通审批弹窗，而不是让工具调用直接失败。

## 安装

需要 DSH `>= 0.2.2-rc.1`；构建和测试需要 Node.js `>= 22.19.0`。

尚未发布到 npm，从 GitHub 安装：

```sh
dsh plugin --profile <profile> add github:GT-610/dsh-auto-review-model-select
```

也可以克隆后安装本地目录：

```sh
git clone https://github.com/GT-610/dsh-auto-review-model-select
dsh plugin --profile <profile> add /path/to/dsh-auto-review-model-select
```

装好后重启 DSH。`dist/` 随仓库提交，从 git 安装无需放行构建脚本；本地包也可以在「设置 → 插件」里安装。

安装后，设置位置：**设置 → 插件 → 自动审查模型 → 配置**。

### 本地开发

```sh
pnpm install
pnpm build       # 改了源码后重建 dist/
```

把仓库链接进 profile 的 `node_modules`：

```sh
# macOS / Linux
ln -s "$PWD" ~/.dsh/profiles/<profile>/node_modules/dsh-auto-review-model-select
```

```powershell
# Windows
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-auto-review-model-select" -Target (Get-Location)
```

之后运行 `pnpm dev`（`tsdown --watch`）。客户端改动刷新页面即可；Host 半边（`src/index.ts`、`src/repair.ts`）改动需要重启 DSH。

## 配置

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关 |
| `provider` | `""` | 审查模型提供方；留空跟随主模型 |
| `model` | `""` | 审查模型 id；留空跟随主模型 |
| `reasoningEffort` | `""` | 审查时的推理强度；留空用模型默认 |
| `hint` | `true` | 是否追加格式提醒 |
| `repair` | `true` | 是否归一化裁决输出 |
| `retry` | `1` | 完全读不出裁决时重问几次（0–2） |
| `fallback` | `"deny"` | 仍读不出时：`deny` 转人工审批，`fail` 让调用失败 |

`provider` 和 `model` 要一起填写：只填其中一个时按「跟随主模型」处理，不会只换一半。

也可以直接写在 `cordis.patch.yml` 的插件行里；设置页改的是同一份配置（字段是 volatile 的，改完下一次审查即生效，不重启插件）。

## 原理

- 监听 `llm/stream` waterfall，只处理 `purpose === 'auto-review'` 的请求。
- waterfall 不能原地改请求（gate 传进来的 options 是 deep-frozen 的），所以复制一份重新 `ctx.llm.stream()`；用 `WeakSet` 标记自己派发的请求，避免递归。
- 输出侧缓冲文本与 tool-call 参数、原样转发 reasoning/usage、丢弃 text 与 tool 块，最后合成「1 个 text 块 + `stop`」。用的是 gate 自己那套 `BlockAssembler` 能接受的形状。
- 解析顺序：先整段 `JSON.parse`；失败则扫描文本里平衡的 `{}`/`[]`（代码围栏、夹叙、数组包装都在这一步被顺带容忍），取最后一个合法形状。
- 归一化：`allow` 一律去掉 `reason`；`low + deny` 变 `medium + deny`（保留拒绝）；`high + allow` 变 `high + deny`（fail-closed）。

## 已知限制

- 只改审查请求，不影响主模型，也不改变 Auto 模式本身的沙箱与审批语义。
- 换到另一个 provider 会丢掉审查请求的前缀缓存，长会话下审查成本会上升。
- `run_code` 程序内部的直接 Node 副作用本来就不在 Auto review 范围内，本插件也不覆盖。
- `retry` 每次最多追加 2 次审查请求，长会话下会放大审查成本。

## 开发

```sh
pnpm install
pnpm check   # 类型检查 + 代码检查 + 构建 + 单元测试 + 产物纯净度 + 语言卡片
pnpm test    # 重新构建客户端产物并跑测试
```

`dist/` 随仓库提交，CI 会重新构建并比对，产物漂移直接失败。

客户端产物只能 `require` 外壳冻结模块表里的模块；`scripts/check-client-purity.mjs` 读取构建结果拒绝越界请求——这类错误不会在类型检查或测试阶段暴露，只会在运行时静默失效。

## 兼容性

- 仅换审查请求的路由与裁决输出，不改变主模型、Auto 沙箱或审批语义。
- 与 DSH 自带的 `dsh-experimental-auto-review` 配合工作，不替换它。
- 设置页文案跟随 DSH 界面的语言。

## 许可

[MIT](LICENSE)
