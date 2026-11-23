# dsh-context-truth

[![CI](https://github.com/Vladivostok1017/dsh-context-truth/actions/workflows/ci.yml/badge.svg)](https://github.com/Vladivostok1017/dsh-context-truth/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**简体中文** | [English](README.en.md)

> 一个 DSH（DeepSeek Harness）宿主插件：把**真实的上下文预算**注入给模型，纠正**假性「上下文耗尽」**判断，并提供 `/context` 命令随时手动注入。

零运行时依赖，只做一件事：**别让模型猜自己的上下文还剩多少。**

---

## 问题

DSH 里量上下文的事由 `token-meter` 负责，但它的结果只喂 UI 投影（`contextPressure`、
`contextBreakdown`）——**模型自己拿不到任何 token 数字**。自动压缩（`compaction-basic`）
要到 `contextWindow × thresholdRatio`（默认 80%）才动手。

于是阈值以下，模型对「还剩多少」只能靠猜。历史一长，它就会写出这类无法观测的断言：

> 「我的上下文已经用完，本轮不做调用」
> 「上下文已接近耗尽，这里做一次干净交接」

而真实用量可能远未到阈值。更麻烦的是：这句话一旦写进历史，后续每一轮都会把它当既成事实
继续模仿；宿主侧没有任何机制去纠正它。

这个插件把「猜」换成「告知」：

- **注入**：每个 step 前把真实用量、余量、阈值作为上下文交给模型，并要求以该测量为准；
- **纠正**：模型在低于阈值时声称耗尽 → 当场注入一条更正驳回；
- **手动**：`/context` 命令随时强制注入一次。

## 功能

### 1. 真实上下文预算注入（自动）

每个 `agent/pre-step` 之前，用 `ctx.tokenMeter.measure(session).totalTokens`
——**与自动压缩判定完全同一个数字**——配合 `session.requestContext().contextWindow`，
算出真实百分比 / 余量 / 阈值，注入一条 `source.plugin = 'context-truth'` 的宿主原生上下文
（会落盘，可在轨迹面板审计）：

```
Context budget for this request (measured by the harness token meter, the same figure automatic
compaction uses): ~412,000 of 1,000,000 tokens used (41.2%), ~588,000 remaining.
Compaction threshold 800,000 (80%): not reached, so the context is not near its limit.
Treat this measurement, not your own estimate, as the truth about remaining context. ...
```

阈值来源优先级：`settings.yaml` 的 `compaction.thresholdRatio` → 插件 `config.thresholdRatio`
→ 内置默认 `0.8`。每次 step 重读，改设置即时生效。

### 2. 假性「上下文耗尽」断言更正

若上一条 assistant 消息（含 reasoning）在**低于阈值**时声称上下文耗尽，插件补一条
`Auto-correction` 把它当场驳回，避免它继续在历史里自我强化。

识别是**保守**的四条件合取，宁可漏判也不误判（误判会在用户眼前插一条无缘无故的更正）：

1. 断言模式命中（中英文）；
2. 第一人称自述；
3. 有**停止意图**（不再 / 无法 / 不做 / 交接 / wrap up / must stop …）；
4. 排除否定与引用语境。

匹配前先净化正文：剥掉围栏代码块、行内代码、成对引号（`"…"` `“…”` `「…」` `『…』` `'…'`）、
Markdown 块引用；若整条消息在讨论检测器本身（含 `claimsContextExhaustion`、`assert.equal`、
`测试用例`、`误报` 等字样）则整条跳过。

默认每轮最多 1 次；可用 `corrections: false` 整体关闭。

### 3. `/context` 手动注入命令

用于「模型已经出现幻觉，但自动注入的 10% 刻度还没到」的场景：

```text
/context          默认 auto：agent 在跑 → 注入本轮下一步；空闲 → 作为下一轮上下文
/context turn     强制开一轮（即使 agent 正在跑）
/context queue    不主动送达，挂起，等下一次请求时注入
```

- 别名 `/ctx`；
- 命令返回值只给人看，不进模型上下文，例如：
  `上下文 ~412,000 / 1,000,000（41.2%），余量 ~588,000；压缩阈值 800,000（80%）。已注入：本轮下一步。`
- 送达三级降级：`agent.inbox.prepend('next-step')` → `agent.followup()` → 挂起旗标
  （下一次 pre-step 无条件注入一次）。任一条成功即停止，不会重复投递。

## 工作原理

| 环节 | 实现 |
| --- | --- |
| 触发 | `ctx.on('agent/pre-step', …, { prepend: true })`，`next()` 之后追加消息 |
| 数据源 | `ctx.tokenMeter.measure(session).totalTokens` + `session.requestContext().contextWindow` |
| 注入频率 | step 1；之后每跨 10% 刻度一次；进入阈值前 5% 区间后每步一次；手动命令挂起时无条件一次 |
| 注入形态 | 宿主原生 `user` 消息，`source = { kind: 'plugin', plugin: 'context-truth' }` |
| 更正判定 | 正文净化 + 四条件合取（见上），每轮上限可配 |
| 命令注册 | `ctx.commands.register({ name, description, handler })`，随插件卸载自动注销 |
| 状态 | 每会话一条 `{ 上次百分比, 当前 turn, 本轮更正数, 挂起数 }`，超过 500 会话按 FIFO 淘汰 |
| 依赖 | 仅 `tokenMeter` 与 `commands` 两个宿主服务；**不 import 任何 `@deepseek-ai/*`** |

更细的设计取舍（为什么不用启发式估算、为什么检测必须保守、注入为什么必须稀疏）见
[`docs/DESIGN.md`](docs/DESIGN.md)。

## 安装

要求：DSH Desktop / harness 版本 ≥ `0.1.5-rc.2`，Node ≥ 20。

### 方式 A：标准插件安装（推荐）

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>
```

`dsh plugin` 会转发给 pnpm，写入 `link:` 依赖、在 profile 的 `node_modules` 生成 junction，
并因为本包声明了 `dsh.bundle.patch` 而**自动把 `dsh-context-truth` 追加进
`dsh.profile.bundles`**。装完重启 DSH 生效。

### 方式 B：发布包

```powershell
npm run pack:tgz      # 产出 dist/dsh-context-truth-<version>.tgz
dsh plugin --profile web add link:<绝对路径>\dist\dsh-context-truth-1.1.0.tgz
```

### ⚠ 方式 C：热挂载（仅调试，注意 entry id）

在 `$DSH_HOME/cordis.patch.yml` 里插一条 `file://` 可以免重启生效，但**必须换 id**：

> 本包自带的 patch 已使用 `id: context-truth`。再插一条**同 id** 的 `file://`，loader 会在
> 冷启动 `validate` 阶段拒绝整棵插件树（`duplicate loader entry id: context-truth`）。
>
> 正确做法：给热挂载那条换 id（如 `context-truth-hotpatch`）。换成不同 id 后，两份实例由
> 进程级 `Symbol.for('dsh-context-truth.mount')` 仲裁，后来者让位并打 `already mounted` 的 warn。
> **同 id 的冲突运行时救不了。**

### 卸载 / 升级

```powershell
dsh plugin --profile web remove dsh-context-truth   # 会自动从 bundles 移除
```

升级 = 改代码后重启（`link:` 安装无需重新 add）。

## 配置

全部可选，写在挂载条目的 `config` 下：

```yaml
- insert:
    - id: context-truth
      name: dsh-context-truth
      config:
        thresholdRatio: 0.8            # 兜底阈值；settings.yaml 的 compaction.thresholdRatio 优先
        claimTolerance: 0.02           # 判「假性断言」的容差
        corrections: true              # false = 只注入事实，不做更正
        maxCorrectionsPerTurn: 1       # 每轮最多更正次数
        commandName: context           # 命令名；false = 不注册命令
        commandAliases: [ctx]          # 别名列表
        commandMode: auto              # auto | turn | queue
        enabled: true                  # false = 整体关闭
        allowMultipleMounts: false     # true = 允许同进程多实例（一般不需要）
```

## 兼容性

| 项 | 值 |
| --- | --- |
| 开发与验证所用版本 | DSH Desktop `0.9.1` / `@deepseek-ai/*` `0.1.5-rc.2` |
| 需要的宿主服务 | `tokenMeter`（`dsh-token-meter`）、`commands`（`dsh-commands`），均在 `dsh-base` bundle 内 |
| Node | ≥ 20（CI 覆盖 20 / 22 / 24） |
| 运行时依赖 | 无 |
| 平台 | 与宿主一致（Windows / macOS / Linux） |

宿主大版本升级后若 `agent/pre-step` 或 `commands.register` 的契约变化，本插件需要同步更新——
`inject` 声明缺失时插件不会被激活（而不是静默降级），这是有意的。

## 验证

自检（不需要 DSH）：

```powershell
npm test        # 34 项：误报回归、命令接线、送达降级、异常兜底
npm run check   # 语法检查 + 自检
```

安装后在你的会话里确认：

1. **轨迹面板**：出现来源 `context-truth`、`kind = context` 的行；
2. **命令面板**：输入 `/` 能看到「立即把当前上下文余量注入给模型」；
3. **会话日志**：存在 `user/message` 且 `source.plugin === 'context-truth'`；
4. **用量核对**（可选）：`node tools/measure-context.mjs "<会话>\session.v3.jsonl.zstd"`，
   逐帧解压 DSH 的 append-only 日志，打印每一步真实 prompt 用量、窗口百分比、压缩事件，
   以及峰值是否越过阈值。

## 已知限制

- 断言识别是启发式的，且**故意保守**：宁可漏判，也不要在用户眼前插一条无缘无故的更正。
  觉得吵就 `corrections: false`；
- 只对**已上报 `request/context` 的会话**生效（首次请求之前没有分母；此时 `/context` 会返回
  明确提示而不是给一个瞎猜的数字）；
- `tokenMeter.totalTokens` 含最后一条 assistant 输出，比纯 prompt 侧略大几十~几百 tokens，
  量级可忽略，且这正是压缩判定用的同一个数；
- `/context` 在 agent 空闲时默认会**开一轮**（这样模型立刻看到并回应）。不想自动开轮：
  `commandMode: queue`，或单次用 `/context queue`；
- 本插件挡的是「编造数字」这条路。「找借口停手」属于模型行为，所以注入文本里同时写死规则：
  要停必须报具体阻塞，不许拿上下文容量当理由。

## 目录结构

```
index.js                   插件实现（零依赖，单文件）
cordis.patch.yml           挂载声明（package.json 的 dsh.bundle.patch 指向它）
package.json               dsh.bundle 元数据 / files / scripts
README.md  README.en.md    中文 / 英文文档
docs/DESIGN.md             设计取舍与实现细节
CHANGELOG.md               版本记录
CONTRIBUTING.md            开发与提交流程
AGENTS.md                  给编码 agent 的仓库约定
test/selftest.mjs          34 项自检（npm test）
tools/measure-context.mjs  会话日志取证：逐步真实用量 vs 压缩阈值
.github/workflows/ci.yml   CI：Node 20/22/24 × 语法检查 + 自检 + 打包冒烟
scripts/publish-release.ps1  建 Release 并上传资产（令牌只从环境变量读，支持 -DryRun）
```

## 参与开发

见 [`CONTRIBUTING.md`](CONTRIBUTING.md)。核心不变量（零依赖、三方同名、entry id 唯一、
检测器只能更保守、注入必须稀疏）见 [`AGENTS.md`](AGENTS.md)。

## 许可

[MIT](LICENSE)

第三方 DSH 插件，与 DeepSeek 官方无关。
