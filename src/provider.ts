import type { ModelSelection, SDKModel } from "@cursor/sdk";
import type { Model, Provider } from "@earendil-works/pi-ai";
import { abortable, bounded } from "./bridge.ts";
import { loadCursorRuntime, type CursorRuntime } from "./sdk.ts";
import { createCursorStreams, safeError } from "./stream.ts";

export const PROVIDER_ID = "cursor";
export const API_ID = "cursor-sdk";

// Cursor's documented standard context windows, checked 2026-09-06.
// Sources: README.md#context-windows. Do not assume extended/Max context is enabled.
const CONTEXT_WINDOWS = new Map<string, number>([
  ["composer-2.5", 200_000],
  ["composer-2", 200_000], // Cursor redirects this legacy ID to Composer 2.5.
  ["grok-4.5", 256_000],
  ["grok-4.6", 256_000],
  ["claude-sonnet-5", 200_000],
  ["claude-opus-5", 300_000],
  ["claude-opus-5-fast", 300_000],
  ["claude-fable-5", 300_000],
  ["claude-fable-5-1", 300_000],
  ["gemini-3.1-pro", 200_000],
  ["gemini-3.6-flash", 200_000],
  ["gemini-3.8-flash", 200_000],
  ["gpt-5.6-sol", 272_000],
  ["gpt-5.6-sol-fast", 272_000],
  ["gpt-5.6-terra", 272_000],
  ["gpt-5.6-terra-fast", 272_000],
  ["gpt-5.6-luna", 272_000],
  ["gpt-5.6-luna-fast", 272_000],
]);

function defaultContextWindow(model: SDKModel): number {
  for (const id of [model.id, ...(model.aliases ?? [])]) {
    const limit = CONTEXT_WINDOWS.get(id);
    if (limit !== undefined) return limit;
  }
  return 64_000; // Unknown models retain the conservative, unverified fallback.
}

export function defaultSelection(model: SDKModel): ModelSelection {
  const preset = model.variants?.find((variant) => variant.isDefault);
  const params = (model.parameters ?? []).map((parameter) => {
    const selected = preset?.params.find((value) => value.id === parameter.id)?.value ?? parameter.values[0]?.value;
    if (selected === undefined || !parameter.values.some((value) => value.value === selected)) {
      throw new Error(`Cursor model ${model.id} has no valid default for ${parameter.id}`);
    }
    return { id: parameter.id, value: selected };
  });
  return params.length ? { id: model.id, params } : { id: model.id };
}

export function createCursorProvider(dependencies?: {
  loadRuntime?: () => Promise<CursorRuntime>;
  env?: (name: string) => string | undefined;
  cleanupTimeoutMs?: number;
}) {
  const env = dependencies?.env ?? ((name: string) => process.env[name]);
  const integer = (name: string, fallback: number) => {
    const raw = env(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
      throw new Error(`${name} must be a positive integer below 2147483648`);
    }
    return value;
  };
  const contextWindowOverride = env("PI_CURSOR_CONTEXT_WINDOW") === undefined
    ? undefined : integer("PI_CURSOR_CONTEXT_WINDOW", 64_000);
  const maxTokens = integer("PI_CURSOR_MAX_TOKENS", 8_192);
  if (contextWindowOverride !== undefined && maxTokens >= contextWindowOverride) {
    throw new Error("PI_CURSOR_MAX_TOKENS must be below PI_CURSOR_CONTEXT_WINDOW");
  }
  let runtime: Promise<CursorRuntime> | undefined;
  const loadRuntime = () => runtime ??= (dependencies?.loadRuntime ?? loadCursorRuntime)().catch((error) => {
    runtime = undefined;
    throw error;
  });
  let selections = new Map<string, ModelSelection>();
  let models: readonly Model<typeof API_ID>[] = [];
  const streams = createCursorStreams(loadRuntime, (id) => {
    const selection = selections.get(id);
    if (!selection) throw new Error(`Cursor model ${id} is not in the current catalog. Run /cursor-refresh.`);
    return selection;
  }, integer("PI_CURSOR_TIMEOUT_MS", 300_000), dependencies?.cleanupTimeoutMs);

  const provider: Provider<typeof API_ID> = {
    id: PROVIDER_ID,
    name: "Cursor SDK (experimental)",
    baseUrl: "https://api.cursor.com",
    auth: {
      apiKey: {
        name: "Cursor user or service account API key",
        async login(interaction) {
          const key = (await interaction.prompt({ type: "secret", message: "Cursor API key (cursor.com/dashboard/api)" })).trim();
          if (!key) throw new Error("Cursor API key cannot be empty");
          return { type: "api_key", key };
        },
        async resolve({ credential, ctx, signal }) {
          signal.throwIfAborted();
          const key = credential?.key?.trim() || (await ctx.env("CURSOR_API_KEY"))?.trim();
          return key ? {
            auth: { apiKey: key }, source: credential?.key?.trim() ? "stored Cursor API key" : "CURSOR_API_KEY",
          } : undefined;
        },
      },
    },
    getModels: () => models,
    async refreshModels(context) {
      if (!context.allowNetwork) return;
      context.signal.throwIfAborted();
      const apiKey = (context.credential?.type === "api_key" ? context.credential.key?.trim() : undefined)
        || env("CURSOR_API_KEY")?.trim();
      if (!apiKey) throw new Error("Use /login cursor or set CURSOR_API_KEY, then run /cursor-refresh");
      try {
        const sdk = await abortable(loadRuntime(), context.signal);
        // The SDK catalog API exposes no signal. Bound the wait and do not publish late results.
        const catalog = await bounded(sdk.listModels(apiKey), 15_000, "Cursor model discovery", context.signal);
        const nextSelections = new Map<string, ModelSelection>();
        const nextModels = catalog.map((item): Model<typeof API_ID> => {
          if (!item.id || nextSelections.has(item.id)) throw new Error("Cursor returned an invalid or duplicate model ID");
          nextSelections.set(item.id, defaultSelection(item));
          const contextWindow = contextWindowOverride ?? defaultContextWindow(item);
          if (maxTokens >= contextWindow) {
            throw new Error(`PI_CURSOR_MAX_TOKENS must be below the context window for ${item.id} (${contextWindow})`);
          }
          return {
            id: item.id, name: item.displayName || item.id, provider: PROVIDER_ID, api: API_ID,
            baseUrl: "https://api.cursor.com", reasoning: false, input: ["text"],
            contextWindow, maxTokens,
            // Catalog responses do not include prices or model token limits.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          };
        });
        context.signal.throwIfAborted();
        await context.publish({ update: () => { selections = nextSelections; models = nextModels; } });
      } catch (error) {
        throw new Error(safeError(error, apiKey));
      }
    },
    stream: streams.stream,
    streamSimple: streams.streamSimple,
  };
  return { provider, close: streams.close };
}
