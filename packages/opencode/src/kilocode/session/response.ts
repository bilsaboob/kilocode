import { APICallError, type LanguageModelMiddleware } from "ai"
import { Usage, type FinishReason, type LLMEvent, type ProviderMetadata } from "@opencode-ai/llm"
import { isRecord } from "@/util/record"

export namespace KiloResponse {
  export type Receipt = {
    key: string
    source: "openai-responses" | "normalized"
    status: "pending" | "created" | "completed" | "incomplete" | "failed" | "missing" | "aborted"
    responseID?: string
    reason?: string
    finish?: FinishReason
    error?: { code?: string; message?: string; param?: string; type?: string }
    usage?: Usage
    measurement?: Usage
    measurementInvalid?: boolean
    observedAt?: number
    metadata?: ProviderMetadata
    observed: boolean
    finished: boolean
    aborted?: boolean
  }

  const record = (value: unknown) => (isRecord(value) ? value : undefined)
  const text = (value: unknown, max = 256) =>
    typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f]/g, " ").slice(0, max) : undefined
  const number = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
  const amount = (value: unknown) => number(typeof value === "string" && value.trim() ? Number(value) : value)

  export function blocked(value: unknown): boolean {
    const item = record(value)
    return [record(item?.data)?.message, item?.message].some(
      (message) =>
        typeof message === "string" &&
        /\[(?:RESPONSE_(?:INCOMPLETE|FAILED|TERMINAL_MISSING)|STRUCTURED_OUTPUT_(?:UNAVAILABLE|INCOMPLETE)|COMPACTION_(?:INCOMPLETE|RESOURCE_LIMIT))\]/.test(
          message,
        ),
    )
  }

  function usage(value: unknown, raw = false) {
    const item = record(value)
    if (!item) return undefined
    const input = record(item.inputTokens)
    const output = record(item.outputTokens)
    const values = {
      inputTokens: raw ? item.input_tokens : input ? input.total : item.inputTokens,
      outputTokens: raw ? item.output_tokens : output ? output.total : item.outputTokens,
      totalTokens: raw ? item.total_tokens : item.totalTokens,
      reasoningTokens: raw
        ? record(item.output_tokens_details)?.reasoning_tokens
        : (output?.reasoning ?? item.reasoningTokens),
      cacheReadInputTokens: raw
        ? record(item.input_tokens_details)?.cached_tokens
        : (input?.cacheRead ?? item.cacheReadInputTokens),
      cacheWriteInputTokens: input?.cacheWrite ?? item.cacheWriteInputTokens,
    }
    const invalid = Object.values(values).some((value) => value != null && number(value) === undefined)
    const fields = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, number(value)])) as Record<
      keyof typeof values,
      number | undefined
    >
    const metadata = record(item.providerMetadata)
    const details =
      record(item.cost_details) ??
      record(record(item.raw)?.cost_details) ??
      record(record(metadata?.aiSdk)?.cost_details) ??
      record(record(metadata?.openai)?.cost_details) ??
      record(record(metadata?.anthropic)?.cost_details)
    const cost = amount(details?.upstream_inference_cost)
    const known = cost !== undefined || Object.values(fields).some((value) => value !== undefined)
    if (!known && !invalid) return undefined
    return {
      invalid,
      measurement: new Usage(fields),
      value: known
        ? new Usage({
            ...fields,
            providerMetadata:
              cost === undefined ? undefined : { aiSdk: { cost_details: { upstream_inference_cost: cost } } },
            totalTokens:
              fields.totalTokens ??
              (fields.inputTokens !== undefined && fields.outputTokens !== undefined
                ? fields.inputTokens + fields.outputTokens
                : undefined),
          })
        : undefined,
    }
  }

  function provenance(value?: Usage) {
    const openai = record(value?.providerMetadata?.openai)
    if (openai)
      return {
        inputTokens: openai.prompt_tokens,
        outputTokens: openai.completion_tokens,
        totalTokens: openai.total_tokens,
        cacheReadInputTokens: record(openai.prompt_tokens_details)?.cached_tokens,
        reasoningTokens: record(openai.completion_tokens_details)?.reasoning_tokens,
      }
    const anthropic = record(value?.providerMetadata?.anthropic)
    if (anthropic)
      return {
        inputTokens: number(anthropic.input_tokens) === undefined ? anthropic.input_tokens : value?.inputTokens,
        outputTokens: anthropic.output_tokens,
        cacheReadInputTokens: anthropic.cache_read_input_tokens,
        cacheWriteInputTokens: anthropic.cache_creation_input_tokens,
      }
    const google = record(value?.providerMetadata?.google)
    if (google)
      return {
        inputTokens: google.promptTokenCount,
        outputTokens:
          number(google.candidatesTokenCount) === undefined ? google.candidatesTokenCount : value?.outputTokens,
        totalTokens: google.totalTokenCount,
        cacheReadInputTokens: google.cachedContentTokenCount,
        reasoningTokens: google.thoughtsTokenCount,
      }
    return record(value?.providerMetadata?.bedrock)
  }

  export function error(receipt: Receipt) {
    const marker =
      receipt.status === "incomplete"
        ? "RESPONSE_INCOMPLETE"
        : receipt.status === "failed"
          ? "RESPONSE_FAILED"
          : receipt.status === "missing"
            ? "RESPONSE_TERMINAL_MISSING"
            : undefined
    if (!marker) return undefined
    const detail = [receipt.error?.code, receipt.error?.message, receipt.reason].filter(Boolean).join(": ")
    return new APICallError({
      message: `[${marker}] ${detail || "The provider response did not complete successfully"}. The response will not be automatically replayed.`,
      url: "",
      requestBodyValues: {},
      isRetryable: false,
      responseBody: JSON.stringify(metadata(receipt)),
    })
  }

  export function metadata(receipt: Receipt) {
    return {
      receiptID: receipt.key,
      source: receipt.source,
      status: receipt.status,
      responseID: receipt.responseID,
      reason: receipt.reason,
      error: receipt.error,
      usageReported: receipt.usage !== undefined,
      aborted: receipt.aborted,
    }
  }

  export function collector(opts: { now?: () => number } = {}) {
    const receipts: Receipt[] = []
    let stopped = false
    const begin = (responses = false) => {
      const receipt: Receipt = {
        key: crypto.randomUUID(),
        source: responses ? "openai-responses" : "normalized",
        status: stopped ? "aborted" : "pending",
        aborted: stopped || undefined,
        observed: false,
        finished: false,
      }
      receipts.push(receipt)
      return receipt
    }
    const current = () => receipts.at(-1) ?? begin()
    const merge = (prior: Usage | undefined, next: Usage) =>
      prior
        ? new Usage({
            inputTokens: prior.inputTokens ?? next.inputTokens,
            outputTokens: prior.outputTokens ?? next.outputTokens,
            totalTokens: prior.totalTokens ?? next.totalTokens,
            reasoningTokens: prior.reasoningTokens ?? next.reasoningTokens,
            cacheReadInputTokens: prior.cacheReadInputTokens ?? next.cacheReadInputTokens,
            cacheWriteInputTokens: prior.cacheWriteInputTokens ?? next.cacheWriteInputTokens,
            providerMetadata: prior.providerMetadata ?? next.providerMetadata,
          })
        : next
    const retain = (receipt: Receipt, value: unknown, raw = false, reported = true) => {
      const next = usage(value, raw)
      if (!next) return
      if (reported && next.invalid) receipt.measurementInvalid = true
      if (next.value) receipt.usage = merge(receipt.usage, next.value)
      if (!reported || Object.values(next.measurement).every((value) => number(value) === undefined)) return
      receipt.measurement = merge(receipt.measurement, next.measurement)
      receipt.observedAt ??= (opts.now ?? Date.now)()
    }
    const raw = (receipt: Receipt, value: unknown) => {
      if (receipt.aborted) return
      const item = record(value)
      if (typeof item?.type !== "string" || !item.type.startsWith("response.")) return
      receipt.source = "openai-responses"
      receipt.observed = true
      const response = record(item.response)
      if (item.type === "response.created") {
        receipt.responseID = text(response?.id) ?? receipt.responseID
        if (receipt.status === "pending") receipt.status = "created"
        return
      }
      if (!["response.completed", "response.incomplete", "response.failed"].includes(item.type)) return
      receipt.responseID = text(response?.id) ?? receipt.responseID
      if (!["incomplete", "failed", "missing"].includes(receipt.status))
        receipt.status =
          item.type === "response.completed" ? "completed" : item.type === "response.failed" ? "failed" : "incomplete"
      receipt.reason = text(record(response?.incomplete_details)?.reason) ?? receipt.reason
      const failure = record(response?.error)
      if (failure)
        receipt.error = {
          code: text(failure.code),
          message: text(failure.message, 1024),
          param: text(failure.param),
          type: text(failure.type),
        }
      retain(receipt, response?.usage, true)
      if (receipt.status === "completed" && !response) receipt.status = "missing"
    }
    const normalized = (
      receipt: Receipt,
      reason: string,
      value?: unknown,
      metadata?: ProviderMetadata,
      observe = true,
    ) => {
      if (receipt.aborted) return
      const reported = observe && !receipt.finished
      receipt.observed = true
      receipt.finished = true
      receipt.finish =
        reason === "stop" ||
        reason === "tool-calls" ||
        reason === "length" ||
        reason === "content-filter" ||
        reason === "error"
          ? reason
          : "unknown"
      receipt.responseID = text(metadata?.openai?.responseId) ?? receipt.responseID
      // Preserve the provider fields before SDK adapters derive totals or synthesize zero usage.
      if (receipt.source !== "openai-responses") retain(receipt, value, false, reported)
      // Only billing fields survive beyond event processing; never retain arbitrary provider metadata.
      const router = record(metadata?.openrouter?.usage)
      const prior = record(receipt.metadata?.openrouter?.usage)
      receipt.metadata = {
        openrouter: {
          usage: {
            cost: amount(prior?.cost) ?? amount(router?.cost),
            costDetails: {
              upstreamInferenceCost:
                amount(record(prior?.costDetails)?.upstreamInferenceCost) ??
                amount(record(router?.costDetails)?.upstreamInferenceCost),
            },
          },
        },
        gateway: { marketCost: amount(receipt.metadata?.gateway?.marketCost) ?? amount(metadata?.gateway?.marketCost) },
        anthropic: {
          cacheCreationInputTokens:
            number(receipt.metadata?.anthropic?.cacheCreationInputTokens) ??
            number(metadata?.anthropic?.cacheCreationInputTokens),
        },
        vertex: {
          cacheCreationInputTokens:
            number(receipt.metadata?.vertex?.cacheCreationInputTokens) ??
            number(metadata?.vertex?.cacheCreationInputTokens),
        },
        bedrock: {
          usage: {
            cacheWriteInputTokens:
              number(record(receipt.metadata?.bedrock?.usage)?.cacheWriteInputTokens) ??
              number(record(metadata?.bedrock?.usage)?.cacheWriteInputTokens),
          },
        },
      }
      if (reason === "length" && receipt.status !== "failed") {
        receipt.status = "incomplete"
        receipt.reason ??= "max_output_tokens"
      }
      if (receipt.status === "pending" || receipt.status === "created") {
        receipt.status =
          receipt.source === "openai-responses" || !["stop", "tool-calls"].includes(reason) ? "missing" : "completed"
      }
    }
    const event = (event: LLMEvent, native = false) => {
      if (stopped) return undefined
      const output =
        ((event.type === "text-delta" || event.type === "reasoning-delta") && event.text) || event.type === "tool-call"
      const data = "providerMetadata" in event ? record(event.providerMetadata?.kiloResponse) : undefined
      if (!receipts.length && !data && !output && event.type !== "step-finish" && event.type !== "finish")
        return undefined
      const id = text(data?.receiptID)
      const provider = text(data?.responseID)
      const matched = receipts.find(
        (receipt) => (id && receipt.key === id) || (provider && receipt.responseID === provider),
      )
      const receipt =
        matched ?? (provider && current().responseID && current().responseID !== provider ? begin(true) : current())
      // Aggregates are not another provider response or a new billing source.
      if (event.type === "finish" && receipt.finished) return receipt
      if (output) receipt.observed = true
      if (data?.source === "openai-responses") {
        receipt.source = "openai-responses"
        receipt.observed = true
        receipt.responseID = text(data.responseID) ?? receipt.responseID
        if (
          !["incomplete", "failed", "missing"].includes(receipt.status) &&
          (data.status === "created" ||
            data.status === "completed" ||
            data.status === "incomplete" ||
            data.status === "failed" ||
            data.status === "missing")
        )
          receipt.status = data.status
        receipt.reason = text(data.reason) ?? receipt.reason
        if (data.status !== "created") retain(receipt, data.usage)
        const failure = record(data.error)
        if (failure)
          receipt.error = {
            code: text(failure.code),
            message: text(failure.message, 1024),
            type: text(failure.type),
            param: text(failure.param),
          }
      }
      if (event.type === "step-finish" || event.type === "finish") {
        if (data?.source === "openai-responses") retain(receipt, event.usage, false, false)
        // Native parsers keep original token fields separately from synthesized billing totals.
        if (native && receipt.source !== "openai-responses" && !receipt.finished)
          retain(receipt, provenance(event.usage))
        normalized(receipt, event.reason, event.usage, event.providerMetadata, !native)
      }
      return receipt
    }
    const failure = (cause?: unknown) => {
      const failed = receipts.find((receipt) => receipt.observed && !receipt.aborted && error(receipt))
      if (failed) return error(failed)
      const receipt = receipts.at(-1)
      if (!receipt || !receipt.observed || receipt.aborted) return undefined
      if (cause && !["incomplete", "failed", "missing"].includes(receipt.status)) {
        receipt.status = "missing"
        receipt.error = { message: text(cause instanceof Error ? cause.message : undefined, 1024) }
      }
      return error(receipt)
    }
    return {
      receipts,
      begin,
      current,
      raw,
      normalized,
      event,
      native(value: LLMEvent) {
        if (!stopped && value.type === "step-start" && receipts.at(-1)?.finished && !failure()) begin()
        return event(value, true)
      },
      failure,
      interrupt() {
        stopped = true
        for (const receipt of receipts) {
          receipt.aborted = true
          if (receipt.status === "created" || receipt.status === "pending") receipt.status = "aborted"
        }
      },
      end() {
        const receipt = receipts.at(-1)
        if (receipt?.observed && !receipt.finished && !receipt.aborted && !failure()) receipt.status = "missing"
        return failure()
      },
    }
  }

  export type Collector = ReturnType<typeof collector>

  export function middleware(collector: Collector): LanguageModelMiddleware {
    return {
      specificationVersion: "v3",
      transformParams: async ({ params }) => ({ ...params, includeRawChunks: true }),
      async wrapStream({ doStream, model }) {
        const receipt = collector.begin(model.provider.includes("responses"))
        const result = await doStream()
        if (!receipt.aborted) receipt.observed = true
        const reader = result.stream.getReader()
        const stream = new ReadableStream({
          async pull(controller) {
            try {
              const next = await reader.read()
              if (next.done) controller.close()
              else controller.enqueue(next.value)
            } catch (cause) {
              controller.error(collector.failure(cause) ?? cause)
            }
          },
          cancel: (reason) => reader.cancel(reason),
        })
        let failed = false
        return {
          ...result,
          stream: stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                if (receipt.aborted) return
                if (chunk.type === "text-delta" || chunk.type === "reasoning-delta" || chunk.type === "tool-call")
                  receipt.observed = true
                if (chunk.type === "raw") {
                  collector.raw(receipt, chunk.rawValue)
                  const failure = error(receipt)
                  if (failure && !failed) {
                    failed = true
                    controller.enqueue({ type: "error", error: failure })
                  }
                  return
                }
                if (chunk.type === "finish") {
                  collector.normalized(receipt, chunk.finishReason.unified, chunk.usage, chunk.providerMetadata)
                  const failure = error(receipt)
                  if (failure && !failed) controller.enqueue({ type: "error", error: failure })
                  if (failure || failed) {
                    failed = true
                    return
                  }
                  controller.enqueue({
                    ...chunk,
                    providerMetadata: { ...chunk.providerMetadata, kiloResponse: { receiptID: receipt.key } },
                  })
                  return
                }
                if (chunk.type === "error") {
                  if (failed) return
                  failed = true
                  controller.enqueue({ ...chunk, error: collector.failure(chunk.error) ?? chunk.error })
                  return
                }
                if (!failed) controller.enqueue(chunk)
              },
              flush(controller) {
                if (failed || receipt.finished || receipt.aborted) return
                receipt.observed = true
                receipt.status = "missing"
                controller.enqueue({ type: "error", error: error(receipt) })
              },
            }),
          ),
        }
      },
    }
  }
}
