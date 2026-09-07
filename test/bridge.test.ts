import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Context } from "@earendil-works/pi-ai";
import { abortable } from "../src/bridge.ts";
import { BRIDGE_INSTRUCTIONS, serializeHistory } from "../src/history.ts";
import { createCursorStreams, safeError } from "../src/stream.ts";
import { assistant, context, deferred, fakeRuntime, model, usage } from "./fixtures.ts";

const streamFor = (fake: ReturnType<typeof fakeRuntime>, timeout = 1000) =>
  createCursorStreams(async () => fake.runtime, (id) => ({ id }), timeout, 500);
const requestOptions = { apiKey: "test-key-not-a-real-credential" };

async function collect(stream: ReturnType<ReturnType<typeof createCursorStreams>["stream"]>) {
  const events = [];
  for await (const event of stream) events.push(structuredClone(event));
  return { events, message: await stream.result() };
}

function assertClean(fake: ReturnType<typeof fakeRuntime>) {
  assert.equal(fake.state.disposals, fake.state.creates.length);
  for (const directory of fake.state.stores) assert.equal(existsSync(dirname(directory)), false);
}

test("streams ordered thinking and Unicode text without duplicating the final response", async () => {
  const fake = fakeRuntime(async ({ delta, finish }) => {
    await delta({ type: "thinking-delta", text: "Checking" });
    await delta({ type: "thinking-completed", thinkingDurationMs: 1 });
    await delta({ type: "text-delta", text: "Hello " });
    await delta({ type: "text-delta", text: "世界 🌍" });
    await delta({ type: "turn-ended", usage });
    finish("Hello 世界 🌍", usage);
  });
  const { events, message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.deepEqual(events.map((e) => e.type), [
    "start", "thinking_start", "thinking_delta", "thinking_end", "text_start", "text_delta", "text_delta", "text_end", "done",
  ]);
  assert.equal(message.stopReason, "stop");
  assert.deepEqual(message.content, [{ type: "thinking", thinking: "Checking" }, { type: "text", text: "Hello 世界 🌍" }]);
  assert.equal(message.usage.totalTokens, 13);
  assert.equal(message.usage.input, 7);
  assertClean(fake);
});

test("captures native callbacks, cancels first, and only then emits Pi tool calls", async () => {
  const cancel = deferred<void>();
  const fake = fakeRuntime(async ({ options, delta }) => {
    await delta({ type: "text-delta", text: "I will inspect it." });
    await options.local!.customTools!.pi_0.execute({ command: "Get-Location" }, { toolCallId: "sdk-id" });
  });
  fake.state.cancelGate = cancel.promise;
  const stream = streamFor(fake).stream(model, context, requestOptions);
  const pending = collect(stream);
  await fake.state.started.promise;
  await delay(5);
  assert.equal(fake.state.cancellations, 1);
  assert.equal(fake.state.disposals, 0);
  cancel.resolve();
  const { message, events } = await pending;
  assert.equal(message.stopReason, "toolUse");
  const call = message.content.find((block) => block.type === "toolCall")!;
  assert.equal(call.name, "pwsh");
  assert.deepEqual(call.arguments, { command: "Get-Location" });
  assert.match(call.id, /^cursor_/);
  assert.deepEqual(events.slice(-4).map((e) => e.type), ["toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  assertClean(fake);
});

test("isolates Cursor settings, MCP servers, workspace and storage", async () => {
  const fake = fakeRuntime();
  await collect(streamFor(fake).stream(model, context, requestOptions));
  const options = fake.state.creates[0];
  assert.deepEqual(options.tools, ["mcp"]);
  assert.deepEqual(options.mcpServers, {});
  assert.deepEqual(options.agents, {});
  assert.equal(options.cloud, undefined);
  assert.deepEqual(options.local?.settingSources, []);
  assert.equal(options.local?.enableAgentRetries, false);
  assert.notEqual(options.local?.cwd, process.cwd());
  assert.match(options.local!.cwd!, /pi-cursor-/);
  assert.ok(options.local?.store);
  assert.equal(Object.hasOwn(options, "systemPrompt"), false);
  const prompt = JSON.parse(fake.state.prompts[0]);
  assert.equal(prompt.piInstructions, context.systemPrompt);
  assert.equal(prompt.bridgeInstructions, BRIDGE_INSTRUCTIONS);
  assert.deepEqual(prompt.messages, JSON.parse(serializeHistory(context)).messages);
  assert.deepEqual(options.local?.customTools?.pi_0.inputSchema, context.tools![0].parameters);
  assertClean(fake);
});

test("captures a parallel tool batch without executing host operations", async () => {
  const fake = fakeRuntime(async ({ options }) => {
    const execute = options.local!.customTools!.pi_0.execute;
    await Promise.all([execute({ command: "one" }, {}), execute({ command: "two" }, {})]);
  });
  const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "toolUse");
  const calls = message.content.filter((block) => block.type === "toolCall");
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].id, calls[1].id);
  assertClean(fake);
});

test("toolChoice none disables all Cursor tools", async () => {
  const fake = fakeRuntime();
  await collect(streamFor(fake).stream(model, context, { ...requestOptions, toolChoice: "none" }));
  assert.deepEqual(fake.state.creates[0].tools, []);
  assert.deepEqual(Object.keys(fake.state.creates[0].local!.customTools!), []);
});

test("cancel failure never emits executable Pi tool calls", async (t) => {
  const fake = fakeRuntime(async ({ options }) => { await options.local!.customTools!.pi_0.execute({ command: "no" }, {}); });
  t.after(async () => { for (const dir of fake.state.stores) await rm(dirname(dir), { recursive: true, force: true }); });
  fake.state.cancelError = new Error("cannot cancel");
  const { events, message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /cannot cancel/);
  assert.equal(events.some((event) => event.type === "toolcall_end"), false);
  assert.equal(message.content.some((block) => block.type === "toolCall"), false);
  assert.equal(fake.state.disposals, 1);
});

test("unacknowledged cancellation fails closed", async (t) => {
  const fake = fakeRuntime(async ({ options }) => { await options.local!.customTools!.pi_0.execute({}, {}); });
  t.after(async () => { for (const dir of fake.state.stores) await rm(dirname(dir), { recursive: true, force: true }); });
  fake.state.cancelAcknowledges = false;
  const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /acknowledge/);
  assert.equal(message.content.length, 0);
});

test("disposal failure prevents tool handoff", async (t) => {
  const fake = fakeRuntime(async ({ options }) => { await options.local!.customTools!.pi_0.execute({}, {}); });
  t.after(async () => { for (const dir of fake.state.stores) await rm(dirname(dir), { recursive: true, force: true }); });
  fake.state.disposeError = new Error("cannot dispose");
  const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /cannot dispose/);
  assert.equal(message.content.length, 0);
});

test("a hung cancellation has a bounded failure path and never hands off tools", async (t) => {
  const fake = fakeRuntime(async ({ options }) => { await options.local!.customTools!.pi_0.execute({}, {}); });
  t.after(async () => { for (const dir of fake.state.stores) await rm(dirname(dir), { recursive: true, force: true }); });
  fake.state.cancelGate = new Promise(() => {});
  const streams = createCursorStreams(async () => fake.runtime, (id) => ({ id }), 1000, 15);
  const { message } = await collect(streams.stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /cancellation timed out/);
  assert.equal(message.content.length, 0);
  assert.equal(fake.state.disposals, 1);
});

test("user abort cancels an active run and closes the stream", async () => {
  const fake = fakeRuntime(() => {});
  const abort = new AbortController();
  const pending = collect(streamFor(fake).stream(model, context, { ...requestOptions, signal: abort.signal }));
  await fake.state.started.promise;
  abort.abort();
  const { message } = await pending;
  assert.equal(message.stopReason, "aborted");
  assert.equal(fake.state.cancellations, 1);
  assertClean(fake);
});

test("a timeout cancels rather than leaving the SDK agent running", async () => {
  const fake = fakeRuntime(() => {});
  const { message } = await collect(streamFor(fake, 40).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.match(message.errorMessage!, /timed out/);
  assert.equal(fake.state.cancellations, 1);
  assertClean(fake);
});

test("shutdown cancels active streams and is idempotent", async () => {
  const fake = fakeRuntime(() => {});
  const streams = streamFor(fake);
  const pending = collect(streams.stream(model, context, requestOptions));
  await fake.state.started.promise;
  await streams.close();
  await streams.close();
  assert.equal((await pending).message.stopReason, "aborted");
  assertClean(fake);
});

test("pre-aborted, missing-key and deferred requests never create an SDK agent", async () => {
  const fake = fakeRuntime();
  const streams = streamFor(fake);
  for (const options of [{}, { ...requestOptions, signal: AbortSignal.abort() }, { ...requestOptions, deferred: true }]) {
    const { message } = await collect(streams.stream(model, context, options));
    assert.ok(message.stopReason === "error" || message.stopReason === "aborted");
  }
  assert.equal(fake.state.creates.length, 0);
});

test("late create completion is disposed without sending a prompt", async () => {
  const fake = fakeRuntime();
  const gate = deferred<void>();
  fake.state.createGate = gate.promise;
  const abort = new AbortController();
  const pending = collect(streamFor(fake).stream(model, context, { ...requestOptions, signal: abort.signal }));
  while (!fake.state.creates.length) await delay(1);
  abort.abort();
  gate.resolve();
  const { message } = await pending;
  assert.equal(message.stopReason, "aborted");
  assert.equal(fake.state.prompts.length, 0);
  assertClean(fake);
});

test("late send completion is cancelled and disposed", async () => {
  const fake = fakeRuntime(() => {});
  const gate = deferred<void>();
  fake.state.sendGate = gate.promise;
  const abort = new AbortController();
  const pending = collect(streamFor(fake).stream(model, context, { ...requestOptions, signal: abort.signal }));
  await fake.state.started.promise;
  abort.abort();
  gate.resolve();
  const { message } = await pending;
  assert.equal(message.stopReason, "aborted");
  assert.equal(fake.state.cancellations, 1);
  assertClean(fake);
});

test("creation and send errors retain diagnostics and clean disposable directories", async () => {
  for (const stage of ["createError", "sendError"] as const) {
    const fake = fakeRuntime();
    fake.state[stage] = new Error(`${stage} failed`);
    const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
    assert.equal(message.stopReason, "error");
    assert.equal(message.errorMessage, `${stage} failed`);
    for (const directory of fake.state.stores) assert.equal(existsSync(dirname(directory)), false);
    assert.equal(fake.state.disposals, stage === "sendError" ? 1 : 0);
  }
});

test("server errors are preserved and redacted without assuming an account gate", async () => {
  const fake = fakeRuntime(({ fail }) => fail(`InvalidArgument: --system-prompt not allowed ${requestOptions.apiKey}`));
  const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.stopReason, "error");
  assert.equal(message.errorMessage, "InvalidArgument: --system-prompt not allowed [redacted]");
  assert.equal(message.errorMessage!.includes(requestOptions.apiKey), false);
  assert.equal(fake.state.creates.length, 1);
  assertClean(fake);
});

test("uses final-only text, accepts empty results and propagates run errors", async () => {
  for (const text of ["Final only", ""]) {
    const fake = fakeRuntime(({ finish }) => finish(text));
    const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
    assert.equal(message.stopReason, "stop");
    assert.deepEqual(message.content, text ? [{ type: "text", text }] : []);
  }
  const fake = fakeRuntime(({ fail }) => fail("Rate limit exceeded"));
  const { message } = await collect(streamFor(fake).stream(model, context, requestOptions));
  assert.equal(message.errorMessage, "Rate limit exceeded");
});

test("history retains roles, tool IDs, errors and Unicode but not internal details or signatures", () => {
  const history: Context = {
    ...context,
    messages: [context.messages[0], assistant({ content: [
      { type: "text", text: "你好" },
      { type: "thinking", thinking: "private", thinkingSignature: "signature" },
      { type: "toolCall", id: "call-1", name: "pwsh", arguments: { command: "Get-Location" } },
    ], stopReason: "toolUse" }), {
      role: "toolResult", toolCallId: "call-1", toolName: "pwsh", isError: true,
      content: [{ type: "text", text: "Denied by Pi" }], details: { privateMetadata: "omit" }, timestamp: 2,
    }, assistant({ stopReason: "aborted", content: [{ type: "text", text: "partial" }] })],
  };
  const serialized = serializeHistory(history);
  const parsed = JSON.parse(serialized);
  assert.deepEqual(parsed.messages.map((m: { role: string }) => m.role), ["user", "assistant", "toolResult"]);
  assert.equal(parsed.messages[2].toolCallId, "call-1");
  assert.equal(parsed.messages[2].isError, true);
  assert.match(serialized, /你好/);
  for (const omitted of ["signature", "privateMetadata", "partial", "timestamp"]) assert.equal(serialized.includes(omitted), false);
});

test("images are rejected instead of silently omitted", async () => {
  const fake = fakeRuntime();
  const image = { type: "image" as const, mimeType: "image/png", data: "aGVsbG8=" };
  for (const message of [
    { role: "user" as const, content: [image], timestamp: 1 },
    { role: "toolResult" as const, toolCallId: "id", toolName: "read", content: [image], isError: false, timestamp: 1 },
  ]) {
    const { message: result } = await collect(streamFor(fake).stream(model, { messages: [message] }, requestOptions));
    assert.match(result.errorMessage!, /text only/);
  }
  assert.equal(fake.state.creates.length, 0);
});

test("each Pi turn replays exactly the supplied branch, including tool results and compaction", async () => {
  const fake = fakeRuntime();
  const streams = streamFor(fake);
  await collect(streams.stream(model, context, requestOptions));
  const compacted = { messages: [{ role: "user" as const, content: "Compacted branch", timestamp: 4 }] };
  await collect(streams.stream(model, compacted, requestOptions));
  assert.equal(fake.state.creates.length, 2);
  assert.equal(fake.state.prompts[1], serializeHistory(compacted));
  assert.equal(fake.state.prompts[1].includes("Inspect the repository"), false);
  assert.notEqual(fake.state.creates[0].local?.cwd, fake.state.creates[1].local?.cwd);
});

test("abortable consumes late rejections and error redaction handles aggregate errors", async () => {
  const pending = deferred<void>();
  await assert.rejects(abortable(pending.promise, AbortSignal.abort()));
  pending.reject(new Error("late"));
  await delay(1);
  assert.equal(safeError(new AggregateError([new Error("secret"), new Error("other secret")]), "secret"), "[redacted]. other [redacted]");
});
