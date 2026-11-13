[中文](README.md)

# dsh-auto-review-model-select

Route DeepSeek Harness Auto review to a chosen model and normalize decision output that breaks the reviewer protocol.

## Why

Auto review is a per-call model gate: before every tool call it asks one extra model, using the provider and model of the agent's latest request. Two constraints follow:

- **Fixed route.** The reviewer reads `session.requestHeader().config`, so it always inherits the main model, and there is no setting for it.
- **Narrow protocol.** The reply must be zero or more reasoning blocks plus exactly one text block holding one of six legal JSON shapes, with a `stop` finish. General-purpose models regularly wrap the object in prose or a code fence, attach a `reason` to `allow`, or get truncated by `max-tokens` — each of those becomes `AUTO_REVIEW_FAILED`, which blocks the call, is not retried, and is not escalated to a human.

This plugin fixes the second problem and makes the route configurable.

## What it does

1. **Reviewer model.** Re-dispatches the `auto-review` request to a configured provider/model; leave both empty to follow the main model.
2. **Format reminder.** Repeats the JSON contract at the end of the reviewer system prompt.
3. **Output repair.** Normalizes the reply stream: prose, code fences, an unexpected `reason`, `low + deny`, `high + allow`, a `max-tokens` cut, or a decision emitted as a tool call.
4. **Fail-closed fallback.** When no decision can be read, it degrades to `medium + deny`, which under the `ask` approval policy becomes an ordinary approval prompt instead of a failed tool call.

## Install

```sh
dsh plugin --profile desktop add /path/to/dsh-auto-review-model-select
```

Or install the local package from Settings → Plugins. **A newly installed bundle needs a DSH restart before its client half loads.**

Settings live at **Settings → Plugins → Auto review model → Configuration**.

## Configuration

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `provider` | `""` | Reviewer provider; empty follows the main model |
| `model` | `""` | Reviewer model id; empty follows the main model |
| `reasoningEffort` | `""` | Reasoning effort for reviews; empty uses the model default |
| `hint` | `true` | Append the format reminder |
| `repair` | `true` | Normalize the decision output |
| `retry` | `1` | Extra attempts when nothing readable comes back (0–2) |
| `fallback` | `"deny"` | Still unreadable: `deny` asks the user, `fail` lets the call fail |

`provider` and `model` must be set together: setting only one follows the main model rather than switching half the route.

The same fields can be set on the plugin row in `cordis.patch.yml`; the settings card edits that same configuration. Fields are volatile, so a change applies to the next reviewed call without restarting the plugin.

## How it works

- Listens on the `llm/stream` waterfall and only handles `purpose === 'auto-review'`.
- The waterfall cannot mutate a request in place (the gate hands in deep-frozen options), so the plugin copies the options and calls `ctx.llm.stream()` again. A `WeakSet` marks its own dispatches so the listener lets them through.
- On the output side it buffers text and tool-call arguments, forwards reasoning and usage, drops text and tool blocks, and emits one text block plus a synthetic `stop` — the shape the gate's own `BlockAssembler` accepts.
- Parsing order: whole-text `JSON.parse` first; if that fails, scan the balanced `{}`/`[]` runs in the text (which tolerates code fences, prose, and array wrappers along the way) and keep the last legal shape.
- Normalization: `allow` never keeps a `reason`; `low + deny` becomes `medium + deny` (the denial survives); `high + allow` becomes `high + deny` (fail-closed).

## Limitations

- Changes only the review request. The main model, the Auto sandbox, and the approval semantics are untouched.
- Switching to another provider loses the review request's prompt-cache prefix, so long sessions cost more.
- Direct Node side effects inside `run_code` programs were never covered by Auto review, and are not covered here either.
- `retry` adds at most two more reviewer requests per reviewed call, so long sessions cost more.

## Development

```sh
pnpm install
pnpm check   # typecheck + build + unit tests
pnpm test    # rebuild the client artifact, then run the tests
```

## License

[MIT](LICENSE)
