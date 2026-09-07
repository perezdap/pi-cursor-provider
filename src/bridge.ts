import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InteractionUpdate, ModelSelection, SDKCustomTool, SDKCustomToolResult, TokenUsage } from "@cursor/sdk";
import type { Context, ToolCall } from "@earendil-works/pi-ai";
import { BRIDGE_INSTRUCTIONS, serializeHistory } from "./history.ts";
import type { CursorAgent, CursorRun, CursorRuntime } from "./sdk.ts";

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new Error("Request aborted"));
    };
    signal.addEventListener("abort", abort, { once: true });
    // Attach both handlers even when already aborted, so late rejections are consumed.
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

export async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(`${label} timed out`)), timeoutMs);
  try {
    return await abortable(promise, combined);
  } finally {
    clearTimeout(timer);
  }
}

export interface TurnOptions {
  apiKey: string;
  model: ModelSelection;
  signal: AbortSignal;
  cleanupTimeoutMs?: number;
  onDelta(update: InteractionUpdate): void;
}

export interface TurnResult {
  calls: ToolCall[];
  usage?: TokenUsage;
  text?: string;
}

export async function runCursorTurn(runtime: CursorRuntime, context: Context, options: TurnOptions): Promise<TurnResult> {
  options.signal.throwIfAborted();
  const prompt = serializeHistory(context);
  const cleanupTimeout = options.cleanupTimeoutMs ?? 10_000;
  // Cleanup performs up to three sequential bounded waits: run cancellation,
  // agent disposal, and directory removal. Budget one cleanupTimeout for each.
  const cleanupBudgetMs = cleanupTimeout * 3;
  const root = await mkdtemp(join(tmpdir(), "pi-cursor-"));
  const workspace = join(root, "workspace");
  const calls: ToolCall[] = [];
  let capturing = true;
  let releaseTools!: () => void;
  const toolRelease = new Promise<void>((resolve) => { releaseTools = resolve; });
  let requestHandoff!: () => void;
  const handoff = new Promise<"handoff">((resolve) => { requestHandoff = () => resolve("handoff"); });
  let agent: CursorAgent | undefined;
  let run: CursorRun | undefined;
  let pendingAgent: Promise<CursorAgent> | undefined;
  let pendingRun: Promise<CursorRun> | undefined;
  let result: TurnResult | undefined;
  let failure: unknown;

  try {
    await mkdir(workspace);
    options.signal.throwIfAborted();
    const customTools: Record<string, SDKCustomTool> = Object.create(null);
    for (const [index, tool] of (context.tools ?? []).entries()) {
      customTools[`pi_${index}`] = {
        description: `Pi tool: ${tool.name}\n${tool.description}`,
        inputSchema: JSON.parse(JSON.stringify(tool.parameters)),
        async execute(args): Promise<SDKCustomToolResult> {
          if (capturing && !options.signal.aborted) {
            // These callbacks only capture requests. Never call a Pi tool here.
            calls.push({
              type: "toolCall", id: `cursor_${randomUUID()}`, name: tool.name,
              arguments: JSON.parse(JSON.stringify(args)),
            });
            requestHandoff();
          }
          await toolRelease;
          return { content: [{ type: "text", text: "Not executed. Execution belongs to the Pi host." }], isError: true };
        },
      };
    }

    pendingAgent = runtime.create({
      apiKey: options.apiKey,
      model: options.model,
      systemPrompt: `${context.systemPrompt ?? ""}\n\n${BRIDGE_INSTRUCTIONS}`,
      tools: Object.keys(customTools).length ? ["mcp"] : [],
      mcpServers: {},
      agents: {},
      local: {
        cwd: workspace,
        settingSources: [],
        enableAgentRetries: false,
        customTools,
        store: runtime.createStore(join(root, "state")),
      },
    });
    agent = await abortable(pendingAgent, options.signal);
    options.signal.throwIfAborted();
    pendingRun = agent.send(prompt, {
      onDelta: ({ update }) => {
        if (capturing && !options.signal.aborted && calls.length === 0) options.onDelta(update);
      },
    });
    run = await abortable(pendingRun, options.signal);
    const outcome = await abortable(Promise.race([handoff, run.wait()]), options.signal);
    if (outcome === "handoff") {
      // Keep callbacks pending until the SDK acknowledges cancellation. A failure
      // here must not produce a successful Pi tool-calling message.
      await bounded(run.cancel(), cleanupTimeout, "Cursor cancellation");
      if (run.status !== "cancelled") throw new Error("Cursor did not acknowledge tool-handoff cancellation");
      result = { calls, usage: run.usage };
    } else {
      if (outcome.status !== "finished") {
        throw new Error(outcome.error?.message ?? `Cursor run ${outcome.status}`);
      }
      result = { calls: [], text: outcome.result, usage: outcome.usage };
    }
    options.signal.throwIfAborted();
  } catch (error) {
    failure = error;
  } finally {
    capturing = false;
    // If create/send resolves after an abort, its continuation still owns cleanup.
    // Do not delete its state directory before that continuation has finished.
    const cleanup = async () => {
      const ownedAgent = agent ?? await pendingAgent?.catch(() => undefined);
      const ownedRun = run ?? await pendingRun?.catch(() => undefined);
      try {
        if (ownedRun?.status === "running") {
          await bounded(ownedRun.cancel(), cleanupTimeout, "Cursor cancellation");
          if (ownedRun.status === "running") throw new Error("Cursor run is still active after cancellation");
        }
      } finally {
        releaseTools();
        if (ownedAgent) await bounded(ownedAgent[Symbol.asyncDispose](), cleanupTimeout, "Cursor disposal");
      }
      await rm(root, { recursive: true, force: true });
    };
    try {
      await bounded(cleanup(), cleanupBudgetMs, "Cursor cleanup");
    } catch (error) {
      releaseTools();
      failure = failure ? new AggregateError([failure, error], "Cursor request and cleanup failed") : error;
    }
  }
  if (failure) throw failure;
  options.signal.throwIfAborted();
  if (!result) throw new Error("Cursor returned no result");
  return result;
}
