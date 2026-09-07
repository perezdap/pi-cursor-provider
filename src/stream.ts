import type { ModelSelection } from "@cursor/sdk";
import {
  calculateCost, createAssistantMessageEventStream,
  type AssistantMessage, type Context, type Model, type SimpleStreamOptions,
  type TextContent, type ThinkingContent,
} from "@earendil-works/pi-ai";
import { abortable, runCursorTurn } from "./bridge.ts";
import type { CursorRuntime } from "./sdk.ts";

function errorText(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(errorText).join(". ");
  return error instanceof Error ? error.message : String(error);
}

export function safeError(error: unknown, apiKey?: string): string {
  let message = errorText(error);
  if (apiKey) message = message.replaceAll(apiKey, "[redacted]");
  if (/--system-prompt|system.?prompt.*(?:access|allowed|enabled|permission)/i.test(message)) {
    return `Cursor rejected Pi's system prompt. This account needs Cursor SDK system-prompt access. No fallback to Cursor's own prompt was attempted. ${message}`;
  }
  return message;
}

export function createCursorStreams(
  loadRuntime: () => Promise<CursorRuntime>,
  selectModel: (id: string) => ModelSelection,
  requestTimeoutMs = 300_000,
  cleanupTimeoutMs = 10_000,
) {
  const active = new Map<AbortController, Promise<void>>();
  let closed = false;

  function stream(model: Model<string>, context: Context, options?: SimpleStreamOptions) {
    const events = createAssistantMessageEventStream();
    const controller = new AbortController();
    const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
    const output: AssistantMessage = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], timestamp: Date.now(), stopReason: "pending",
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    let open: { block: TextContent | ThinkingContent; index: number } | undefined;
    const endBlock = () => {
      if (!open) return;
      if (open.block.type === "text") {
        events.push({ type: "text_end", contentIndex: open.index, content: open.block.text, partial: output });
      } else {
        events.push({ type: "thinking_end", contentIndex: open.index, content: open.block.thinking, partial: output });
      }
      open = undefined;
    };
    const append = (type: "text" | "thinking", delta: string) => {
      if (!delta) return;
      if (open?.block.type !== type) {
        endBlock();
        const block: TextContent | ThinkingContent = type === "text" ? { type, text: "" } : { type, thinking: "" };
        open = { block, index: output.content.length };
        output.content.push(block);
        if (type === "text") events.push({ type: "text_start", contentIndex: open.index, partial: output });
        else events.push({ type: "thinking_start", contentIndex: open.index, partial: output });
      }
      if (!open) return;
      if (open.block.type === "text") {
        open.block.text += delta;
        events.push({ type: "text_delta", contentIndex: open.index, delta, partial: output });
      } else {
        open.block.thinking += delta;
        events.push({ type: "thinking_delta", contentIndex: open.index, delta, partial: output });
      }
    };

    const done = (async () => {
      const timeoutMs = options?.timeoutMs ?? requestTimeoutMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      events.push({ type: "start", partial: output });
      try {
        if (closed) throw new Error("Cursor provider is shutting down");
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
          throw new Error("Cursor request timeout must be a positive integer below 2147483648 ms");
        }
        timer = setTimeout(() => controller.abort(new Error("Cursor request timed out")), timeoutMs);
        signal.throwIfAborted();
        if (!options?.apiKey?.trim()) throw new Error("Use /login cursor or set CURSOR_API_KEY before selecting a Cursor model");
        if (options.deferred) throw new Error("Cursor prototype does not support deferred responses");
        const runtime = await abortable(loadRuntime(), signal);
        const result = await runCursorTurn(runtime, options.toolChoice === "none" ? { ...context, tools: [] } : context, {
          apiKey: options.apiKey,
          model: selectModel(model.id), signal, cleanupTimeoutMs,
          onDelta(update) {
            if (update.type === "text-delta") append("text", update.text);
            else if (update.type === "thinking-delta") append("thinking", update.text);
            else if (update.type === "thinking-completed") endBlock();
            else if (update.type === "turn-ended" && update.usage) {
              output.usage.input += update.usage.inputTokens;
              output.usage.output += update.usage.outputTokens;
              output.usage.cacheRead += update.usage.cacheReadTokens;
              output.usage.cacheWrite += update.usage.cacheWriteTokens;
            }
          },
        });
        signal.throwIfAborted();
        if (result.usage) {
          output.usage.input = result.usage.inputTokens;
          output.usage.output = result.usage.outputTokens;
          output.usage.cacheRead = result.usage.cacheReadTokens;
          output.usage.cacheWrite = result.usage.cacheWriteTokens;
        }
        // Some SDK paths supply only final text. Never append a second copy of streamed text.
        if (!output.content.some((block) => block.type === "text") && result.text) append("text", result.text);
        endBlock();
        for (const call of result.calls) {
          const contentIndex = output.content.length;
          output.content.push(call);
          events.push({ type: "toolcall_start", contentIndex, partial: output });
          events.push({ type: "toolcall_delta", contentIndex, delta: JSON.stringify(call.arguments), partial: output });
          events.push({ type: "toolcall_end", contentIndex, toolCall: call, partial: output });
        }
        output.stopReason = result.calls.length ? "toolUse" : "stop";
        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        calculateCost(model, output.usage);
        events.push({ type: "done", reason: output.stopReason, message: output });
      } catch (error) {
        endBlock();
        output.stopReason = options?.signal?.aborted || closed ? "aborted" : "error";
        output.errorMessage = safeError(error, options?.apiKey);
        output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
        calculateCost(model, output.usage);
        events.push({ type: "error", reason: output.stopReason, error: output });
      } finally {
        clearTimeout(timer);
        events.end();
      }
    })();
    active.set(controller, done);
    void done.finally(() => active.delete(controller));
    return events;
  }

  return {
    stream,
    streamSimple: stream,
    async close() {
      closed = true;
      for (const controller of active.keys()) controller.abort(new Error("Cursor provider shut down"));
      await Promise.allSettled(active.values());
    },
  };
}
