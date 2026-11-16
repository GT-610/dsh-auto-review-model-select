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
4. **Fail-closed fallback.** When no decision can be read — or when the review request never reached the model at all (a quota, a dropped connection) — it degrades to `medium + deny`, which under the `ask` approval policy becomes an ordinary approval prompt instead of a failed tool call. An unavailable reviewer costs one decision, not every tool call in the turn.

## Install

Requires DSH `>= 0.2.2-rc.1`; building and testing need Node.js `>= 22.19.0`.

Not on npm yet — install from GitHub:

```sh
dsh plugin --profile <profile> add github:GT-610/dsh-auto-review-model-select
```

Or clone it and install the local directory:

```sh
git clone https://github.com/GT-610/dsh-auto-review-model-select
dsh plugin --profile <profile> add /path/to/dsh-auto-review-model-select
```

Restart DSH afterwards. `dist/` is committed, so a git install needs no build script allowed; a local package can also be installed from Settings → Plugins.

Settings live at **Settings → Plugins → Auto review model → Configuration**.

### Local development

```sh
pnpm install
pnpm build       # rebuild dist/ after a source change
```

Link the checkout into the profile's `node_modules`:

```sh
# macOS / Linux
ln -s "$PWD" ~/.dsh/profiles/<profile>/node_modules/dsh-auto-review-model-select
```

```powershell
# Windows
New-Item -ItemType SymbolicLink -Path "$env:USERPROFILE\.dsh\profiles\<profile>\node_modules\dsh-auto-review-model-select" -Target (Get-Location)
```

Then run `pnpm dev` (`tsdown --watch`). A Client change takes effect on a page reload; a Host change (`src/index.ts`, `src/repair.ts`) needs a DSH restart.

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
| `fallback` | `"deny"` | Unreadable reply or failed request: `deny` asks the user, `fail` lets the call fail |

`provider` and `model` must be set together: setting only one follows the main model rather than switching half the route.

The same fields can be set on the plugin row in `cordis.patch.yml`; the settings card edits that same configuration. Fields are volatile, so a change applies to the next reviewed call without restarting the plugin.

## How it works

- Listens on the `llm/stream` waterfall and only handles `purpose === 'auto-review'`.
- The waterfall cannot mutate a request in place (the gate hands in deep-frozen options), so the plugin copies the options and calls `ctx.llm.stream()` again. A `WeakSet` marks its own dispatches so the listener lets them through.
- On the output side it buffers text and tool-call arguments, forwards reasoning and usage, drops text and tool blocks, and emits one text block plus a synthetic `stop` — the shape the gate's own `BlockAssembler` accepts.
- Parsing order: whole-text `JSON.parse` first; if that fails, scan the balanced `{}`/`[]` runs in the text (which tolerates code fences, prose, and array wrappers along the way) and keep the last legal shape.
- Normalization: `allow` never keeps a `reason`; `low + deny` becomes `medium + deny` (the denial survives); `high + allow` becomes `high + deny` (fail-closed).
- Errors: a provider failure (a quota, a dropped connection) is not a protocol problem — there is no reply to read and no format to correct — so it spends no retry and settles through `fallback`, with the failure itself named in the approval prompt. An `aborted` finish passes through untouched, because that is the caller's own cancellation and an approval prompt for it would arrive after the turn was dropped.

## Limitations

- Changes only the review request. The main model, the Auto sandbox, and the approval semantics are untouched.
- Switching to another provider loses the review request's prompt-cache prefix, so long sessions cost more.
- Direct Node side effects inside `run_code` programs were never covered by Auto review, and are not covered here either.
- `retry` adds at most two more reviewer requests per reviewed call, so long sessions cost more.

## Development

```sh
pnpm install
pnpm check   # typecheck + lint + build + unit tests + bundle purity + locale cards
pnpm test    # rebuild the client artifact, then run the tests
```

`dist/` is committed, and CI rebuilds it and compares: a drifted artifact fails the build.

The client artifact may only `require` modules from the shell's frozen module table; `scripts/check-client-purity.mjs` reads the emitted bundle and refuses anything else. That failure never surfaces in typechecking or tests — it only shows up at runtime, silently.

## Compatibility

- Changes the review request route and the decision output only; the main model, the Auto sandbox and the approval semantics stay as shipped.
- Works alongside DSH's own `dsh-experimental-auto-review`; it does not replace it.
- Settings copy follows the language selected in the DSH interface.

## License

[MIT](LICENSE)
