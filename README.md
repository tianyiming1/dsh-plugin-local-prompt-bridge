# dsh-plugin-local-prompt-bridge

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

官方 DSH（桌面 / `npx` / 命令启动）可用的社区插件：本地 OpenAI-compat（llama.cpp 等）**精算压力 + 溢出自动压缩重试**。

不改、不替换任何 `@deepseek-ai/*` 包；升级官方 DSH 后只要重新装上本插件即可。

仓库：[tianyiming1/dsh-plugin-local-prompt-bridge](https://github.com/tianyiming1/dsh-plugin-local-prompt-bridge)

## 做什么

1. **溢出改写**：把 `exceed_context_size_error` / 「超过 context」类 400，改成 `CONTEXT_WINDOW_EXCEEDED`，交给官方 `compaction-basic` 压缩再试。
2. **主动压缩**：步进前对配置的路由打 `/tokenize`（失败则 `/apply-template` → content），真实 token 超过 `thresholdRatio × contextWindow` 时强制压缩。

## 安装（web profile）

在 **已关掉** 的 DSH 里执行（或关掉后再启）：

```powershell
cd $env:USERPROFILE\.dsh\profiles\web
pnpm add github:tianyiming1/dsh-plugin-local-prompt-bridge
```

本地开发也可用 `link:`：

```powershell
pnpm add link:D:/deepseek-harness-workspace/dsh-plugin-local-prompt-bridge
```

然后编辑同目录 `package.json`，在 `dsh.profile.bundles` 数组末尾加上：

```json
"@local/dsh-plugin-local-prompt-bridge"
```

改路由时编辑本包里的 `cordis.patch.yml`（`routes` / `baseURL` / `contextWindow`），与你在 DSH profile 的 provider 对齐。默认示例是 `llama-cpp-bonsai2` @ `127.0.0.1:18200`，按你的机器改。

## 自测

1. 确认本地 OpenAI-compat 服务在跑。
2. **用平时的方式**启动官方 DSH（桌面 / 命令），不要用 fork 源码。
3. 启动日志应有：`[local-prompt-bridge] active for ...`
4. 选对应本地路由，中文长会话 / 多塞工具结果：应在撞窗前压缩，或炸窗后自动压再试。
5. 临时关掉：从 `bundles` 去掉本包，或把 config 里 `rewriteOverflow` / `proactiveCompact` 设为 `false`。

## 与上游协议的关系

若官方日后合入可选 `countPromptTokens` / 更好的溢出分类，可把对应路由改成官方能力，再逐步关掉本插件的 proactive / rewrite 部分。  
提案草稿见 [`DISCUSSION.md`](./DISCUSSION.md)（官方暂不收外部 PR，请发到 [deepseek-harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)）。

## License

MIT
