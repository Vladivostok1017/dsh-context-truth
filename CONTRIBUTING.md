# 贡献指南

这是一个小的 DSH 宿主插件。改动前先读 [`AGENTS.md`](AGENTS.md) 里的不变量，那几条比流程更重要。

## 环境

- Node.js >= 20（CI 覆盖 20 / 22 / 24）
- 一个可用的 DSH 安装（用于端到端验证；单元自检不需要）
- 零运行时依赖，**不要**为了让代码好写而引入依赖

## 本地开发

1. 克隆仓库：

   ```powershell
   git clone https://github.com/Vladivostok1017/dsh-context-truth.git
   cd dsh-context-truth
   ```

2. 装进本地 DSH profile（`link:` 安装，改代码后重启即生效，无需重新 add）：

   ```powershell
   dsh plugin --profile web add link:<本仓库绝对路径>
   ```

3. 跑自检：

   ```powershell
   npm run check     # 语法检查 + 34 项自检
   ```

## 改动要求

- **行为变更必须带自检用例**：`test/selftest.mjs` 里加 `check(...)`，覆盖正例与反例。
- **检测器只能更保守**：任何放宽 `claimsContextExhaustion` 的改动，必须同时补充
  「引用/举例/代码字符串不应命中」的回归用例。误判会在用户对话里留下噪音，代价远高于漏判。
- **不要动包名、插件名与 loader entry id**：仓库名 = npm 包名 = `dsh` 插件名 = entry id
  `context-truth`，三者一致才能让 `dsh plugin add` 一行完成安装。
- **新增配置项**要有默认值、要写进 `README.md` 的配置表，并在 `apply()` 里做类型校验（不引入 schema 库）。

## 如何验证「真实用量」的说法

`tools/measure-context.mjs` 直接读 DSH 的 append-only 会话日志（多 zstd frame）：

```powershell
node tools/measure-context.mjs "<会话目录>\session.v3.jsonl.zstd"
```

它会打印每一步的真实 prompt 用量、窗口百分比、压缩事件，以及峰值是否越过 80% 阈值。
提交涉及「误报/漏报」的改动时，请说明验证方法（用了哪类样本、覆盖了哪些反例），
**不要把完整会话日志贴进仓库**——那里面有你的对话内容。

## 提交与 PR

- 提交信息用 `<type>: <summary>`（`feat` / `fix` / `docs` / `test` / `chore`），一行说清做了什么。
- 一个 PR 只做一件事；行为变更请在描述里贴 `npm test` 输出。
- 更新 `CHANGELOG.md` 的 `Unreleased` 或对应版本段落。
- CI 必须绿（语法检查 + 自检 + 打包冒烟）。

## 发布

1. 改 `package.json` 的 `version` 与 `CHANGELOG.md`；
2. `npm run pack:tgz` 产出 `dist/*.tgz` 做冒烟；
3. `git tag v<version> && git push --tags`，在 GitHub Releases 附上 tgz；
4. （如需上 npm）`npm publish`。
