# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [0.1.1] - 2026-11-16

### Fixed

- An unavailable reviewer no longer blocks every tool call. A provider failure
  — a quota, a dropped connection — used to pass straight through as
  `AUTO_REVIEW_FAILED`. That is the worst case for a plugin whose whole point is
  a reviewer of its own: `fallback` only covered a reply that could not be read,
  and a request that never reached the model has no reply at all, so one
  provider outage stopped work until the provider recovered. Such a finish now
  settles through the same `fallback`, and the provider's own code and message
  are named in the approval prompt. `fallback: "fail"` still keeps the original
  failure for anyone who prefers it.

### Notes

- A provider failure spends no retry. The retry sends a format correction, which
  says nothing useful about a request that never ran, and would only double the
  cost of a quota error.
- An `aborted` finish still passes through untouched: that is the caller's own
  cancellation, and an approval prompt for it would arrive after the turn was
  already dropped.

## [0.1.0] - 2026-11-16

### Added

- Route the Auto review request to a chosen provider/model through the
  `llm/stream` waterfall, re-dispatching a copy because the gate's options are
  deep-frozen. Leaving both fields empty keeps the main model as the reviewer.
- Normalize the reviewer reply into the gate's closed protocol: prose, Markdown
  fences, an `allow` carrying a `reason`, a `low + deny` pair, a `high + allow`
  pair, a `max-tokens` cut, and a decision emitted as a tool call all become one
  text block plus a `stop` finish. Contradictory pairs resolve fail-closed:
  `high + allow` becomes a `high` denial, and `low + deny` keeps the denial at
  `medium`.
- Degrade an unreadable reply to `medium + deny`, which under the `ask` approval
  policy is an ordinary approval prompt instead of a blocked tool call. Setting
  `fallback` to `fail` keeps the original failure.
- Repeat the JSON contract at the end of the reviewer system prompt, and re-ask
  the reviewer up to twice when nothing readable comes back.
- Settings card under **Settings → Plugins → Auto review → Configuration**, with
  the model list read from the Host catalog and free-text fields when the
  catalog is unavailable.

### Changed

- Every knob is optional: with no configuration at all, the plugin only repairs
  output, and the reviewer stays on the main model.
- Config fields are volatile, so a settings change applies to the next reviewed
  call without restarting the plugin.

### Notes

- `dist/` is committed. DSH blocks a package's build scripts by default, so a
  git install that declares `prepare` is rejected outright; the artifacts travel
  with the repository, and CI fails if a rebuild differs from them.
- The plugin changes only the review request. The main model, the Auto sandbox
  and the approval semantics are untouched.

[Unreleased]: https://github.com/GT-610/dsh-auto-review-model-select/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/GT-610/dsh-auto-review-model-select/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/GT-610/dsh-auto-review-model-select/releases/tag/v0.1.0
