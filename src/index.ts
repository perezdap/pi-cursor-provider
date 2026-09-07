import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCursorProvider, PROVIDER_ID } from "./provider.ts";

export default function cursorProviderExtension(pi: ExtensionAPI) {
  const { provider, close } = createCursorProvider();
  pi.registerProvider(provider);

  async function refresh(ctx: ExtensionContext, explicit: boolean) {
    const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER_ID);
    if (!auth) {
      if (explicit && ctx.hasUI) ctx.ui.notify("Use /login cursor or set CURSOR_API_KEY first.", "warning");
      return;
    }
    const result = await ctx.modelRegistry.refresh({
      providers: [PROVIDER_ID], allowNetwork: true, force: explicit, signal: AbortSignal.timeout(20_000),
    });
    if (!ctx.hasUI) return;
    const error = result.errors.get(PROVIDER_ID);
    if (error) ctx.ui.notify(`Cursor model discovery failed: ${error.message}`, "error");
    else if (result.aborted) ctx.ui.notify("Cursor model discovery was cancelled or timed out.", "warning");
    else if (explicit) ctx.ui.notify(`${provider.getModels().length} Cursor models available in /model.`, "info");
  }

  pi.registerCommand("cursor-refresh", {
    description: "Refresh the Cursor model catalog (no inference request)",
    async handler(_args, ctx) {
      await ctx.waitForIdle();
      await refresh(ctx, true);
    },
  });
  pi.on("session_start", async (_event, ctx) => { await refresh(ctx, false); });
  pi.on("session_shutdown", close);
  pi.on("model_select", (event, ctx) => {
    if (event.model.provider === PROVIDER_ID && ctx.hasUI) {
      ctx.ui.notify("Experimental Cursor bridge: text-only history replay, account-gated system prompt, unknown prices and token limits. See README.md.", "warning");
    }
  });
}
