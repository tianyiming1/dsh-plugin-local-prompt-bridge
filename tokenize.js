/**
 * Self-contained HTTP tokenize helpers for stock DSH (no unreleased core APIs).
 * Prefers apply-template → {content} tokenize and takes the max with any
 * messages-body count — llama.cpp often undercounts the messages shape.
 */

/** @param {string} baseUrl @param {string} endpoint */
export function resolveTokenCountUrl(baseUrl, endpoint) {
  if (/^https?:\/\//i.test(endpoint)) return endpoint
  const base = new URL(baseUrl.includes('://') ? baseUrl : `http://${baseUrl}`)
  const path = endpoint.startsWith('/') ? endpoint : `/${endpoint}`
  return `${base.origin}${path}`
}

/** @param {unknown} json */
export function parseCommonTokenCountResponse(json) {
  if (typeof json !== 'object' || json === null) {
    throw new Error('token count response is not an object')
  }
  const record = /** @type {Record<string, unknown>} */ (json)
  if (Array.isArray(record.tokens)) return record.tokens.length
  for (const key of ['count', 'token_count', 'input_tokens', 'prompt_tokens']) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  }
  if (typeof record.usage === 'object' && record.usage !== null) {
    const usage = /** @type {Record<string, unknown>} */ (record.usage)
    for (const key of ['input_tokens', 'prompt_tokens', 'total_tokens']) {
      const value = usage[key]
      if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
    }
  }
  throw new Error('token count response has no recognized count field')
}

/**
 * @param {string} url
 * @param {unknown} body
 * @param {(json: unknown) => number} parseCount
 * @param {AbortSignal} [signal]
 */
export async function postJsonTokenCount(url, body, parseCount, signal) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal === undefined ? {} : { signal }),
  })
  if (!response.ok) {
    throw new Error(`prompt token count HTTP ${response.status} from ${url}`)
  }
  const count = parseCount(await response.json())
  if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) {
    throw new Error(`prompt token count parse produced a non-integer: ${String(count)}`)
  }
  return count
}

/** @param {unknown} json */
function parseTemplatePrompt(json) {
  if (typeof json === 'string') return json
  if (typeof json === 'object' && json !== null) {
    const record = /** @type {Record<string, unknown>} */ (json)
    for (const key of ['prompt', 'content', 'text', 'result']) {
      const value = record[key]
      if (typeof value === 'string') return value
    }
  }
  throw new Error('apply-template response has no prompt string')
}

/** @param {readonly unknown[]} messages */
function flattenMessageText(messages) {
  const parts = []
  for (const message of messages) {
    if (typeof message !== 'object' || message === null) continue
    const record = /** @type {Record<string, unknown>} */ (message)
    const content = record.content
    if (typeof content === 'string') {
      parts.push(content)
      continue
    }
    if (!Array.isArray(content)) {
      if (content != null) parts.push(JSON.stringify(content))
      continue
    }
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const text = /** @type {Record<string, unknown>} */ (block).text
        if (typeof text === 'string') parts.push(text)
        else parts.push(JSON.stringify(block))
      }
    }
  }
  return parts.join('\n')
}

/**
 * Count via messages body AND apply-template→content; return the larger tally.
 * @param {string} baseUrl
 * @param {{ endpoint: string, templateEndpoint: string }} config
 * @param {{ messages: readonly unknown[], tools?: readonly unknown[] }} payload
 * @param {AbortSignal} [signal]
 */
export async function countPromptTokensHttp(baseUrl, config, payload, signal) {
  const countUrl = resolveTokenCountUrl(baseUrl, config.endpoint)
  const bodyBase = {
    messages: payload.messages,
    ...(payload.tools === undefined || payload.tools.length === 0
      ? {}
      : { tools: payload.tools }),
  }

  let messagesCount = 0
  try {
    messagesCount = await postJsonTokenCount(
      countUrl,
      bodyBase,
      parseCommonTokenCountResponse,
      signal,
    )
  } catch {
    messagesCount = 0
  }

  let content
  const templateUrl = resolveTokenCountUrl(baseUrl, config.templateEndpoint)
  try {
    const response = await fetch(templateUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(bodyBase),
      ...(signal === undefined ? {} : { signal }),
    })
    if (response.ok) content = parseTemplatePrompt(await response.json())
  } catch {
    // optional
  }
  if (content === undefined || content.length === 0) {
    content = flattenMessageText(payload.messages)
  }

  let contentCount = 0
  try {
    contentCount = await postJsonTokenCount(
      countUrl,
      { content },
      parseCommonTokenCountResponse,
      signal,
    )
  } catch {
    contentCount = 0
  }

  const promptTokens = Math.max(messagesCount, contentCount)
  if (promptTokens <= 0) {
    throw new Error('prompt token count produced zero from both messages and content paths')
  }
  return {
    promptTokens,
    source: 'tokenizer',
    messagesCount,
    contentCount,
  }
}

/**
 * @param {string} detail
 */
export function looksLikeContextOverflow(detail) {
  if (typeof detail !== 'string' || detail.length === 0) return false
  return /exceed[_-]context[_-]size/i.test(detail)
    || /\b(?:request|prompt|input|messages?)\b.{0,80}\b(?:exceed(?:s|ed)?|overflows?)\b.{0,80}\bcontext\b/i.test(detail)
    || /\bn_prompt_tokens\b.+\bn_ctx\b/i.test(detail)
    || /\bavailable context size\b/i.test(detail)
}
