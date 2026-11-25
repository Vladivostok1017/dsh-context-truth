# AGENTS.md

给在本仓库干活的编码 agent 的约定。**不变量优先于流程**：下面 `MUST` 条目任何一条被破坏，
这个插件就会在用户机器上变成噪音甚至让 DSH 起不来。

## 这个仓库是什么

一个 DSH（DeepSeek Harness）宿主插件，单文件实现（`index.js`），零运行时依赖。
它做三件事：

1. `agent/pre-step` 时把真实上下文用量注入给模型（与自动压缩判定同一个数字）；
2. 模型在低于阈值时声称「上下文耗尽」→ 注入一条更正驳回；
3. 注册 `/context` 人肉命令，随时强制注入一次。

## 不变量（MUST）

1. **零依赖**：`index.js` 不得 `import` 任何 `@deepseek-ai/*` 或第三方包（只用 `node:crypto`）。
   profile 的 `node_modules` 里没有 `@deepseek-ai/*`，引入即加载失败。
2. **三方同名**：仓库名 = `package.json.name` = `dsh` 插件名 = loader entry id = `context-truth`。
   改任何一处都会破坏 `dsh plugin add` 与热挂载。
3. **entry id 必须唯一**：`cordis.patch.yml` 里的 `id: context-truth` 与 bundle 层一致；
   `$DSH_HOME/cordis.patch.yml` 的 `file://` 热挂载**必须换 id**，否则冷启动
   `duplicate loader entry id` 让整棵插件树加载失败。
4. **检测器只能更保守**：放宽 `claimsContextExhaustion` 前必须补「引用/举例/代码字符串不命中」的
   回归用例。误判会在用户对话里插一条无缘无故的更正，代价高于漏判。
5. **注入要稀疏**：不要在每一步无条件注入（1. step 1；2. 跨 10% 刻度；3. 阈值前 5% 区间；
   4. 手动命令挂起时）。插件不得成为把上下文撑大的那个。
6. **测量只用 token-meter**：`ctx.tokenMeter.measure(session).totalTokens` +
   `session.requestContext().contextWindow`。不要自己估算 token，也不要换分母。
7. **只读**：除「注入上下文」「响应命令」外不改任何状态；不改模型输出，不改压缩策略，不写宿主文件。

## 目录

```
index.js                 实现；导出的纯函数（stripQuoted / claimsContextExhaustion /
                         renderBudget / renderCorrection / renderCommandSummary /
                         deliverInjection / lastAssistantText …）要保留可测性
cordis.patch.yml         挂载声明（package.json → dsh.bundle.patch）
test/selftest.mjs        34 项自检，无框架依赖；npm test
tools/measure-context.mjs 会话日志取证（多 zstd frame，逐帧解压）
README.md / README.en.md 中文主文档 / 英文镜像
CHANGELOG.md             版本记录；行为变更必须写
```

## 验证（提交前必跑）

```powershell
npm run check                                   # node --check + 34 项自检
node tools/measure-context.mjs "<会话>\session.v3.jsonl.zstd"   # 真实用量校准
```

端到端验证（需要 DSH）：

```powershell
dsh plugin --profile web add link:<本仓库绝对路径>     # 或已在 profile 里就重启 DSH
```

生效判据：轨迹面板出现来源 `context-truth` 的 `kind = context` 行；命令面板可搜到
`/context`；会话日志有 `user/message` 且 `source.kind === 'plugin:context-truth'`。

## 改代码时的常见坑

- `{ contextWindow: undefined }` 会**命中默认参数**（`= 1000000`），测试里要传 `null` 才能表达"没有窗口"。
- `agent.pre-step` 的返回值必须保留 `decision` 其余字段，只改 `messages`。
- `agent.followup()` 与 `agent.inbox.prepend()` 二选一成功后不要再调另一个，否则重复投递。
- 命令 handler 必须返回 `{ kind: 'success' | 'error', text }`，且 `error.text` 非空。
- 正则别在原始文本上直接跑：先过 `stripQuoted`，并考虑 `META_HINT`（讨论检测器本身的消息）。
