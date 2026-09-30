/**
 * @local/dsh-plugin-local-prompt-bridge
 *
 * Stock-safe community plugin for local OpenAI-compat servers (llama.cpp etc.):
 * 1) Rewrite overflow 400s → CONTEXT_WINDOW_EXCEEDED
 * 2) Before dispatch, HTTP-tokenize (max of messages + apply-template/content):
 *    Soft band: synthesize CONTEXT_WINDOW_EXCEEDED only when estimated *history*
 *    is large enough that compact could land under soft; otherwise allow
 *    (this-turn files/tools cannot be compacted — avoids fail loops).
 *    Hard band: always synthesize, with outputReserve kept free for generation.
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import { countPromptTokensHttp, looksLikeContextOverflow } from './tokenize.js'

export const name = 'local-prompt-bridge'
export const inject = []

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {any} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.rewriteOverflow && !(config.proactiveCompact && config.routes.length > 0)) {
    console.error('[local-prompt-bridge] rewrite and proactive both off / no routes; plugin idle')
    return
  }

  const proactiveTargets = config.routes.map(r => r.provider).join(', ') || '(none)'
  console.error(
    `[local-prompt-bridge] active `
    + `(rewrite=${config.rewriteOverflow ? 'all-providers' : 'off'}, `
    + `proactive=${config.proactiveCompact ? proactiveTargets : 'off'}, `
    + `soft=${config.thresholdRatio}, hard=${config.hardRatio}, reserve=${config.outputReserve})`,
  )

  ctx.on('llm/stream', (options, next) => {
    const route = matchRoute(config.routes, options.provider, options.model)
    // Rewrite is global (any provider). Proactive tokenize needs an explicit route.
    if (!config.rewriteOverflow && route === undefined) return next()

    return (async function* () {
      if (config.proactiveCompact && route !== undefined) {
        try {
          const blocked = await maybeBlockOverThreshold(config, route, options)
          if (blocked !== undefined) {
            yield blocked
            return
          }
        } catch (error) {
          console.error(
            `[local-prompt-bridge] tokenize skipped: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }

      for await (const chunk of next()) {
        yield config.rewriteOverflow ? rewriteFinishChunk(chunk) : chunk
      }
    })()
  })
}

/** @param {any} raw */
function normalizeConfig(raw) {
  const routes = Array.isArray(raw.routes)
    ? raw.routes.filter(r =>
      typeof r?.provider === 'string'
      && typeof r?.baseURL === 'string'
      && Number.isFinite(r?.contextWindow)
      && r.contextWindow > 0)
    : []
  // Soft: history-compact only when it can help. Hard: leave outputReserve free.
  const thresholdRatio = typeof raw.thresholdRatio === 'number' && raw.thresholdRatio > 0 && raw.thresholdRatio <= 1
    ? raw.thresholdRatio
    : 0.75
  let hardRatio = typeof raw.hardRatio === 'number' && raw.hardRatio > 0 && raw.hardRatio <= 1
    ? raw.hardRatio
    : 0.90
  if (hardRatio < thresholdRatio) hardRatio = thresholdRatio
  const outputReserve = typeof raw.outputReserve === 'number' && raw.outputReserve >= 0
    ? Math.floor(raw.outputReserve)
    : 4096
  return {
    routes,
    thresholdRatio,
    hardRatio,
    outputReserve,
    tokenizeEndpoint: typeof raw.tokenizeEndpoint === 'string' ? raw.tokenizeEndpoint : '/tokenize',
    templateEndpoint: typeof raw.templateEndpoint === 'string' ? raw.templateEndpoint : '/apply-template',
    rewriteOverflow: raw.rewriteOverflow !== false,
    proactiveCompact: raw.proactiveCompact !== false,
  }
}

/** @param {any[]} routes @param {string} provider @param {string} [model] */
function matchRoute(routes, provider, model) {
  return routes.find(route => {
    if (route.provider !== provider) return false
    if (route.models === undefined || route.models.length === 0) return true
    return model !== undefined && route.models.includes(model)
  })
}

/**
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {any} route
 * @param {any} options
 */
async function maybeBlockOverThreshold(config, route, options) {
  const messages = toWireMessages(options.messages ?? [])
  if (messages.length === 0) return undefined
  const tools = toWireTools(options.tools)

  const counted = await countPromptTokensHttp(
    route.baseURL,
    { endpoint: config.tokenizeEndpoint, templateEndpoint: config.templateEndpoint },
    {
      messages,
      ...(tools === undefined ? {} : { tools }),
    },
    options.signal,
  )

  const soft = Math.floor(route.contextWindow * config.thresholdRatio)
  const reserve = resolveOutputReserve(config, options)
  const hardByRatio = Math.floor(route.contextWindow * config.hardRatio)
  const hardByReserve = Math.max(1, route.contextWindow - reserve)
  const hard = Math.min(hardByRatio, hardByReserve)

  const historyTokensEst = estimateRemovableHistoryTokens(messages)
  const withoutHistory = Math.max(0, counted.promptTokens - historyTokensEst)

  console.error(
    `[local-prompt-bridge] tokenize msg=${counted.messagesCount ?? '?'} content=${counted.contentCount ?? '?'} `
    + `max=${counted.promptTokens} soft=${soft} hard=${hard} reserve=${reserve} `
    + `histEst=${historyTokensEst} withoutHist=${withoutHistory} window=${route.contextWindow}`,
  )

  if (counted.promptTokens <= soft) return undefined

  if (counted.promptTokens <= hard) {
    // Soft band: only fake-overflow when compacting *history* could land under soft.
    // If withoutHistory is still > soft, the bulk is this-turn files/tools — allow.
    if (withoutHistory <= soft && historyTokensEst >= Math.max(512, Math.floor(soft * 0.1))) {
      console.error(
        `[local-prompt-bridge] soft pressure ${counted.promptTokens} in (${soft},${hard}]; `
        + `history≈${historyTokensEst} looks compressible → ${CONTEXT_WINDOW_EXCEEDED_CODE}`,
      )
      return overflowFinish(
        `local-prompt-bridge: prompt ${counted.promptTokens} tokens over soft ${soft}; `
        + `requesting history compact (est. removable ≈${historyTokensEst})`,
      )
    }
    console.error(
      `[local-prompt-bridge] soft pressure ${counted.promptTokens} in (${soft},${hard}]; `
      + `payload-dominated (withoutHist=${withoutHistory}>soft) → allow`,
    )
    return undefined
  }

  console.error(
    `[local-prompt-bridge] hard pressure ${counted.promptTokens} > ${hard} `
    + `(window ${route.contextWindow}, reserve ${reserve}); synthesizing ${CONTEXT_WINDOW_EXCEEDED_CODE}`,
  )
  return overflowFinish(
    `local-prompt-bridge: prompt ${counted.promptTokens} tokens exceeds hard threshold ${hard} `
    + `of context window ${route.contextWindow} (reserve ${reserve})`,
  )
}

/** @param {string} message */
function overflowFinish(message) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
        message,
      },
    },
  }
}

/**
 * Leave room for completion. Prefer explicit option, else config.outputReserve.
 * @param {ReturnType<typeof normalizeConfig>} config
 * @param {any} options
 */
function resolveOutputReserve(config, options) {
  const fromOpt = Number(options?.maxTokens ?? options?.max_tokens)
  if (Number.isFinite(fromOpt) && fromOpt > 0) return Math.max(config.outputReserve, Math.floor(fromOpt))
  return config.outputReserve
}

/**
 * Rough upper bound on tokens that stock history-compact can remove:
 * everything before the latest user message (prior turns + their tool results).
 * Char/2 overestimates CJK tokens so we under-trigger soft compact (safer vs loops).
 * @param {readonly any[]} messages
 */
function estimateRemovableHistoryTokens(messages) {
  let lastUser = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') {
      lastUser = i
      break
    }
  }
  if (lastUser <= 0) return 0
  let chars = 0
  for (let i = 0; i < lastUser; i++) {
    const m = messages[i]
    if (!m || m.role === 'system') continue
    chars += typeof m.content === 'string' ? m.content.length : 0
    if (Array.isArray(m.tool_calls)) {
      for (const call of m.tool_calls) {
        const args = call?.function?.arguments
        if (typeof args === 'string') chars += args.length
      }
    }
  }
  return Math.ceil(chars / 2)
}

/** @param {any} chunk */
function rewriteFinishChunk(chunk) {
  if (chunk?.type !== 'finish' || chunk.reason?.kind !== 'error') return chunk
  const failure = chunk.reason.failure
  if (!failure || failure.code === CONTEXT_WINDOW_EXCEEDED_CODE) return chunk
  const detail = String(failure.message ?? failure.code ?? '')
  if (!looksLikeContextOverflow(detail)) return chunk
  console.error('[local-prompt-bridge] rewrote provider overflow → CONTEXT_WINDOW_EXCEEDED')
  return {
    ...chunk,
    reason: {
      kind: 'error',
      failure: {
        ...failure,
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
        message: failure.message ?? detail,
      },
    },
  }
}

/** @param {readonly any[]} messages */
function toWireMessages(messages) {
  const out = []
  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const role = message.role

    if (role === 'system') {
      out.push({ role: 'system', content: flattenContent(message.content) })
      continue
    }
    if (role === 'user') {
      out.push({ role: 'user', content: flattenContent(message.content) })
      continue
    }
    if (role === 'assistant') {
      const { text, toolCalls } = splitAssistant(message.content)
      out.push({
        role: 'assistant',
        content: text,
        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      })
      continue
    }
    // dsh / pi-ai tool results
    if (role === 'tool' || role === 'toolResult' || role === 'tool_result') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId ?? message.tool_call_id ?? message.callId ?? 'tool',
        content: flattenContent(message.content),
      })
    }
  }
  return out
}

/** @param {unknown} content */
function flattenContent(content) {
  if (typeof content === 'string') return content
  if (content == null) return ''
  if (!Array.isArray(content)) return JSON.stringify(content)
  const parts = []
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block)
      continue
    }
    if (!block || typeof block !== 'object') continue
    if (typeof block.text === 'string') parts.push(block.text)
    else if (typeof block.content === 'string') parts.push(block.content)
    else if (block.type === 'toolCall' || block.type === 'tool_use') continue
    else parts.push(JSON.stringify(block))
  }
  return parts.join('\n')
}

/** @param {unknown} content */
function splitAssistant(content) {
  if (typeof content === 'string') return { text: content, toolCalls: [] }
  if (!Array.isArray(content)) {
    return { text: content == null ? '' : JSON.stringify(content), toolCalls: [] }
  }
  const textParts = []
  const toolCalls = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'toolCall' || block.type === 'tool_use') {
      const id = block.id ?? block.toolCallId ?? `call_${toolCalls.length}`
      const name = block.name ?? block.toolName ?? 'tool'
      const args = block.arguments ?? block.input ?? block.params ?? {}
      toolCalls.push({
        id,
        type: 'function',
        function: {
          name,
          arguments: typeof args === 'string' ? args : JSON.stringify(args),
        },
      })
      continue
    }
    if (typeof block.text === 'string') textParts.push(block.text)
    else if (block.type === 'text' && typeof block.text === 'string') textParts.push(block.text)
  }
  return { text: textParts.join('\n'), toolCalls }
}

/** @param {unknown} tools */
function toWireTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map(tool => {
    if (tool && typeof tool === 'object' && tool.type === 'function' && tool.function) return tool
    const name = tool?.name ?? tool?.function?.name
    if (typeof name !== 'string') return tool
    return {
      type: 'function',
      function: {
        name,
        description: tool.description ?? tool.function?.description ?? '',
        parameters: tool.parameters ?? tool.inputSchema ?? tool.function?.parameters ?? {},
      },
    }
  })
}
