# dsh-context-truth

[![CI](https://github.com/Vladivostok1017/dsh-context-truth/actions/workflows/ci.yml/badge.svg)](https://github.com/Vladivostok1017/dsh-context-truth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

[简体中文](README.md) | **English**

> A DSH (DeepSeek Harness) host plugin that injects the **real context budget** into the model,
> corrects **false "context exhausted"** claims, and adds a `/context` command for on-demand injection.

Zero runtime dependencies. It does one job: **stop the model from guessing how much context it has left.**

---

## The problem

In DSH, context accounting belongs to `token-meter` — but its output only feeds UI projections
(`contextPressure`, `contextBreakdown`). **The model itself never receives a token count.**
Automatic compaction (`compaction-basic`) only acts at `contextWindow × thresholdRatio` (80% by default).

Below that threshold the model has nothing to observe, so it estimates from "the history looks long"
and writes assertions like:

> "My context is exhausted, I cannot run any tool calls this round."
> "The context is nearly used up — I'll hand off here."

…often while the real usage is nowhere near the threshold. Worse, once such a sentence is in history,
every later turn treats it as established fact and repeats it. Nothing in the host corrects it.

This plugin replaces guessing with telling:

- **Inject** the real usage / remaining / threshold into the model's context before each step;
- **Correct** a sub-threshold exhaustion claim on the spot with a counter-statement;
- **Force** an injection anytime with the `/context` command.

## Features

### 1. Automatic real-budget injection

Before every `agent/pre-step`, the plugin measures
`ctx.tokenMeter.measure(session).totalTokens` — **the very number automatic compaction uses** — against
`session.requestContext().contextWindow`, then injects one native context message
(`source.plugin = 'context-truth'`, persisted and auditable in the trajectory panel):

```
Context budget for this request (measured by the harness token meter, the same figure automatic
compaction uses): ~412,000 of 1,000,000 tokens used (41.2%), ~588,000 remaining.
Compaction threshold 800,000 (80%): not reached, so the context is not near its limit.
Treat this measurement, not your own estimate, as the truth about remaining context. ...
```

Threshold resolution: `settings.yaml` → `compaction.thresholdRatio`, then plugin `config.thresholdRatio`,
then the built-in `0.8`. Re-read on every step, so settings changes apply immediately.

### 2. False-claim correction

If the last assistant message (including reasoning) claims exhaustion **below** the threshold, the plugin
injects one `Auto-correction` to refute it, preventing the claim from reinforcing itself in history.

Detection is deliberately conservative — four conditions must hold, because a false positive is worse
than a miss (it inserts an unexplained correction into a normal conversation):

1. a claim pattern matches (Chinese and English);
2. first-person self-reference;
3. a **stop intent** is present (`cannot continue` / `must stop` / `wrap up` / 无法 / 不再 …);
4. negation and quotation contexts are excluded.

Before matching, the text is sanitized: fenced code blocks, inline code, paired quotes
(`"…"` `“…”` `「…」` `『…』` `'…'`) and Markdown block quotes are stripped; messages that discuss the
detector itself (`claimsContextExhaustion`, `assert.equal`, `测试用例`, `false positive` …) are skipped entirely.

Default cap is one correction per turn; disable it entirely with `corrections: false`.

### 3. `/context` command

For the case "the model is already hallucinating, but the automatic 10% boundary has not been reached yet":

```text
/context          auto (default): running agent → next step; idle agent → queued as the next turn
/context turn     force a new turn even while the agent is running
/context queue    do not deliver now; inject on the next request instead
```

- Alias `/ctx`.
- The command result is human-only and never enters the model context, e.g.
  `上下文 ~412,000 / 1,000,000（41.2%），余量 ~588,000；压缩阈值 800,000（80%）。已注入：本轮下一步。`
- Delivery degrades in order: `agent.inbox.prepend('next-step')` → `agent.followup()` → a pending flag
  consumed by the next pre-step. The first success wins, so nothing is delivered twice.

## How it works

| Concern | Implementation |
| --- | --- |
| Trigger | `ctx.on('agent/pre-step', …, { prepend: true })`, appending messages after `next()` |
| Data source | `ctx.tokenMeter.measure(session).totalTokens` + `session.requestContext().contextWindow` |
| Frequency | step 1; then once per 10% boundary crossed; every step inside the last 5% before the threshold; unconditionally once after a manual command |
| Shape | native `user` message with `source = { kind: 'plugin', plugin: 'context-truth' }` |
| Detection | text sanitization + four-condition conjunction, per-turn cap |
| Command | `ctx.commands.register({ name, description, handler })`, disposed with the plugin |
| State | one record per session (`last percent`, `turn`, `corrections this turn`, `pending`), FIFO-evicted past 500 sessions |
| Dependencies | only the `tokenMeter` and `commands` host services; **no `@deepseek-ai/*` imports** |

Design trade-offs (why not estimate tokens ourselves, why detection must stay conservative, why
injection must stay sparse) are documented in [`docs/DESIGN.md`](docs/DESIGN.md).

## Install

Requires DSH Desktop / harness `0.1.5-rc.2` or newer, and Node ≥ 20.

```powershell
# standard install (recommended)
dsh plugin --profile web add link:<absolute path to this repo>

# or from a packed tarball
npm run pack:tgz
dsh plugin --profile web add link:<absolute path>\dist\dsh-context-truth-1.1.0.tgz
```

`dsh plugin` forwards to pnpm, links the package into the profile, and appends `dsh-context-truth`
to `dsh.profile.bundles` (the package declares `dsh.bundle.patch`). Restart DSH afterwards.

> ⚠ **Never mount the same plugin under the same loader entry id twice.** The bundled patch already uses
> `id: context-truth`; an additional `file://` hot-mount with the *same* id makes cold start fail at the
> loader's `validate` stage (`duplicate loader entry id`), taking the whole plugin tree down. Use a
> different id (e.g. `context-truth-hotpatch`); distinct ids are then arbitrated at runtime through
> `Symbol.for('dsh-context-truth.mount')`. Identical ids cannot be saved at runtime.

Uninstall: `dsh plugin --profile web remove dsh-context-truth` (removes the bundle layer automatically).

## Configuration

All optional; pass them under the mount entry's `config`:

```yaml
- insert:
    - id: context-truth
      name: dsh-context-truth
      config:
        thresholdRatio: 0.8            # fallback threshold (settings.yaml wins)
        claimTolerance: 0.02           # tolerance for "false claim" detection
        corrections: true              # false = inject facts only
        maxCorrectionsPerTurn: 1
        commandName: context           # false = do not register the command
        commandAliases: [ctx]
        commandMode: auto              # auto | turn | queue
        enabled: true
        allowMultipleMounts: false
```

## Compatibility

| Item | Value |
| --- | --- |
| Developed and tested against | DSH Desktop `0.9.1` / `@deepseek-ai/*` `0.1.5-rc.2` |
| Required host services | `tokenMeter` (`dsh-token-meter`), `commands` (`dsh-commands`) — both inside the `dsh-base` bundle |
| Node | ≥ 20 (CI covers 20 / 22 / 24) |
| Runtime dependencies | none |
| Platform | wherever the host runs (Windows / macOS / Linux) |

If a future host major version changes the `agent/pre-step` or `commands.register` contract, this plugin
must be updated with it. A missing `inject` dependency deactivates the plugin instead of silently
degrading — that is intentional.

## Verify

Self-checks (no DSH required):

```powershell
npm test        # 34 checks: false-positive regressions, command wiring, delivery fallback, error paths
npm run check   # syntax check + self-checks
```

Once installed, confirm in your own session:

1. **Trajectory panel**: rows from source `context-truth` with `kind = context`;
2. **Command palette**: typing `/` lists "inject the current context budget into the model";
3. **Session log**: a `user/message` with `source.plugin === 'context-truth'`;
4. **Usage audit** (optional): `node tools/measure-context.mjs "<session>\session.v3.jsonl.zstd"` —
   decodes DSH's append-only log frame by frame and prints per-step prompt usage, window percentage,
   compaction events, and whether the peak crossed the threshold.

## Known limits

- Claim detection is heuristic and deliberately conservative; silence it with `corrections: false`.
- Only sessions that have reported a `request/context` are covered (there is no denominator before the
  first request; `/context` says so instead of inventing a number).
- `tokenMeter.totalTokens` includes the last assistant output, so it is a few dozen to a few hundred tokens
  above the prompt-only figure — negligible, and it is exactly the number compaction uses.
- `/context` opens a turn when the agent is idle by default; use `commandMode: queue` or `/context queue`
  to only queue.
- The plugin blocks the *fabricated number* path. "Finding an excuse to stop" is model behavior, so the
  injected text also states the rule: name a concrete blocker instead of context capacity.

## Layout

```
index.js                   implementation (single file, zero dependencies)
cordis.patch.yml           mount declaration (referenced by package.json → dsh.bundle.patch)
package.json               dsh.bundle metadata / files / scripts
README.md  README.en.md    Chinese / English docs
docs/DESIGN.md             design trade-offs and implementation notes
CHANGELOG.md               version history
CONTRIBUTING.md            development and contribution flow
AGENTS.md                  repository invariants for coding agents
test/selftest.mjs          34 self-checks (npm test)
tools/measure-context.mjs  session-log forensic tool: per-step usage vs threshold
.github/workflows/ci.yml   CI: Node 20/22/24 × syntax check + self-checks + pack smoke test
```

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The core invariants (zero dependencies, one shared name,
unique loader entry id, a detector that may only get more conservative, sparse injection) live in
[`AGENTS.md`](AGENTS.md).

## License

[MIT](LICENSE). A third-party DSH plugin, not affiliated with DeepSeek.
