# dsh-plugin-local-prompt-bridge

[![topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

官方 DSH（桌面 / `npx` / 命令启动）可用的社区插件：本地 OpenAI-compat（llama.cpp 等）**精算压力 + 溢出自动压缩重试**。

不改、不替换任何 `@deepseek-ai/*` 包；升级官方 DSH 后只要重新装上本插件即可。

仓库：[tianyiming1/dsh-plugin-local-prompt-bridge](https://github.com/tianyiming1/dsh-plugin-local-prompt-bridge)

## 做什么

对齐 Cursor / Codex / Claude Code 一类产品的上下文策略（按 **token 账本**，不是读显存 KV）：

1. **溢出改写（默认对所有 provider）**：把 `exceed_context_size_error` / 「超过 context」类 400，改成 `CONTEXT_WINDOW_EXCEEDED`，交给官方 `compaction-basic` 压缩再试。
2. **主动精算（需配置 routes）**：步进前 `/tokenize`（失败则 `/apply-template` → content）。
   - 算出**即将发出去的包**有多大。
   - 超过 `min(thresholdRatio × window, window − outputReserve)`（默认约 **90%**，并预留生成空位）→ 合成溢出，让官方压缩历史再试。
   - **未超过则直接发**（不再使用早期「软线假满」）。
   - 真撞上服务器上限仍靠第 1 条改写兜底。

默认 `routes: []`——**不绑定任何个人模型 / 端口**。装上即可获得全局溢出改写；主动压缩请按你自己的 `llm-pi-ai` provider 填写。

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

### 配置主动压缩（可选）

在 **你的 profile** `cordis.patch.yml` 里覆盖插件 config：

```yaml
- id: local-prompt-bridge
  config:
    routes:
      - provider: llama-cpp-local   # 与 llm-pi-ai 里的 provider id 一致
        baseURL: http://127.0.0.1:8080/v1
        contextWindow: 65536
    thresholdRatio: 0.90
    outputReserve: 4096
```

也可直接编辑本包 `cordis.patch.yml`（仅本地 fork / link 时）。

## 自测

1. 确认本地 OpenAI-compat 服务在跑（若启用了 proactive routes）。
2. **用平时的方式**启动官方 DSH（桌面 / 命令），不要用 fork 源码。
3. 启动日志应有：`[local-prompt-bridge] active (rewrite=all-providers, ... compactAt=0.9 ...)`
4. 中等偏大 prompt（例如 40k / 64k）应直接放行；接近窗口或服务器超窗时应压缩再试。
5. 临时关掉：从 `bundles` 去掉本包，或把 `rewriteOverflow` / `proactiveCompact` 设为 `false`。

## 与上游协议的关系

若官方日后合入可选 `countPromptTokens` / 更好的溢出分类，可把对应路由改成官方能力，再逐步关掉本插件的 proactive / rewrite 部分。  
提案草稿见 [`DISCUSSION.md`](./DISCUSSION.md)（官方暂不收外部 PR，请发到 [deepseek-harness Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions)）。

## License

MIT
