# [Proposal] Provider-neutral prompt token pressure + local overflow → compact-retry

> Status: community plugin available now (`dsh-plugin` v0.1.4); core protocol sketched for when external PRs are accepted again.
> Related: CONTRIBUTING currently declines external PRs — filing this as a Discussion per project guidance.

## Problem

Stock `dsh-token-meter` prices prompts with a fixed ~4 characters/token heuristic. Dense-script (CJK) sessions and large tool schemas are systematically **undercounted**. Local OpenAI-compat servers (e.g. llama.cpp) then reject the real request with:

```text
exceed_context_size_error
request (N tokens) exceeds the available context size (n_ctx)
```

Two gaps follow:

1. **Proactive compaction** trusts the undercount → pressure never fires in time (or fires on the wrong signal).
2. **Overflow recovery** already exists (`agent/request-error` + `CONTEXT_WINDOW_EXCEEDED` → compact → retry), but bare HTTP 400 + `exceed_context_size*` is often classified as `INVALID_REQUEST`, so the recovery path never runs.

Reproduced on local 64K llama.cpp routes with Chinese-heavy agent sessions (heuristic far below window, server reports prompt over `n_ctx`).

## Proposed core direction (decoupled)

Optional adapter capability, **no engine names in core**:

```ts
interface TokenCountResult {
  promptTokens: number
  source: 'provider' | 'tokenizer' | 'approx'
}

// LlmAdapter optional method — same assembly path as stream()
countPromptTokens?(options: GenerateOptions, signal?: AbortSignal): Promise<TokenCountResult>
```

- `token-meter` / compaction call through the runtime when present; on miss/timeout → keep heuristic.
- Adapters that expose HTTP tokenize/count (or native count APIs) opt in via route config, e.g. `promptTokenCount: true | { endpoint, input, templateEndpoint }`.
- Expand `isContextWindowExceededError` / stream classification so `exceed_context_size*` maps to `CONTEXT_WINDOW_EXCEEDED` before bare-400 → `INVALID_REQUEST`.

This stays provider-neutral: DeepSeek cloud, gateways, and local servers can each implement the method; core never hard-codes `/tokenize` or llama.cpp.

### Production-aligned pressure (Cursor / Codex / Claude Code)

These products manage **conversation token budgets**, not a client-side “remaining KV %” gauge:

| Layer | Behavior |
|---|---|
| Accurate / reported usage | Know how large the active prompt is |
| Proactive compact ~90% of window | Summarize / shrink history before the hard edge |
| Hard overflow | Map provider context errors → compact-retry |
| Large tool payloads | Prefer truncate / spill to files (product-side); do not fake-overflow at 45% |

Early fake-`CONTEXT_WINDOW_EXCEEDED` at a low soft ratio (e.g. 0.45) is unsafe when this-turn tool/file payloads dominate: compact cannot shrink them, retries exhaust, and the turn fails while the real window still has room (observed ~40k on a 64k local route).

Community plugin **v0.1.4** matches the ~90% pattern: tokenize the outgoing prompt; compact only when `promptTokens > min(thresholdRatio × window, window − outputReserve)`; otherwise allow; always rewrite llama.cpp overflow.

## What the community can use today

While external PRs are closed, a stock-safe **plugin** implements the operational half without forking `@deepseek-ai/*`:

- `llm/stream` rewrite of overflow-like finish errors → `CONTEXT_WINDOW_EXCEEDED`
- HTTP tokenize against configured `baseURL` before dispatch
- Compact trigger default `thresholdRatio: 0.90` + `outputReserve: 4096`

Install shape: npm/`link:` bundle with `dsh.bundle.patch`, topic `dsh-plugin`.

Reference implementation (community, stock-safe):

https://github.com/tianyiming1/dsh-plugin-local-prompt-bridge

Topic: `dsh-plugin`. Install: `pnpm add github:tianyiming1/dsh-plugin-local-prompt-bridge` then add `@local/dsh-plugin-local-prompt-bridge` to profile `bundles`.

Defaults ship with empty `routes` and **global** overflow rewrite (no personal model/port hard-coded). Proactive tokenize is opt-in per route in the installer's profile.

Verified on official DSH desktop/web path + local 64K llama.cpp routes (Bonsai2 etc.).

## Ask

1. Is the optional `countPromptTokens` seam acceptable for a future core change?
2. Can overflow classification for `exceed_context_size*` land even sooner (small, high leverage)?
3. Please align any proactive path with industry ~90% / fit-before-send semantics — avoid low soft fake-overflow loops on tool-heavy turns.
4. Until then, any objection to documenting the community plugin pattern for local OpenAI-compat tokenize?

Happy to split into: (a) overflow classifier only, (b) protocol + meter + ~90% compact trigger, (c) reference adapter opt-in — whenever external contributions reopen.
