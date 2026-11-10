import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import { withoutStale } from "../core/catalog.ts";
import type { CliproxyModel } from "../core/catalog.ts";
import { refreshServerCatalog } from "../core/oauth.ts";
import { completeFrom } from "./completions.ts";
import { Settings } from "./config.ts";
import { errorText } from "./error-text.ts";
import { FastModeController } from "./fast.ts";
import { FooterController } from "./footer.ts";
import { registerOAuthLogin } from "./oauth.ts";
import { PauseController, registerPause } from "./pause.ts";
import { PriceCache } from "./prices.ts";
import { createExtensionProvider } from "./provider.ts";
import { registerTransientNetworkErrorRetry } from "./retry.ts";
import { registerStatus } from "./status.ts";
import type { StatusSnapshot } from "./status.ts";
import { registerTpsFooter } from "./tps.ts";
import { registerUsage, UsageTracker } from "./usage.ts";
import { pickSearchModel, registerWebSearch } from "./web-search.ts";

export default async function cliproxyapiProvider(
  pi: ExtensionAPI
): Promise<void> {
  const settings = new Settings(getAgentDir());
  const { providerId } = settings;
  const config = settings.config();
  const fast = new FastModeController(config.fast ?? false);
  const pause = new PauseController(config.pause ?? false);
  const tracker = new UsageTracker({ settings });
  const prices = new PriceCache({ agentDir: settings.agentDir });

  let activeContext: ExtensionContext | undefined;
  let notifiedStaleModel: string | undefined;
  // A price failure warns once per session, in the UI only. A warning before session_start waits for it.
  let priceWarned = false;
  let pendingPriceWarning: string | undefined;

  const showPriceWarning = (ctx: ExtensionContext): void => {
    if (priceWarned || !pendingPriceWarning || !ctx.hasUI) {
      return;
    }

    priceWarned = true;
    ctx.ui.notify(pendingPriceWarning, "warning");
    pendingPriceWarning = undefined;
  };

  const notifyStaleModel = (
    ctx: ExtensionContext,
    models: readonly CliproxyModel[]
  ): void => {
    const stale = models.find(
      (model) =>
        model.stale &&
        ((ctx.model?.provider === providerId && ctx.model.id === model.id) ||
          settings.isDefaultModel(model.id))
    );

    if (!stale) {
      notifiedStaleModel = undefined;

      return;
    }

    if (notifiedStaleModel !== stale.id) {
      notifiedStaleModel = stale.id;
      ctx.ui.notify(
        `Model '${stale.id}' is temporarily unavailable upstream. Retaining its cached entry.`,
        "warning"
      );
    }
  };

  const available = <T extends { id: string }>(models: readonly T[]): T[] =>
    tracker.filter(withoutStale(models));

  const controller = createExtensionProvider({
    fast,
    filterAvailable: available,
    onModels: (models) => {
      if (activeContext) {
        notifyStaleModel(activeContext, models);
      }
    },
    onPriceWarning: (message) => {
      if (priceWarned) {
        return;
      }

      pendingPriceWarning = message;

      if (activeContext) {
        showPriceWarning(activeContext);
      }
    },
    prices,
    settings,
  });

  const catalogIds = (): string[] =>
    controller.getModels().map((model) => model.id);

  const startupConnection = settings.connection();

  // Print and JSON runs never refresh the catalog, so a cold start must load it before pi resolves --model.
  if (
    startupConnection &&
    controller.getModels().length === 0 &&
    !settings.offline()
  ) {
    try {
      await controller.refresh(startupConnection);
    } catch (error) {
      // Startup has no UI yet, so stderr is the only place this warning can go.
      console.warn(`[cliproxyapi] Failed to load models: ${errorText(error)}`);
    }
  }

  pi.registerProvider(controller.provider);

  /** Without network, pi re-derives the models from the cached catalog and the current settings. */
  const refreshRegistry = async (
    ctx: ExtensionContext,
    options: { force?: boolean; allowNetwork?: boolean } = {}
  ): Promise<void> => {
    const result = await ctx.modelRegistry.refresh({
      ...options,
      providers: [providerId],
    });

    const error = result.errors.get(providerId);

    if (error) {
      throw error;
    }
  };

  const footer = new FooterController(providerId, fast, pause, {
    getSegments: (ctx) =>
      tracker.segments(
        catalogIds(),
        ctx.model?.provider === providerId ? ctx.model.id : undefined
      ),
    settings,
  });

  footer.register(pi);
  registerPause(pi, settings, pause);
  registerTpsFooter(pi, pause, providerId);
  registerTransientNetworkErrorRetry(pi, providerId);

  const usage = registerUsage(pi, {
    getCatalogIds: catalogIds,
    reapplyFilter: (ctx) => refreshRegistry(ctx, { allowNetwork: false }),
    settings,
    tracker,
  });

  const refreshAll = async (ctx: ExtensionContext): Promise<void> => {
    await refreshRegistry(ctx, { force: true });
    await usage.refresh(ctx);
  };

  pi.registerCommand("cliproxyapi-reset", {
    description:
      "Reset CLIProxyAPI cooldowns, optionally for one model: /cliproxyapi-reset [model-id].",
    getArgumentCompletions: (prefix) => completeFrom(catalogIds(), prefix),
    handler: async (args, ctx) => {
      const modelId = args.trim();

      if (/\s/u.test(modelId)) {
        ctx.ui.notify("Usage: /cliproxyapi-reset [model-id]", "error");

        return;
      }

      let affected: string[];

      try {
        affected = await tracker.resetCooldowns(modelId || undefined);
      } catch (error) {
        ctx.ui.notify(
          `Failed to reset CLIProxyAPI cooldowns: ${errorText(error)}`,
          "error"
        );

        return;
      }

      try {
        await refreshAll(ctx);
      } catch (error) {
        ctx.ui.notify(
          `CLIProxyAPI cooldowns were reset, but refreshing models failed: ${errorText(error)}`,
          "warning"
        );
      }

      if (modelId && affected.length === 0) {
        ctx.ui.notify(
          `No CLIProxyAPI credential serves ${modelId}; nothing was reset for it.`,
          "warning"
        );

        return;
      }

      ctx.ui.notify(
        affected.length > 0
          ? `Reset CLIProxyAPI cooldowns for: ${affected.join(", ")}.`
          : "Reset CLIProxyAPI cooldowns for all credentials.",
        "info"
      );
    },
  });

  pi.registerCommand("fast", {
    description: "Toggle CLIProxyAPI Fast mode globally.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /fast", "error");

        return;
      }

      try {
        const enabled = fast.toggle(settings);
        await refreshRegistry(ctx, { allowNetwork: false });

        const current = ctx.model;

        if (current?.provider === providerId) {
          const refreshed = controller
            .getModels()
            .find((model) => model.id === current.id);

          // The session holds its own copy of the model, so new prices need a new model object.
          if (
            refreshed &&
            JSON.stringify(refreshed.cost) !== JSON.stringify(current.cost) &&
            !(await pi.setModel(refreshed))
          ) {
            throw new Error(`Unable to activate refreshed model ${current.id}`);
          }

          if (enabled && !fast.isModelSupported(current.id)) {
            ctx.ui.notify(
              "Fast mode is enabled, but the current model does not support it.",
              "warning"
            );
          }
        }

        ctx.ui.notify(
          enabled
            ? "Fast mode is enabled globally."
            : "Fast mode is disabled globally.",
          "info"
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to update Fast mode: ${errorText(error)}`,
          "error"
        );
      }

      footer.refresh(ctx);
    },
  });

  pi.registerCommand("cliproxyapi-refresh", {
    description: "Force refresh CLIProxyAPI models from the remote catalog.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-refresh", "error");

        return;
      }

      const access = settings.managementAccess();

      if (access) {
        try {
          await refreshServerCatalog({ ...access, signal: ctx.signal });
        } catch (error) {
          ctx.ui.notify(
            `CLIProxyAPI could not reload its model definitions: ${errorText(error)}`,
            "warning"
          );
        }
      }

      try {
        await refreshAll(ctx);
        const models = controller.getModels();
        const stale = models.filter((model) => model.stale).length;
        ctx.ui.notify(
          `Refreshed ${models.length - stale} CLIProxyAPI models${stale ? `. Hid ${stale} that CLIProxyAPI no longer lists` : ""}.`,
          "info"
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to refresh CLIProxyAPI models: ${errorText(error)}`,
          "error"
        );
      }
    },
  });

  registerOAuthLogin(pi, { refresh: refreshAll, settings });

  const availableModels = (): CliproxyModel[] =>
    available(controller.getModels());

  registerWebSearch(pi, {
    getAvailableModels: availableModels,
    getModels: () => withoutStale(controller.getModels()),
    getStandardCost: controller.getStandardCost,
    settings,
  });

  const gatherStatus = (): StatusSnapshot => {
    const now = Date.now();
    const current = settings.config();
    const models = controller.getModels();
    const catalogFetchedAt = controller.getCatalogFetchedAt();
    const priceInfo = prices.describe();
    const management = tracker.managementStatus();
    const managed = settings.managementKey();

    const searchModel = pickSearchModel({
      getStandardCost: controller.getStandardCost,
      models: availableModels(),
      preferred: current.searchModel,
    });

    const ageSince = (time: number): number => Math.max(0, now - time);

    return {
      baseUrl: settings.baseUrl(),
      catalogAgeMs:
        catalogFetchedAt > 0 ? ageSince(catalogFetchedAt) : undefined,
      fast: fast.isEnabled(),
      fastModels: models.filter((model) => model.supportsFast).length,
      footer: current.footer ?? true,
      keySource: settings.sources().apiKey,
      management: management && {
        source: management.source,
        usageAgeMs:
          management.usageFetchedAt === undefined
            ? undefined
            : ageSince(management.usageFetchedAt),
      },
      managementError:
        managed && "error" in managed ? managed.error : undefined,
      models: models.length,
      paused: current.pause ?? pause.isEnabled(),
      prices:
        priceInfo?.fetchedAt === undefined
          ? undefined
          : { ageMs: ageSince(priceInfo.fetchedAt), etag: priceInfo.etag },
      searchModel: {
        configured: current.searchModel,
        effective: searchModel?.id,
      },
      stale: models.filter((model) => model.stale).length,
      thinking: current.thinkingDisplay ?? {},
    };
  };

  registerStatus(pi, gatherStatus);

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    notifyStaleModel(ctx, controller.getModels());
    showPriceWarning(ctx);

    if (!settings.connection()) {
      return;
    }

    // Not forced, so a catalog fetched under 10 minutes ago is reused without a request.
    try {
      await refreshRegistry(ctx);
    } catch (error) {
      ctx.ui.notify(
        `Failed to refresh CLIProxyAPI models: ${errorText(error)}`,
        "warning"
      );
    }
  });
  pi.on("model_select", (_event, ctx) => {
    activeContext = ctx;
    notifyStaleModel(ctx, controller.getModels());
  });
  pi.on("session_shutdown", () => {
    activeContext = undefined;
    notifiedStaleModel = undefined;
    priceWarned = false;
    pendingPriceWarning = undefined;
  });
}
