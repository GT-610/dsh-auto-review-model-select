[English](README.en-US.md) | 中文

# 自动审查模型

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

```sh
dsh plugin --profile desktop add /path/to/dsh-auto-review-model-select
```

或在「设置 → 插件」里安装本地包。**新装的 bundle 需要重启 DSH 才会加载客户端部分。**

安装后，设置位置：**设置 → 插件 → 自动审查模型 → 配置**。

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

也可以直接写在 `cordis.patch.yml` 的插件行里；设置页改的是同一份配置（字段是 volatile 的，改完下一次审查即生效，不重启插件）。

## 原理

- 监听 `llm/stream` waterfall，只处理 `purpose === 'auto-review'` 的请求。
- waterfall 不能原地改请求（gate 传进来的 options 是 deep-frozen 的），所以复制一份重新 `ctx.llm.stream()`；用 `WeakSet` 标记自己派发的请求，避免递归。
- 输出侧缓冲文本与 tool-call 参数、原样转发 reasoning/usage、丢弃 text 与 tool 块，最后合成「1 个 text 块 + `stop`」。用的是 gate 自己那套 `BlockAssembler` 能接受的形状。
- 解析顺序：整段 `JSON.parse` → 剥代码围栏 → 扫描平衡括号里的对象 → 取最后一个合法形状。
- 归一化：`allow` 一律去掉 `reason`；`low + deny` 变 `medium + deny`（保留拒绝）；`high + allow` 变 `high + deny`（fail-closed）。

## 已知限制

- 只改审查请求，不影响主模型，也不改变 Auto 模式本身的沙箱与审批语义。
- 换到另一个 provider 会丢掉审查请求的前缀缓存，长会话下审查成本会上升。
- `run_code` 程序内部的直接 Node 副作用本来就不在 Auto review 范围内，本插件也不覆盖。

## 开发

```sh
pnpm install
pnpm check   # 类型检查 + 构建 + 27 个单元测试
```
