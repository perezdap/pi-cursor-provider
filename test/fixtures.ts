import type { AgentOptions, InteractionUpdate, LocalAgentStore, RunResult, SendOptions, SDKModel, TokenUsage } from "@cursor/sdk";
import type { AssistantMessage, Context, Model, Tool } from "@earendil-works/pi-ai";
import type { CursorRun, CursorRuntime } from "../src/sdk.ts";

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export const model: Model<string> = {
  id: "test-model", name: "Test", api: "cursor-sdk", provider: "cursor", baseUrl: "https://api.cursor.com",
  reasoning: false, input: ["text"], contextWindow: 64000, maxTokens: 8192,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
export const usage: TokenUsage = { inputTokens: 7, outputTokens: 3, cacheReadTokens: 2, cacheWriteTokens: 1, totalTokens: 13 };
export const tool: Tool = {
  name: "pwsh", description: "Execute PowerShell",
  parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } as Tool["parameters"],
};
export const context: Context = {
  systemPrompt: "You are Pi. Ask before destructive commands.", tools: [tool],
  messages: [{ role: "user", content: "Inspect the repository", timestamp: 1 }],
};

export interface Scenario {
  options: AgentOptions;
  prompt: string;
  delta(update: InteractionUpdate): Promise<void>;
  finish(text?: string, tokens?: TokenUsage): void;
  fail(message: string): void;
}

export function fakeRuntime(scenario: (scenario: Scenario) => void | Promise<void> = ({ finish }) => finish("OK")) {
  const state = {
    creates: [] as AgentOptions[], prompts: [] as string[], stores: [] as string[],
    cancellations: 0, disposals: 0, catalogCalls: [] as string[],
    catalog: [{ id: model.id, displayName: "Test model" }] as SDKModel[],
    cancelError: undefined as Error | undefined,
    disposeError: undefined as Error | undefined,
    createError: undefined as Error | undefined,
    sendError: undefined as Error | undefined,
    catalogError: undefined as Error | undefined,
    cancelAcknowledges: true,
    cancelGate: undefined as Promise<void> | undefined,
    createGate: undefined as Promise<void> | undefined,
    sendGate: undefined as Promise<void> | undefined,
    catalogGate: undefined as Promise<void> | undefined,
    started: deferred<void>(),
  };
  const runtime: CursorRuntime = {
    createStore(directory) { state.stores.push(directory); return {} as LocalAgentStore; },
    async listModels(apiKey) {
      state.catalogCalls.push(apiKey);
      await state.catalogGate;
      if (state.catalogError) throw state.catalogError;
      return state.catalog;
    },
    async create(options) {
      state.creates.push(options);
      await state.createGate;
      if (state.createError) throw state.createError;
      return {
        async send(prompt: string, sendOptions?: SendOptions): Promise<CursorRun> {
          state.prompts.push(prompt);
          if (state.sendError) throw state.sendError;
          const terminal = deferred<RunResult>();
          let status: CursorRun["status"] = "running";
          let tokens: TokenUsage | undefined;
          const run: CursorRun = {
            get status() { return status; },
            get usage() { return tokens; },
            wait: () => terminal.promise,
            async cancel() {
              state.cancellations++;
              await state.cancelGate;
              if (state.cancelError) throw state.cancelError;
              if (state.cancelAcknowledges) {
                status = "cancelled";
                terminal.resolve({ id: "run", status, usage: tokens });
              }
            },
          };
          const scenarioInput: Scenario = {
            options, prompt,
            async delta(update) {
              if (update.type === "turn-ended" && update.usage) {
                const u = update.usage;
                tokens = { ...u, totalTokens: u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens };
              }
              await sendOptions?.onDelta?.({ update });
            },
            finish(text, reportedUsage) {
              if (status !== "running") return;
              status = "finished";
              tokens = reportedUsage ?? tokens;
              terminal.resolve({ id: "run", status, result: text, usage: tokens });
            },
            fail(message) {
              if (status !== "running") return;
              status = "error";
              terminal.resolve({ id: "run", status, error: { message } });
            },
          };
          state.started.resolve();
          void Promise.resolve().then(() => scenario(scenarioInput)).catch((error) => scenarioInput.fail(String(error)));
          await state.sendGate;
          return run;
        },
        async [Symbol.asyncDispose]() {
          state.disposals++;
          if (state.disposeError) throw state.disposeError;
        },
      };
    },
  };
  return { runtime, state };
}

export function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [], stopReason: "stop", timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...overrides,
  };
}
