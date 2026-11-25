# Changelog

本项目的所有重要变更都记录在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [1.1.1] - 2026-11-26

### Fixed

- **DSH session format v4 compatibility**: injected messages now use the V4 producer-owned source shape
  `source.kind = 'plugin:context-truth'` instead of the retired V3 `{ kind: 'plugin', plugin: 'context-truth' }`.
  On DSH 0.2.2+ the old shape was rejected on the next round with
  `format v4 message requires a producer-owned source kind`, failing the turn after the injected context was replayed.
- Updated the self-test and documentation to verify the V4 source shape.

## [1.1.0] - 2026-11-14

### Added

- **`/context` 手动注入命令**（别名 `/ctx`）：立即把当前上下文余量注入给模型，用于「模型出现幻觉但
  自动注入的 10% 刻度还没到」的场景。支持三种送达方式：
  - `auto`（默认）：agent 运行中 → 注入本轮下一步；空闲 → 作为下一轮上下文；
  - `turn`：强制开一轮；
  - `queue`：不主动送达，挂起，等下一次请求时注入。
  可按次覆盖（`/context queue`），送达三级降级且不会重复投递。
- **命令摘要**：命令返回值只给人看（不进模型上下文），包含用量、余量、阈值与送达方式。
- `corrections` 与 `maxCorrectionsPerTurn` 配置项：可关闭更正或调整每轮上限。
- `lastAssistantText()`：按"最近一条 assistant 消息"取文本（不限定 turn），供命令纠正刚结束那一轮。

### Fixed

- **更正误报（v1.0.0 引入）**：v1.0.0 在原文上直接正则匹配，导致答案里**引用**历史原话、
  举例子或写代码字符串时被误判成模型自称，在正常对话中插入无关的 `Correction`。
  现改为「先净化正文、再做四条件合取」：
  - 净化：剥掉围栏代码块、行内代码、成对引号（`"…"` `“…”` `「…」` `『…』` `'…'`，单引号只在
    像引号的位置成对剥，不影响 `I'm`）、Markdown 块引用；
  - 合取：断言命中 + 第一人称 + **停止意图** + 排除否定/引用/元话语语境。
  - 检测器改为「先净化正文、再做四条件合取」，并补齐「引用/举例/代码字符串不命中」的回归用例。
- 更正文案加上 `[context-truth] Auto-correction:` 前缀，便于在历史里辨认来源。

### Docs

- README 增补「同 id 双挂载导致冷启动失败」（`duplicate loader entry id`）的红线说明：
  `bundle` 内的 entry id 与 `file://` 热挂载必须不同，运行时的进程级仲裁只对**不同 id** 生效。

## [1.0.0] - 2026-11-08

### Added

- 自动事实注入：每个 `agent/pre-step` 用 token-meter（与压缩判定同一个数字）注入真实用量/余量/阈值。
- 假性「上下文耗尽」更正：低于阈值时声称耗尽 → 注入更正驳回。
- 阈值来源支持 `settings.yaml` 的 `compaction.thresholdRatio`，每次 step 重读。
- 进程级挂载仲裁（`Symbol.for('dsh-context-truth.mount')`）：多实例时后来者让位。
- `tools/measure-context.mjs`：会话日志（多 zstd frame）取证工具。
- 作为标准 DSH 插件打包：`dsh.bundle.patch` + `dsh plugin add link:` 安装进 `dsh.profile.bundles`。
