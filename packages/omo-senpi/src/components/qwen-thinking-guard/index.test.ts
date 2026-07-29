import { describe, expect, it } from "bun:test"

import { FakeExtensionAPI } from "../../../test-support/fake-extension-api"
import type { ComponentContext } from "../../extension/types"
import { createQwenThinkingGuardComponent, sanitizeQwenThinkingPayload } from "./index"

function thinkingOnlyBody(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "qwen3.8-max-preview",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 64,
    ...extra,
  }
}

function componentContext(): ComponentContext {
  return {
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    config: { getFlag: () => false },
  }
}

describe("qwen-thinking-guard payload sanitization", () => {
  it("#given a thinking-only qwen model #when enable_thinking is false #then the field is omitted and the rest preserved", () => {
    const input = thinkingOnlyBody({ enable_thinking: false })

    const output = sanitizeQwenThinkingPayload(input) as Record<string, unknown>

    expect("enable_thinking" in output).toBe(false)
    expect(output.model).toBe("qwen3.8-max-preview")
    expect(output.max_tokens).toBe(64)
    expect(input.enable_thinking).toBe(false)
  })

  it("#given qwen3-max #when enable_thinking is false #then the field is omitted", () => {
    const output = sanitizeQwenThinkingPayload({
      model: "qwen3-max",
      enable_thinking: false,
    }) as Record<string, unknown>

    expect("enable_thinking" in output).toBe(false)
  })

  it("#given a hybrid qwen model #when enable_thinking is false #then the explicit disable survives", () => {
    const input = { model: "qwen3-coder-480b", enable_thinking: false }

    expect(sanitizeQwenThinkingPayload(input)).toBe(input)
  })

  it("#given enable_thinking is true #when the payload passes #then it is untouched", () => {
    const input = thinkingOnlyBody({ enable_thinking: true })

    expect(sanitizeQwenThinkingPayload(input)).toBe(input)
  })

  it("#given a non-qwen body #when enable_thinking is false #then it is untouched", () => {
    const input = { model: "gpt-5.2", enable_thinking: false }

    expect(sanitizeQwenThinkingPayload(input)).toBe(input)
  })

  it("#given a non-object payload #when sanitized #then it passes through", () => {
    expect(sanitizeQwenThinkingPayload(null)).toBeNull()
    expect(sanitizeQwenThinkingPayload("text")).toBe("text")
  })
})

describe("qwen-thinking-guard registration", () => {
  it("#given the component is registered #when before_provider_request fires #then the emitted payload is sanitized", async () => {
    const pi = new FakeExtensionAPI()
    await createQwenThinkingGuardComponent().register(pi, componentContext())

    const results = await pi.dispatch(
      "before_provider_request",
      { type: "before_provider_request", payload: thinkingOnlyBody({ enable_thinking: false }) },
      undefined,
    )

    const sanitized = results[0] as Record<string, unknown>
    expect("enable_thinking" in sanitized).toBe(false)
    expect(sanitized.model).toBe("qwen3.8-max-preview")
  })

  it("#given a healthy payload #when before_provider_request fires #then the same object passes through", async () => {
    const pi = new FakeExtensionAPI()
    await createQwenThinkingGuardComponent().register(pi, componentContext())
    const payload = thinkingOnlyBody({ enable_thinking: true })

    const results = await pi.dispatch(
      "before_provider_request",
      { type: "before_provider_request", payload },
      undefined,
    )

    expect(results[0]).toBe(payload)
  })
})
