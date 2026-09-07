# Prototype review

Scope: all files in this new project, compared with an empty baseline. There is no Git commit baseline. The spec is the request for a Cursor model provider in Pi with Pi-owned tool execution, plus the explicitly disclosed history-replay prototype limit.

The code-review checklist was applied separately to standards and spec in the main session. No parallel review workers were available. This is not an independent review. No issue-tracker workflow is configured. `/setup-matt-pocock-skills` can add that workflow if needed.

## Standards

**R3 remains open:** the production dependency audit reports a high-severity `undici` dependency entry through the pinned Cursor SDK. npm reports no fix for the chain. A cross-major dependency override was not applied without compatibility testing.

The review corrected cancellation-listener cleanup and made catalog deadlines release their timers on external cancellation. Startup performs no inference. API-key error redaction, strict TypeScript checks, explicit resource ownership, and capture-only tool callbacks have offline coverage.

Evidence: `src/bridge.ts` owns cancellation and disposable state. `src/provider.ts` publishes catalogs atomically. `src/stream.ts` redacts request credentials from errors.

## Spec

**R1 remains open:** account access to Cursor's custom system prompt has not been verified. `src/bridge.ts` supplies it, and `src/stream.ts` reports rejection without falling back to Cursor's prompt.

**R2 remains open:** this is a history-replay adapter, not a direct completion API. `src/history.ts` represents historical roles in JSON. Live instruction fidelity, model quality, and native callback cancellation remain unverified.

Pi's real extension loader registers the native provider and refresh command without replacing tools. Pi's real agent loop tests confirm that it executes allowed tool calls, blocks denied calls, rejects missing required arguments, and sends the resulting tool messages back through the bridge. Fresh SDK agents prevent stale hidden history across branches. These checks use fake SDK runs, not live Cursor inference.

## Verification

- **V1:** `npm run verify` performs strict typechecking and offline tests.
- **V2:** The real Cursor SDK imports successfully on Windows x64.
- **V3:** `npm audit --omit=dev` reports one high and two moderate dependency entries. This result is not an exploitability assessment.
- **V4:** No global Pi configuration, paid inference, or live account operation was performed.

One standards finding and two spec findings remain open. The worst standards issue is the dependency audit. The worst spec issue is unverified live account and tool-handoff compatibility. The project is a tested offline prototype, not a production-ready provider.
