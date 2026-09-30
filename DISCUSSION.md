# [Proposal] Provider-neutral prompt token pressure + local overflow → compact-retry

> Status: community plugin available now (`dsh-plugin` v0.1.3); core protocol sketched for when external PRs are accepted again.
> Related: CONTRIBUTING currently declines external PRs — filing this as a Discussion per project guidance.

## Problem

Stock `dsh-token-meter` prices prompts with a fixed ~4 characters/token heuristic. Dense-script (CJK) sessions and large tool schemas are systematically **undercounted**. Local OpenAI-compat servers (e.g. llama.cpp) then reject the real request with:

```text
exceed_context_size_error
request (N tokens) exceeds the available context size (n_ctx)
```

Two gaps follow:

1. **Proactive compaction** trusts the undercount → pressure never fires in time.
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

### Soft vs hard pressure (lesson from the community plugin)

Faking `CONTEXT_WINDOW_EXCEEDED` on every soft threshold (e.g. `0.45 × n_ctx`) is **unsafe** when the excess is mostly **this-turn tool/file payloads**:

1. Agent reads large files → precise count e.g. 40k on a 64k window
2. Soft threshold 29k → synthesize `CONTEXT_WINDOW_EXCEEDED` → stock compact-retry
3. Compaction shrinks **history**, not the current tool results
4. Count still ~40k > soft → synthesize again → retries exhaust → turn fails
5. Meanwhile 40k **still fits** the real window

So any core `countPromptTokens` + proactive path should distinguish:

| Band | Suggested behavior |
|---|---|
| `≤ soft` (e.g. 0.75) | normal |
| `soft < n ≤ hard` (e.g. 0.90) | optional early compact of **history only**; **do not** fail the turn |
| `> hard` | `CONTEXT_WINDOW_EXCEEDED` / compact-retry |
| provider `exceed_context_size*` | always map to `CONTEXT_WINDOW_EXCEEDED` |

Community plugin v0.1.3: soft synthesizes overflow **only when estimated removable history could land under soft**; otherwise allows. Hard uses `min(hardRatio × window, window − outputReserve)` so generation keeps a budget.

## What the community can use today

While external PRs are closed, a stock-safe **plugin** implements the operational half without forking `@deepseek-ai/*`:

- `llm/stream` rewrite of overflow-like finish errors → `CONTEXT_WINDOW_EXCEEDED`
- HTTP tokenize against configured `baseURL` before dispatch
- Soft pressure: log + allow; hard pressure: synthesize `CONTEXT_WINDOW_EXCEEDED` for stock compact-retry

Install shape: npm/`link:` bundle with `dsh.bundle.patch`, topic `dsh-plugin`.

Reference implementation (community, stock-safe):

https://github.com/tianyiming1/dsh-plugin-local-prompt-bridge

Topic: `dsh-plugin`. Install: `pnpm add github:tianyiming1/dsh-plugin-local-prompt-bridge` then add `@local/dsh-plugin-local-prompt-bridge` to profile `bundles`.

Defaults ship with empty `routes` and **global** overflow rewrite (no personal model/port hard-coded). Proactive tokenize is opt-in per route in the installer's profile.

Verified on official DSH desktop/web path + local 64K llama.cpp routes (Bonsai2 etc.).

## Ask

1. Is the optional `countPromptTokens` seam acceptable for a future core change?
2. Can overflow classification for `exceed_context_size*` land even sooner (small, high leverage)?
3. Please treat soft vs hard pressure as part of the design — soft fake-overflow loops are a footgun when tool payloads dominate.
4. Until then, any objection to documenting the community plugin pattern for local OpenAI-compat tokenize?

Happy to split into: (a) overflow classifier only, (b) protocol + meter + soft/hard bands, (c) reference adapter opt-in — whenever external contributions reopen.
