import type { AgentOptions, LocalAgentStore, Run, SDKModel, SendOptions } from "@cursor/sdk";

export type CursorRun = Pick<Run, "wait" | "cancel" | "status" | "usage">;
export interface CursorAgent {
  send(message: string, options?: SendOptions): Promise<CursorRun>;
  [Symbol.asyncDispose](): Promise<void>;
}

export interface CursorRuntime {
  create(options: AgentOptions): Promise<CursorAgent>;
  createStore(directory: string): LocalAgentStore;
  listModels(apiKey: string): Promise<SDKModel[]>;
}

export async function loadCursorRuntime(): Promise<CursorRuntime> {
  const { Agent, Cursor, JsonlLocalAgentStore } = await import("@cursor/sdk");
  return {
    create: (options) => Agent.create(options),
    createStore: (directory) => new JsonlLocalAgentStore(directory),
    listModels: (apiKey) => Cursor.models.list({ apiKey }),
  };
}
