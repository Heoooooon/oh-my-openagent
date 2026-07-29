import type { ComponentContext, OmoSenpiComponent, SenpiExtensionAPI } from "../../extension/types"

// DashScope thinking-only Qwen models (qwen3-max family) reject
// enable_thinking: false with HTTP 400 ("restricted to True"), while hybrid
// models reject true. pi-ai sends false on calls without a thinking level
// (title generation, summarization); omitting the field is the only
// universally legal value, so the guard strips an explicit false.
const THINKING_ONLY_QWEN = /^qwen3(?:\.\d+)?-max(?:-|$)/

type OpenAiCompletionsBody = Record<string, unknown> & {
  model?: unknown
  enable_thinking?: unknown
}

interface BeforeProviderRequestEvent {
  payload: unknown
}

export function sanitizeQwenThinkingPayload(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) {
    return payload
  }
  const body = payload as OpenAiCompletionsBody
  if (body.enable_thinking !== false) {
    return payload
  }
  if (typeof body.model !== "string" || !THINKING_ONLY_QWEN.test(body.model)) {
    return payload
  }
  const sanitized = { ...body }
  delete sanitized.enable_thinking
  return sanitized
}

export function createQwenThinkingGuardComponent(): OmoSenpiComponent {
  return {
    name: "qwen-thinking-guard",
    register(pi: SenpiExtensionAPI, _ctx: ComponentContext): void {
      pi.on("before_provider_request", (event: unknown) => {
        const request = event as BeforeProviderRequestEvent
        return sanitizeQwenThinkingPayload(request.payload)
      })
    },
  }
}
