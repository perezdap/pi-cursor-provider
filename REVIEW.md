# Review

Date: 2026-09-07. Scope: every file in the project. There is no Git baseline commit, so the whole tree was reviewed. The spec is the original request (a Cursor model provider for Pi with Pi-owned tool execution), README decisions D1–D6, and disclosed limits R1–R6.

Both axes (standards, spec) ran in the main session. No parallel review workers were available, so this is not an independent review.

## Standards

| Code | Finding | Location | Status |
| --- | --- | --- | --- |
| F1 | Cleanup skips `rm(root)` when `ownedAgent[Symbol.asyncDispose]()` throws. Temporary `pi-cursor-*` directories with conversation data can remain (R6-adjacent). | `src/bridge.ts` | Open |
| F2 | `defaultSelection` throws on one malformed catalog model (empty `parameter.values`). `refreshModels` then fails the whole catalog instead of skipping the model. | `src/provider.ts` | Open |
| F3 | Environment access is inconsistent: `refreshModels` reads the injected `env("CURSOR_API_KEY")`, `auth.resolve` reads `ctx.env("CURSOR_API_KEY")`. Tests that inject `env` do not cover the auth path. | `src/provider.ts` | Open |
| F4 | Tests deep-import `dist/core/extensions/loader.js` and `dist/core/compaction/compaction.js` from `pi-coding-agent`. These paths are not public API and can move on a Pi upgrade. | `test/provider.test.ts:8-9` | Open |
| F5 | Stale user path (`C:\Users\dperez\...`) and the claim that the extension "has not been installed into global Pi settings". Both are false on the current machine. | `README.md:21`, `README.md:36` | Open |
| F10 | Unlisted catalog models (observed: `kimi-k3`) received the 64,000-token fallback. Pi compacted at ~48k tokens on a model Cursor serves at 200K. | `src/provider.ts` | **Resolved 2026-09-07.** `kimi-k3` added to the curated map at 200,000 (Cursor staff, forum, 2026-09-02). Fallback raised from 64,000 to 200,000, Cursor's standard working window for third-party models. A runtime lookup against models.dev was rejected: it reports upstream vendor limits (kimi-k3 1,048,576; claude-sonnet-5 1,000,000; grok-4.5 500,000) that Cursor does not serve, which would disable Pi compaction. The SDK catalog (`ModelListItem`) carries no token limits. |

R3 (dependency audit) is re-verified below under Spec because it is a disclosed limit.

## Spec

| Code | Finding | Location | Status |
| --- | --- | --- | --- |
| F6 | R1 remains open. No SDK `systemPrompt` is sent. Pi instructions travel as `BRIDGE_INSTRUCTIONS` inside user text. A test asserts `Object.hasOwn(options, "systemPrompt") === false`. Live instruction fidelity is unverified. | `src/bridge.ts`, `src/history.ts` | Open, re-verified |
| F7 | R2 remains open. `serializeHistory` is text-only: it drops tool calls, tool results, thinking blocks, and error/aborted assistant messages. In agentic sessions Cursor never sees earlier tool output. This is the largest functional caveat. | `src/history.ts` | Open, re-verified |
| F8 | R3 remains open. `npm audit --omit=dev`: 3 findings (1 high, 2 moderate) in `undici` via `@connectrpc/connect-node` via `@cursor/sdk`. GHSA-v3r7-h72x-cjcm, GHSA-35p6-xmwp-9g52. No fix available. `@cursor/sdk` 1.0.31 is the latest release (`npm view`, modified 2026-09-03). | `package-lock.json` | Open, re-verified |
| F9 | `BRIDGE_INSTRUCTIONS` says "custom-user-tools callbacks", but the SDK tools are registered flat as `pi_0…pi_N`. Wording mismatch in the same instruction-fidelity area as F6/F7. | `src/history.ts` | Open |

## Cleared

Checked and found correct: `Promise.race([handoff, run.wait()])` loser handling; `Map.get("__proto__")` safety; `AbortSignal.any`/`AbortSignal.timeout` on Node ≥ 22.19; no double-append of streamed text on the handoff path; timeout → `stopReason: "error"` and user abort → `"aborted"`; bounded cancel (`bridge.ts:57`, `bridge.ts:122`); `safeError` credential redaction in provider and stream; strict `tsconfig.json`; Pi loader dedup of the same extension path (`loader.js:613-621`) so the global `packages` entry plus `-e` does not double-register.

## Verification

- V1: `npm run verify` passes strict typechecking and offline tests.
- V2: The real Cursor SDK imports on Windows x64 without creating an agent.
- V3: `npm audit --omit=dev` re-run 2026-09-07, result unchanged from F8.
- V4: No paid inference was performed by the review. The extension is installed globally via the `packages` array in `~/.pi/agent/settings.json`.

Five standards findings and four spec findings remain open. F10 is resolved. The worst standards issue is F1 (data-bearing temp directories after cleanup errors). The worst spec issue is F7 (tool results never replayed to Cursor). The project is a tested offline prototype, not a production-ready provider.
