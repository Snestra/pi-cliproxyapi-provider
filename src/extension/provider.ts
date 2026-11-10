/* oxlint-disable eslint/no-await-in-loop -- OAuth login prompts and validation are intentionally sequential so each retry uses the latest input. */
import type {
  ModelCost,
  OAuthCredential,
  Provider,
  ProviderAuthInteraction,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";
import { createProvider } from "@earendil-works/pi-ai/models";

import {
  catalogId,
  fetchCatalog,
  mapCatalog,
  mergeCatalog,
} from "../core/catalog.ts";
import type {
  CliproxyApi,
  CliproxyModel,
  TrackedEntry,
} from "../core/catalog.ts";
import { connectionTo, resolveEndpoints } from "../core/connection.ts";
import type { ResolvedConnection } from "../core/connection.ts";
import { costCatalogFromPrices, matchModelCost } from "../core/costs.ts";
import type { CostCatalog } from "../core/costs.ts";
import { cliproxyApis } from "../core/provider.ts";
import { anthropicCompat, anthropicPromptCache } from "./anthropic-builtins.ts";
import { loginCredentials, loginExpiry } from "./config.ts";
import type { Settings } from "./config.ts";
import { errorText } from "./error-text.ts";
import type { FastModeController } from "./fast.ts";
import type { PriceCache } from "./prices.ts";

export interface ExtensionProviderOptions {
  settings: Settings;
  fast: FastModeController;
  prices: PriceCache;
  /** Called with a ready-to-show message when models.dev prices could not be loaded. */
  onPriceWarning?: (message: string) => void;
  onModels?: (models: readonly CliproxyModel[]) => void;
  /** Drops models that are out of quota from pi's available list. getModels keeps them so sessions can still resolve them. */
  filterAvailable?: <T extends { id: string }>(models: readonly T[]) => T[];
  now?: () => number;
}

export interface ExtensionProviderController {
  provider: Provider<CliproxyApi>;
  getModels: () => readonly CliproxyModel[];
  getStandardCost: (modelId: string) => ModelCost;
  getCatalogFetchedAt: () => number;
  refresh: (connection: ResolvedConnection) => Promise<void>;
}

const CATALOG_TTL_MS = 10 * 60_000;

interface RemoteCatalog {
  baseUrl: string;
  costs: CostCatalog;
  entries: TrackedEntry[];
}

/**
 * The provider pi registers. It keeps the catalog as fetched and derives the
 * models from it with the current settings, so /fast and config edits apply
 * without a network request.
 */
export const createExtensionProvider = (
  options: ExtensionProviderOptions
): ExtensionProviderController => {
  const { fast, prices, settings } = options;
  const now = options.now ?? Date.now;
  const cached = settings.modelsCache(settings.baseUrl());
  let baseUrl = cached?.baseUrl ?? settings.baseUrl();
  let entries: TrackedEntry[] = cached?.entries ?? [];
  let catalogFetchedAt = cached?.fetchedAt ?? 0;
  let costs = prices.cached() ?? costCatalogFromPrices({});
  let models: CliproxyModel[] = [];

  const derive = (): void => {
    const config = settings.config();

    models = mapCatalog(entries, {
      anthropicCompat,
      baseUrl,
      costs,
      fast: fast.isEnabled,
      imageInput: config.imageInput,
      maxTokens: config.maxTokens,
      promptCache: anthropicPromptCache,
      providerId: settings.providerId,
      thoughtSummaries: config.thinkingDisplay,
    });
    fast.setSupportedModelIds(
      models.flatMap((model) => (model.supportsFast ? [model.id] : []))
    );
    options.onModels?.(models);
  };

  derive();

  const fetchRemote = async (
    connection: ResolvedConnection,
    signal?: AbortSignal
  ): Promise<RemoteCatalog> => {
    const fetched = await fetchCatalog({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      signal,
    });

    const tracked = mergeCatalog(
      baseUrl === connection.baseUrl ? entries : [],
      fetched.flatMap((entry) => {
        const id = catalogId(entry);

        return id ? [{ ...entry, id }] : [];
      })
    );

    const loaded = await prices.load(
      tracked.map((entry) => entry.id),
      signal
    );

    if (loaded.warning) {
      options.onPriceWarning?.(loaded.warning);
    }

    return {
      baseUrl: connection.baseUrl,
      costs: loaded.catalog,
      entries: tracked,
    };
  };

  const commit = (remote: RemoteCatalog): void => {
    ({ baseUrl, costs, entries } = remote);
    catalogFetchedAt = now();
    settings.saveModelsCache({ baseUrl, entries, fetchedAt: catalogFetchedAt });
    derive();
  };

  const refresh = async (connection: ResolvedConnection): Promise<void> => {
    commit(await fetchRemote(connection));
  };

  const refreshModels = async (
    context: RefreshModelsContext
  ): Promise<void> => {
    if (!context.allowNetwork) {
      await context.publish({ update: derive });

      return;
    }

    const connection = settings.connectionFor(context.credential);

    if (!connection) {
      return;
    }

    const fresh =
      baseUrl === connection.baseUrl &&
      now() - catalogFetchedAt < CATALOG_TTL_MS;

    if (!context.force && fresh) {
      return;
    }

    const remote = await fetchRemote(connection, context.signal);
    await context.publish({ update: () => commit(remote) });
  };

  const login = async (
    interaction: ProviderAuthInteraction
  ): Promise<OAuthCredential> => {
    let loginBaseUrl = settings.baseUrl();

    while (true) {
      interaction.notify({
        message:
          "Configure CLIProxyAPI with its root or /v1 base URL and API key.",
        type: "progress",
      });

      const enteredBaseUrl = await interaction.prompt({
        message: `CLIProxyAPI base URL [${loginBaseUrl}]:`,
        placeholder: loginBaseUrl,
        type: "text",
      });

      loginBaseUrl = enteredBaseUrl.trim() || loginBaseUrl;
      resolveEndpoints(loginBaseUrl);

      const enteredApiKey = await interaction.prompt({
        message: "CLIProxyAPI API key:",
        placeholder: "sk-...",
        type: "secret",
      });

      const apiKey = enteredApiKey.trim();

      if (!apiKey) {
        throw new Error("API key cannot be empty.");
      }

      try {
        interaction.notify({
          message: "Validating credentials via the models endpoint...",
          type: "progress",
        });
        await refresh(connectionTo(loginBaseUrl, apiKey));
        // pi keeps the key and address in auth.json. The file outranks the
        // login, so values left there would hide this login.
        settings.save({
          apiKey: undefined,
          baseUrl: undefined,
          providerId: settings.providerId,
          providerName: settings.providerName,
        });

        return { ...loginCredentials(loginBaseUrl, apiKey), type: "oauth" };
      } catch (error) {
        interaction.signal.throwIfAborted();
        interaction.notify({
          message: `Login validation failed: ${errorText(error)}. Please re-enter the connection.`,
          type: "progress",
        });
      }
    }
  };

  const base = createProvider<CliproxyApi>({
    api: cliproxyApis({ fast: fast.isEnabled }),
    auth: {
      apiKey: {
        name: "CLIProxyAPI environment or configuration",
        resolve: ({ credential }) => {
          const connection = settings.connectionFor(credential);

          return Promise.resolve(
            connection
              ? {
                  auth: { apiKey: connection.apiKey },
                  source: "CLIPROXYAPI_API_KEY or cliproxyapi.json",
                }
              : undefined
          );
        },
      },
      oauth: {
        login,
        name: settings.providerName,
        refresh: (credential) =>
          Promise.resolve({
            ...credential,
            expires: loginExpiry(),
          }),
        toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
    baseUrl: resolveEndpoints(baseUrl).rootUrl,
    id: settings.providerId,
    models: [],
    name: settings.providerName,
  });

  const provider: Provider<CliproxyApi> = {
    ...base,
    filterModels: (list) => options.filterAvailable?.(list) ?? list,
    getAllModels: () => models,
    getModels: () => models,
    refreshModels,
  };

  return {
    getCatalogFetchedAt: () => catalogFetchedAt,
    getModels: () => models,
    getStandardCost: (modelId) => matchModelCost(modelId, costs),
    provider,
    refresh,
  };
};
