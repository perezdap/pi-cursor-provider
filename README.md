# Pi Cursor provider

Experimental Pi model provider built with the official `@cursor/sdk`. Cursor models appear under **cursor** in Pi's `/model` picker. Pi retains tool execution, argument validation, and permission hooks.

**Prototype only. No live inference has been tested.** Cursor account access, tool-handoff cancellation, and model quality still need an approved live smoke test. The dependency audit also has an unresolved upstream advisory.

## Run locally

Tested with Pi `0.85.1`, Cursor SDK `1.0.31`, and Node `26.7.0` on Windows x64. Node `22.19.0` or newer is required by the package, but other Node versions have not been exercised here.

From this directory:

```powershell
npm ci --ignore-scripts --no-fund
npm run verify
```

Start Pi from the repository you want to work on. Load this extension by absolute path:

```powershell
pi -e C:\Users\dperez\Documents\Github\pi-cursor-provider\src\index.ts
```

In Pi:

```text
/login cursor
/cursor-refresh
/model
```

Select a model whose provider is `cursor`. Sending a prompt after selecting it makes a billable Cursor SDK request.

`CURSOR_API_KEY` is also supported. A key saved through `/login cursor` takes precedence. Use a Cursor **user or service account** API key from https://cursor.com/dashboard/api, not a team admin key. The extension does not extract credentials from the Cursor app.

This project has not been installed into global Pi settings. Loading it with `-e` affects that invocation only.

## Behavior

| Code | Behavior |
| --- | --- |
| D1 | Discover account models on session start and through `/cursor-refresh`. Catalog calls do not perform inference. Available model IDs and parameters come from the account catalog. Only context-budget metadata is maintained locally. The live catalog is not persisted, so a sessionless `--list-models` invocation can be empty. |
| D2 | Start a fresh SDK agent for each Pi completion. Keep Cursor's system prompt. Send Pi's instructions, bridge instructions, and current history together as a user-message JSON envelope. There is no hidden Cursor conversation to retain across forks or compaction. |
| D3 | Expose only Pi's active tools as capture-only SDK callbacks. Stop the Cursor run, await cancellation and disposal, then emit native Pi tool calls. The SDK never calls a Pi tool implementation. |
| D4 | Let Pi validate arguments, run its permission hooks, execute allowed tools, and supply real or blocked tool results on the next completion. |
| D5 | Stream text and thinking deltas. Use reported token usage without counting final text or usage twice. No model-reasoning controls are advertised. Model parameters use the catalog's default variant where available, otherwise the first permitted value. |
| D6 | Use a disposable empty workspace and JSONL state directory under the OS temporary directory. Disable ambient Cursor settings, external MCP servers, subagents, and SDK transport retries. Only the MCP capability needed for callback discovery is enabled. |

`Esc`, request timeout, and Pi shutdown trigger SDK cancellation. No executable Pi tool call is emitted if cancellation or disposal fails.

## Limits and risks

| Code | Limit |
| --- | --- |
| R1 | Experimental compatibility test: the extension omits SDK `systemPrompt` to avoid its account access gate. Pi's instructions and bridge instructions are user-message content, not system-priority instructions. Cursor's own instructions can conflict with the restricted tool surface. Live instruction fidelity and tool handoff remain unverified. |
| R2 | History replay is not a native message-array API. Historical roles are represented in JSON inside one SDK user message. Instruction fidelity, caching, and latency differ from a direct model provider. Full history is resent on every tool round. |
| R3 | `npm audit --omit=dev` reports one high and two moderate dependency entries through `@cursor/sdk → @connectrpc/connect-node → undici@5.29.0`. npm reports no fix for this dependency chain. No untested cross-major override was applied. This is an audit result, not proof of exploitability in this adapter. |
| R4 | Cursor's model catalog does not report token limits or prices. Known models use Cursor's documented standard context windows below. Unrecognized models use Cursor's **200,000-token standard working window**, which is unverified per model. The 8,192 output-token default is still a Pi budgeting placeholder. Zero displayed cost means unknown, not free. Missing usage remains zero. Use Cursor's usage dashboard for billing. |
| R5 | Input is text-only. Image attachments and image tool results fail explicitly. Thinking signatures and failed partial assistant responses are omitted from replay. Temperature, reasoning budgets, and output-token limits are not forwarded because this SDK surface does not expose equivalent controls. |
| R6 | Tool restrictions are SDK configuration, not an OS sandbox. The SDK runs inside Pi's process with the user's permissions. If the SDK hangs, cleanup waits are bounded but cannot forcibly terminate an in-process library. Temporary `pi-cursor-*` directories can remain after cleanup errors or process crashes and can contain conversation data. |

No network proxy, unofficial endpoint, account-token extraction, or subscription bypass is used. SDK requests follow Cursor's account billing rules.

### Context windows

Standard (non-Max) context windows from Cursor's model pages and staff statements, checked **2026-09-07**:

| Model IDs | Context tokens | Source |
| --- | --- | --- |
| `composer-2.5` | 200,000 | [Composer 2.5](https://cursor.com/docs/models/cursor-composer-2-5) |
| `grok-4.5`, `grok-4.6` | 256,000 | [Grok 4.5](https://cursor.com/docs/models/grok-4-5), [Grok 4.6](https://cursor.com/docs/models/grok-4-6) |
| `claude-sonnet-5` | 200,000 | [Sonnet 5](https://cursor.com/docs/models/claude-sonnet-5) |
| `claude-opus-5`, `claude-opus-5-fast` | 300,000 | [Opus 5](https://cursor.com/docs/models/claude-opus-5) |
| `claude-fable-5`, `claude-fable-5-1` | 300,000 | [Fable 5](https://cursor.com/docs/models/claude-fable-5), [Fable 5.1](https://cursor.com/docs/models/claude-fable-5-1) |
| `gemini-3.1-pro`, `gemini-3.6-flash`, `gemini-3.8-flash` | 200,000 | [3.1 Pro](https://cursor.com/docs/models/gemini-3-1-pro), [3.6 Flash](https://cursor.com/docs/models/gemini-3-6-flash), [3.8 Flash](https://cursor.com/docs/models/gemini-3-8-flash) |
| `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` and their `-fast` IDs | 272,000 | [Sol](https://cursor.com/docs/models/gpt-5-6-sol), [Terra](https://cursor.com/docs/models/gpt-5-6-terra), [Luna](https://cursor.com/docs/models/gpt-5-6-luna) |
| `kimi-k3` | 200,000 | [Cursor staff, forum, 2026-09-02](https://forum.cursor.com/t/kimi-k3-sometimes-starts-up-with-a-window-of-200k-tokens/170325): no Context option on usage-based pricing, standard 200K working window. "Max" is the reasoning level. |

The legacy `composer-2` ID also uses 200,000 because [Cursor redirects it to Composer 2.5](https://cursor.com/docs/sdk/typescript). Lookup uses the exact catalog ID first, then declared catalog aliases. Unknown IDs get the 200,000-token standard window; they are not inferred from similar model names. Fast parameters retain the base model's standard budget.

The SDK catalog carries no token limits. Public model catalogs (models.dev and similar) report upstream vendor limits, for example 1,048,576 for `kimi-k3`, 1,000,000 for `claude-sonnet-5`, 500,000 for `grok-4.5`. Cursor does not serve those windows on standard plans, so the extension does not consult them. A too-large budget would stop Pi compaction while Cursor summarizes internally.

These are local Pi budgets, not SDK-enforced limits. The bridge does not assume extended/Max context is enabled or opt into it. The SDK's built-in prompt, tool definitions, and JSON replay also consume context. Cursor may compact internally before Pi does.

With Pi's default 16,384-token compaction reserve, Composer 2.5's threshold is now 183,616 tokens and Grok 4.6's is 239,616, instead of 47,616 for both. Auto-compaction stays enabled.

After updating this checkout, restart Pi with the absolute extension path shown above, run `/cursor-refresh`, and reselect the Cursor model. A separately installed extension copy will not change. An existing `PI_CURSOR_CONTEXT_WINDOW` or Pi `models.json` context override still takes precedence over these defaults.

### Optional local budget settings

These environment variables must be positive integers. Set them before launching Pi:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_CURSOR_CONTEXT_WINDOW` | Per-model table above, otherwise `200000` | Override the Pi context budget for **all** Cursor models. Leave unset for per-model defaults. |
| `PI_CURSOR_MAX_TOKENS` | `8192` | Pi output-budget placeholder, strictly below the context window. Does not cap Cursor output. |
| `PI_CURSOR_TIMEOUT_MS` | `300000` | Completion deadline in milliseconds, followed by bounded cleanup. |

## Verification

`npm run verify` runs TypeScript checks and offline Node tests. Tests use fake SDK runs, the real SDK import, Pi's real extension loader, Pi's model runtime, and Pi's agent loop. They cover streaming, role-labelled history, capture-only tools, permission denial, invalid arguments, cancellation, cleanup failures, model refresh, per-model context budgets, Pi compaction thresholds, and auth selection.

No test executes a shell tool or submits an inference request to Cursor.

### Live acceptance checks, not yet run

- **A1:** With an approved API key and approved spend, send a short text-only prompt to verify inference with Cursor's default system prompt.
- **A2:** Use a harmless Pi tool and verify that Cursor cancellation completes before Pi's execution event. Verify that a Pi permission denial reaches the following Cursor completion.
- **A3:** Cancel during streaming and tool capture. Verify that no SDK run remains active. Exercise a follow-up, model switch, fork, and compacted conversation.

Do not treat the prototype as a production provider until these checks and the dependency risk are resolved.

## Sources

- [Cursor SDK documentation](https://cursor.com/docs/sdk/typescript.md)
- Published `@cursor/sdk@1.0.31` TypeScript declarations, particularly `AgentOptions`, `Run`, and `SDKCustomTool`
- Installed Pi `0.85.1` documentation: `docs/custom-provider.md`, `docs/extensions.md`, and `docs/packages.md`

The SDK declarations are newer than parts of Cursor's prose documentation. In particular, they document the system-prompt access gate and the MCP tool allowlist semantics used here.
