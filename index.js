/**
 * @local/dsh-plugin-local-prompt-bridge
 *
 * Stock-safe community plugin for local OpenAI-compat servers (llama.cpp etc.):
 * 1) Rewrite overflow 400s → CONTEXT_WINDOW_EXCEEDED
 * 2) Before dispatch, HTTP-tokenize (max of messages + apply-template/content);
 *    Soft threshold: log only (do not fake-fail — uncompressible tool/file
 *    payloads would loop compact→still-over→fail while window still has room).
 *    Hard threshold: synthesize CONTEXT_WINDOW_EXCEEDED for stock compact-retry.
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
    + `soft=${config.thresholdRatio}, hard=${config.hardRatio})`,
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
  // Soft: warn only. Hard: fake CONTEXT_WINDOW_EXCEEDED for compact-retry.
  // Default hard 0.90 leaves room for completion; soft 0.75 is informational.
  const thresholdRatio = typeof raw.thresholdRatio === 'number' && raw.thresholdRatio > 0 && raw.thresholdRatio <= 1
    ? raw.thresholdRatio
    : 0.75
  let hardRatio = typeof raw.hardRatio === 'number' && raw.hardRatio > 0 && raw.hardRatio <= 1
    ? raw.hardRatio
    : 0.90
  if (hardRatio < thresholdRatio) hardRatio = thresholdRatio
  return {
    routes,
    thresholdRatio,
    hardRatio,
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
  const hard = Math.floor(route.contextWindow * config.hardRatio)
  console.error(
    `[local-prompt-bridge] tokenize msg=${counted.messagesCount ?? '?'} content=${counted.contentCount ?? '?'} `
    + `max=${counted.promptTokens} soft=${soft} hard=${hard} window=${route.contextWindow}`,
  )
  if (counted.promptTokens <= soft) return undefined

  // Between soft and hard: still fits the real window. Do not fake-fail —
  // history compact cannot shrink this-turn file/tool payloads, and would
  // loop until overflow retries are exhausted (the 40k/64k screenshot bug).
  if (counted.promptTokens <= hard) {
    console.error(
      `[local-prompt-bridge] soft pressure ${counted.promptTokens} in (${soft},${hard}]; `
      + `allowing dispatch (real overflow still rewritten to ${CONTEXT_WINDOW_EXCEEDED_CODE})`,
    )
    return undefined
  }

  console.error(
    `[local-prompt-bridge] hard pressure ${counted.promptTokens} > ${hard} `
    + `(window ${route.contextWindow}); synthesizing ${CONTEXT_WINDOW_EXCEEDED_CODE} for stock compact-retry`,
  )
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: CONTEXT_WINDOW_EXCEEDED_CODE,
        message: `local-prompt-bridge: prompt ${counted.promptTokens} tokens exceeds hard threshold ${hard} of context window ${route.contextWindow}`,
      },
    },
  }
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
