import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AuthContext, Provider, RefreshModelsContext } from "@earendil-works/pi-ai";
import { createModels, hasApi } from "@earendil-works/pi-ai";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { fileURLToPath } from "node:url";
import { loadExtensions } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { DEFAULT_COMPACTION_SETTINGS, shouldCompact } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/compaction/compaction.js";
import { createCursorProvider, defaultSelection } from "../src/provider.ts";
import { loadCursorRuntime } from "../src/sdk.ts";
import { context, deferred, fakeRuntime, tool } from "./fixtures.ts";

async function refresh(provider: Provider, overrides: Partial<RefreshModelsContext> = {}) {
  await provider.refreshModels!({
    allowNetwork: true, credential: { type: "api_key", key: "fake-key" }, signal: new AbortController().signal,
    publish: async (publication) => { publication.update?.(); return true; },
    ...overrides,
  });
}

const authContext: AuthContext = { env: async () => "environment-key", fileExists: async () => false };

test("imports the real SDK without creating an agent or making an API call", async () => {
  const sdk = await loadCursorRuntime();
  assert.equal(typeof sdk.create, "function");
  assert.equal(typeof sdk.listModels, "function");
  assert.equal(typeof sdk.createStore, "function");
});

test("discovers models and explicit default parameters without hard-coded model IDs", async () => {
  const fake = fakeRuntime();
  fake.state.catalog = [{
    id: "model-from-account", displayName: "Account Model",
    parameters: [{ id: "thinking", values: [{ value: "low" }, { value: "high" }] }],
    variants: [{ displayName: "Default", isDefault: true, params: [{ id: "thinking", value: "high" }] }],
  }];
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime, env: () => undefined });
  assert.deepEqual(provider.getModels(), []);
  await refresh(provider);
  const [model] = provider.getModels();
  assert.equal(model.id, "model-from-account");
  assert.equal(model.name, "Account Model");
  assert.equal(model.provider, "cursor");
  assert.deepEqual(model.input, ["text"]);
  assert.equal(model.reasoning, false);
  const message = await provider.streamSimple(model, context, { apiKey: "fake-key" }).result();
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(fake.state.creates[0].model, { id: "model-from-account", params: [{ id: "thinking", value: "high" }] });
});

test("documented per-model windows replace 64k and delay Pi compaction to the correct threshold", async () => {
  const windows: [string, number][] = [
    ["composer-2.5", 200_000], ["composer-2", 200_000],
    ["grok-4.5", 256_000], ["grok-4.6", 256_000],
    ["claude-sonnet-5", 200_000],
    ["claude-opus-5", 300_000], ["claude-opus-5-fast", 300_000],
    ["claude-fable-5", 300_000], ["claude-fable-5-1", 300_000],
    ["gemini-3.1-pro", 200_000], ["gemini-3.6-flash", 200_000], ["gemini-3.8-flash", 200_000],
    ["gpt-5.6-sol", 272_000], ["gpt-5.6-sol-fast", 272_000],
    ["gpt-5.6-terra", 272_000], ["gpt-5.6-terra-fast", 272_000],
    ["gpt-5.6-luna", 272_000], ["gpt-5.6-luna-fast", 272_000],
  ];
  const fake = fakeRuntime();
  fake.state.catalog = windows.map(([id]) => ({ id, displayName: id }));
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime, env: () => undefined });
  await refresh(provider);
  assert.deepEqual(provider.getModels().map((model) => [model.id, model.contextWindow]), windows);
  assert.equal(shouldCompact(50_000, 64_000, DEFAULT_COMPACTION_SETTINGS), true);
  for (const model of provider.getModels()) {
    assert.equal(model.maxTokens, 8_192);
    assert.equal(shouldCompact(50_000, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), false, model.id);
    const threshold = model.contextWindow - DEFAULT_COMPACTION_SETTINGS.reserveTokens;
    assert.equal(shouldCompact(threshold, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), false, model.id);
    assert.equal(shouldCompact(threshold + 1, model.contextWindow, DEFAULT_COMPACTION_SETTINGS), true, model.id);
  }
});

test("context lookup uses exact catalog IDs then declared aliases, never guessed model families", async () => {
  const fake = fakeRuntime();
  fake.state.catalog = [
    { id: "account-model", displayName: "Account Model", aliases: ["grok-4.6"] },
    { id: "composer-2.5", displayName: "Composer", aliases: ["grok-4.6"] },
    { id: "grok-4.6-next", displayName: "Grok 4.6" },
    { id: "unknown", displayName: "Unknown" },
    { id: "__proto__", displayName: "Unknown" },
  ];
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime, env: () => undefined });
  await refresh(provider);
  assert.deepEqual(provider.getModels().map((model) => model.contextWindow), [256_000, 200_000, 64_000, 64_000, 64_000]);
});

test("fast parameters retain the documented base model context window", async () => {
  const fake = fakeRuntime();
  fake.state.catalog = [{
    id: "composer-2.5", displayName: "Composer 2.5",
    parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }],
    variants: [{ displayName: "Fast", isDefault: true, params: [{ id: "fast", value: "true" }] }],
  }];
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime, env: () => undefined });
  await refresh(provider);
  const [model] = provider.getModels();
  assert.equal(model.contextWindow, 200_000);
  await provider.streamSimple(model, context, { apiKey: "fake-key" }).result();
  assert.deepEqual(fake.state.creates[0].model, { id: "composer-2.5", params: [{ id: "fast", value: "true" }] });
});

test("defaultSelection uses valid defaults and rejects invalid catalogs", () => {
  assert.deepEqual(defaultSelection({ id: "m", displayName: "M" }), { id: "m" });
  assert.deepEqual(defaultSelection({ id: "m", displayName: "M", parameters: [{ id: "fast", values: [{ value: "false" }] }] }), {
    id: "m", params: [{ id: "fast", value: "false" }],
  });
  assert.throws(() => defaultSelection({ id: "m", displayName: "M", parameters: [{ id: "bad", values: [] }] }), /no valid default/);
});

test("auth prioritizes stored keys, supports environment auth and does not imitate OAuth", async () => {
  const { provider } = createCursorProvider();
  const signal = new AbortController().signal;
  const stored = await provider.auth.apiKey!.resolve({ ctx: authContext, credential: { type: "api_key", key: "stored-key" }, signal });
  assert.equal(stored?.auth.apiKey, "stored-key");
  const ambient = await provider.auth.apiKey!.resolve({ ctx: authContext, signal });
  assert.equal(ambient?.auth.apiKey, "environment-key");
  const missing = await provider.auth.apiKey!.resolve({ ctx: { ...authContext, env: async () => undefined }, signal });
  assert.equal(missing, undefined);
  assert.equal(provider.auth.oauth, undefined);
  const login = await provider.auth.apiKey!.login!({
    signal, notify() {}, async prompt(prompt) { assert.equal(prompt.type, "secret"); return "  entered-key  "; },
  });
  assert.deepEqual(login, { type: "api_key", key: "entered-key" });
});

test("offline refresh and factory loading do not import the SDK or call the network", async () => {
  let loads = 0;
  const fake = fakeRuntime();
  const { provider } = createCursorProvider({ loadRuntime: async () => { loads++; return fake.runtime; } });
  assert.equal(loads, 0);
  await refresh(provider, { allowNetwork: false });
  assert.equal(loads, 0);
  assert.equal(fake.state.catalogCalls.length, 0);
});

test("failed, stale and aborted refreshes retain the previous model catalog", async () => {
  const fake = fakeRuntime();
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime });
  await refresh(provider);
  const initial = provider.getModels();
  fake.state.catalog = [{ id: "changed", displayName: "Changed" }];
  await refresh(provider, { publish: async () => false });
  assert.equal(provider.getModels(), initial);
  const gate = deferred<void>();
  fake.state.catalogGate = gate.promise;
  const abort = new AbortController();
  const pending = refresh(provider, { signal: abort.signal });
  while (fake.state.catalogCalls.length < 3) await delay(1);
  abort.abort();
  await assert.rejects(pending);
  gate.resolve();
  assert.equal(provider.getModels(), initial);
  fake.state.catalogError = new Error("Rate limit exceeded fake-key");
  await assert.rejects(refresh(provider), (error: Error) => {
    assert.equal(error.message.includes("fake-key"), false);
    assert.match(error.message, /Rate limit exceeded/);
    return true;
  });
  assert.equal(provider.getModels(), initial);
});

test("duplicate model IDs do not replace a working catalog", async () => {
  const fake = fakeRuntime();
  const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime });
  await refresh(provider);
  const initial = provider.getModels();
  fake.state.catalog = [fake.state.catalog[0], fake.state.catalog[0]];
  await assert.rejects(refresh(provider), /duplicate model ID/);
  assert.equal(provider.getModels(), initial);
});

test("validates local budget settings without claiming SDK token-limit enforcement", async () => {
  for (const value of ["garbage", "-1", "0", "", "1.5", "Infinity", "2147483648"]) {
    assert.throws(() => createCursorProvider({ env: () => value }), /positive integer/);
  }
  assert.throws(() => createCursorProvider({ env: () => "100" }), /must be below/);
  const fake = fakeRuntime();
  fake.state.catalog = [
    { id: "composer-2.5", displayName: "Composer" },
    { id: "grok-4.6", displayName: "Grok" },
    { id: "unknown", displayName: "Unknown" },
  ];
  const { provider } = createCursorProvider({
    loadRuntime: async () => fake.runtime,
    env: (name) => name === "PI_CURSOR_CONTEXT_WINDOW" ? "32000" : undefined,
  });
  await refresh(provider);
  assert.deepEqual(provider.getModels().map((model) => model.contextWindow), [32_000, 32_000, 32_000]);
});

test("output budgets must fit each resolved window and invalid refreshes retain the catalog", async () => {
  const fake = fakeRuntime();
  fake.state.catalog = [{ id: "grok-4.6", displayName: "Grok" }];
  const { provider } = createCursorProvider({
    loadRuntime: async () => fake.runtime,
    env: (name) => name === "PI_CURSOR_MAX_TOKENS" ? "200000" : undefined,
  });
  await refresh(provider);
  const initial = provider.getModels();
  assert.equal(initial[0].maxTokens, 200_000);
  for (const item of [
    { id: "composer-2.5", displayName: "Composer" },
    { id: "unknown", displayName: "Unknown" },
  ]) {
    fake.state.catalog = [item];
    await assert.rejects(refresh(provider), /PI_CURSOR_MAX_TOKENS must be below the context window/);
    assert.equal(provider.getModels(), initial);
  }
});

test("the real Pi extension loader registers the provider and command without inference", async () => {
  const path = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const loaded = await loadExtensions([path], process.cwd());
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.ok(loaded.extensions[0].commands.has("cursor-refresh"));
  assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
  assert.equal(loaded.runtime.pendingNativeProviderRegistrations[0].provider.id, "cursor");
  assert.equal(loaded.extensions[0].tools.size, 0);
});

for (const mode of ["allow", "deny", "invalid-arguments"] as const) {
  test(`Pi owns tool validation and execution: ${mode}`, async () => {
    const block = mode !== "allow";
    let turns = 0;
    let executions = 0;
    let permissionChecks = 0;
    const fake = fakeRuntime(async ({ options, prompt, finish }) => {
      if (++turns === 1) {
        await options.local!.customTools!.pi_0.execute(mode === "invalid-arguments" ? {} : { command: "Get-Location" }, {});
      } else {
        const history = JSON.parse(prompt).messages;
        const result = history.find((message: { role: string }) => message.role === "toolResult");
        assert.equal(result.isError, block);
        if (mode !== "invalid-arguments") assert.match(result.content[0].text, block ? /Denied by Pi/ : /Host result/);
        finish(block ? "The host denied the request." : "The host completed the request.");
      }
    });
    const { provider } = createCursorProvider({ loadRuntime: async () => fake.runtime });
    await refresh(provider);
    const hostTool: AgentTool = {
      ...tool, label: "PowerShell",
      async execute() {
        executions++;
        assert.equal(fake.state.cancellations, 1);
        assert.equal(fake.state.disposals, 1);
        return { content: [{ type: "text", text: "Host result" }], details: {} };
      },
    };
    const agent = new Agent({
      initialState: { model: provider.getModels()[0], tools: [hostTool], systemPrompt: context.systemPrompt },
      streamFn: (model, ctx, options) => {
        if (!hasApi(model, "cursor-sdk")) throw new Error("Unexpected test model API");
        return provider.streamSimple(model, ctx, { ...options, apiKey: "fake-key" });
      },
      async beforeToolCall() {
        permissionChecks++;
        return block ? { block: true, reason: "Denied by Pi" } : undefined;
      },
    });
    await agent.prompt("Use the host tool");
    assert.equal(agent.state.errorMessage, undefined);
    assert.equal(turns, 2);
    assert.equal(permissionChecks, mode === "invalid-arguments" ? 0 : 1);
    assert.equal(executions, block ? 0 : 1);
    assert.equal(agent.state.messages.at(-1)?.role, "assistant");
  });
}

test("native Pi model runtime resolves auth, discovers the provider and streams", async () => {
  const fake = fakeRuntime();
  fake.state.catalog = [{ id: "composer-2.5", displayName: "Composer 2.5" }];
  const { provider, close } = createCursorProvider({ loadRuntime: async () => fake.runtime, env: () => undefined });
  const models = createModels({
    credentials: {
      async read() { return { type: "api_key", key: "fake-key" }; },
      async list() { return [{ providerId: "cursor", type: "api_key" }]; },
      async modify(_id, fn) { return fn({ type: "api_key", key: "fake-key" }); },
      async delete() {},
    },
    authContext: { ...authContext, env: async () => undefined },
  });
  models.setProvider(provider);
  const refreshed = await models.refresh({ providers: ["cursor"], allowNetwork: true });
  assert.equal(refreshed.errors.size, 0);
  const available = await models.getAvailable("cursor");
  assert.equal(available.length, 1);
  assert.equal(available[0].contextWindow, 200_000);
  const result = await models.completeSimple(available[0], context);
  assert.equal(result.stopReason, "stop");
  assert.equal(fake.state.creates[0].apiKey, "fake-key");
  await close();
});
