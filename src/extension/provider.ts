/* oxlint-disable eslint/no-await-in-loop -- OAuth login prompts and validation are intentionally sequential so each retry uses the latest input. */
import type {
  ModelCost,
  OAuthCredential,
  Provider,
  ProviderAuthInteraction,
  RefreshModelsContext,
} from "@earendil-works/pi-ai";

import {
  applyAnthropicSettings,
  createCliproxyProvider,
  fetchCatalog,
  mapCatalog,
  matchModelCost,
  mergeCatalog,
  resolveEndpoints,
  withImageInput,
} from "../core/index.ts";
import type {
  CliproxyApi,
  CliproxyModel,
  CostCatalog,
  ResolvedConnection,
} from "../core/index.ts";
import { anthropicCompat, anthropicPromptCache } from "./anthropic-builtins.ts";
import {
  buildOAuthCredentials,
  CREDENTIAL_TTL_MS,
  decodeRefreshMeta,
  defaultConnectionBaseUrl,
  loadCliproxyConfig,
  loadModelsCache,
  resolveExtensionConnection,
  saveCliproxyConfig,
  saveModelsCache,
} from "./config.ts";
import type { CliproxyConfig } from "./config.ts";
import type { FastModeController } from "./fast.ts";
import { PriceCache } from "./prices.ts";

export interface ExtensionProviderOptions {
  agentDir: string;
  connection: ResolvedConnection;
  providerId: string;
  providerName: string;
  fast: FastModeController;
  config?: CliproxyConfig;
  /** Used by the default price cache when `prices` is not given. */
  costsUrl?: string;
  fetchFn?: typeof fetch;
  /** Shared with the status command. Defaults to a cache in agentDir that uses costsUrl and fetchFn. */
  prices?: PriceCache;
  /** Called with a ready-to-show message when models.dev prices could not be loaded. */
  onPriceWarning?: (message: string) => void;
  onModels?: (models: readonly CliproxyModel[]) => void;
  /** Drops models that are out of quota from pi's available list. getModels keeps them so sessions can still resolve them. */
  filterAvailable?: <T extends { id: string }>(models: readonly T[]) => T[];
  /** False for the empty provider registered solely to expose /login. */
  configured?: boolean;
  /** Clock for the catalog freshness check. Tests inject it. */
  now?: () => number;
}

export interface ExtensionProviderController {
  provider: Provider<CliproxyApi>;
  getModels: () => readonly CliproxyModel[];
  getStandardCost: (modelId: string) => ModelCost | undefined;
  /** When the catalog was last fetched, or 0 when it never was. */
  getCatalogFetchedAt: () => number;
  refresh: (
    connection?: ResolvedConnection
  ) => Promise<readonly CliproxyModel[]>;
}

/** A non-forced refresh skips the network while the catalog is younger than this. */
const CATALOG_TTL_MS = 10 * 60_000;

interface RemoteCatalog {
  costs: CostCatalog;
  fastModelIds: string[];
  models: CliproxyModel[];
}

const oauthConnection = (
  credential: OAuthCredential,
  fallback: ResolvedConnection
): ResolvedConnection => {
  const stored = decodeRefreshMeta(credential.refresh);

  return {
    ...resolveEndpoints(stored.baseUrl ?? fallback.baseUrl),
    apiKey: credential.access,
    baseUrl: stored.baseUrl ?? fallback.baseUrl,
  };
};

const builtins = {
  anthropicCompat,
  promptCache: anthropicPromptCache,
};

export const createExtensionProvider = (
  options: ExtensionProviderOptions
): ExtensionProviderController => {
  const config = options.config ?? loadCliproxyConfig(options.agentDir);

  const cached = loadModelsCache(
    options.agentDir,
    options.connection.baseUrl,
    options.fast.isEnabled()
  );

  // Cached Claude models may predate the current compat and promptCache, so they get them here.
  let currentModels: CliproxyModel[] = (cached?.models ?? []).map((model) => {
    const loaded: CliproxyModel = {
      ...model,
      input: withImageInput(model.input, config.imageInput?.[model.id]),
      maxTokens: config.maxTokens?.[model.id] ?? model.maxTokens,
      thoughtSummary: config.thinkingDisplay?.[model.id] ?? "omitted",
    };

    if (model.api === "anthropic-messages") {
      applyAnthropicSettings(loaded, builtins);
    }

    return loaded;
  });

  let currentCosts: CostCatalog | undefined;
  const now = options.now ?? Date.now;
  let catalogFetchedAt = cached?.fetchedAt ?? 0;

  const prices =
    options.prices ??
    new PriceCache({
      agentDir: options.agentDir,
      costsUrl: options.costsUrl,
      fetchFn: options.fetchFn,
    });

  if (cached) {
    options.fast.setSupportedModelIds(cached.fastModelIds);
  }

  const core = createCliproxyProvider({
    apiKey: options.connection.apiKey,
    baseUrl: options.connection.baseUrl,
    costsUrl: options.costsUrl,
    fast: options.fast.isEnabled,
    fetch: options.fetchFn,
    imageInput: config.imageInput,
    maxTokens: config.maxTokens,
    models: currentModels,
    ...builtins,
    providerId: options.providerId,
    providerName: options.providerName,
    thoughtSummaries: config.thinkingDisplay,
  });

  const fetchRemote = async (
    connection: ResolvedConnection,
    signal?: AbortSignal
  ): Promise<RemoteCatalog> => {
    const entries = await fetchCatalog({
      apiKey: connection.apiKey,
      baseUrl: connection.baseUrl,
      fetch: options.fetchFn,
      signal,
    });

    // Prices are kept per catalog id, so the ids come from the same mapping the models do.
    const ids = mapCatalog(entries, { baseUrl: connection.baseUrl }).models.map(
      (model) => model.id
    );

    const { catalog: costs, warning } = await prices.load(ids, signal);

    if (warning) {
      options.onPriceWarning?.(warning);
    }

    const mapped = mapCatalog(entries, {
      baseUrl: connection.baseUrl,
      costs,
      fast: options.fast.isEnabled,
      imageInput: config.imageInput,
      maxTokens: config.maxTokens,
      ...builtins,
      providerId: options.providerId,
      thoughtSummaries: config.thinkingDisplay,
    });

    return {
      costs,
      fastModelIds: mapped.fastModelIds,
      models: mergeCatalog(currentModels, mapped.models),
    };
  };

  const commit = (
    connection: ResolvedConnection,
    remote: RemoteCatalog
  ): readonly CliproxyModel[] => {
    catalogFetchedAt = now();
    currentModels = remote.models;
    currentCosts = remote.costs;
    options.fast.setSupportedModelIds(remote.fastModelIds);
    saveModelsCache(options.agentDir, {
      baseUrl: connection.baseUrl,
      fast: options.fast.isEnabled(),
      fastModelIds: remote.fastModelIds,
      fetchedAt: catalogFetchedAt,
      models: currentModels,
    });
    options.onModels?.(currentModels);

    return currentModels;
  };

  const refresh = async (
    connection = resolveExtensionConnection({
      agentDir: options.agentDir,
      env: process.env,
      providerId: options.providerId,
    }) ?? options.connection
  ): Promise<readonly CliproxyModel[]> =>
    commit(connection, await fetchRemote(connection));

  const refreshModels = async (
    context: RefreshModelsContext
  ): Promise<void> => {
    if (!context.allowNetwork) {
      return;
    }

    if (!context.force && now() - catalogFetchedAt < CATALOG_TTL_MS) {
      return;
    }

    let connection: ResolvedConnection;

    if (context.credential?.type === "oauth") {
      connection = oauthConnection(context.credential, options.connection);
    } else if (context.credential?.type === "api_key") {
      connection = {
        ...options.connection,
        apiKey: context.credential.key ?? options.connection.apiKey,
      };
    } else {
      connection =
        resolveExtensionConnection({
          agentDir: options.agentDir,
          env: process.env,
          providerId: options.providerId,
        }) ?? options.connection;
    }

    const remote = await fetchRemote(connection, context.signal);
    await context.publish({
      update: () => {
        commit(connection, remote);
      },
    });
  };

  const login = async (
    interaction: ProviderAuthInteraction
  ): Promise<OAuthCredential> => {
    let baseUrl = defaultConnectionBaseUrl(
      options.agentDir,
      options.providerId
    );

    while (true) {
      interaction.notify({
        message:
          "Configure CLIProxyAPI with its root or /v1 base URL and API key.",
        type: "progress",
      });

      const enteredBaseUrl = await interaction.prompt({
        message: `CLIProxyAPI base URL [${baseUrl}]:`,
        placeholder: baseUrl,
        type: "text",
      });

      baseUrl = enteredBaseUrl.trim() || baseUrl;
      resolveEndpoints(baseUrl);

      const enteredApiKey = await interaction.prompt({
        message: "CLIProxyAPI API key:",
        placeholder: "sk-...",
        type: "secret",
      });

      const apiKey = enteredApiKey.trim();

      if (!apiKey) {
        throw new Error("API key cannot be empty.");
      }

      const connection = {
        ...resolveEndpoints(baseUrl),
        apiKey,
        baseUrl,
      };

      try {
        interaction.notify({
          message: "Validating credentials via the models endpoint...",
          type: "progress",
        });
        await refresh(connection);
        // pi keeps the key and address in auth.json. The file outranks the
        // login, so values left there would hide this login.
        saveCliproxyConfig(options.agentDir, {
          apiKey: undefined,
          baseUrl: undefined,
          providerId: options.providerId,
          providerName: options.providerName,
        });

        return { ...buildOAuthCredentials(baseUrl, apiKey), type: "oauth" };
      } catch (error) {
        interaction.signal.throwIfAborted();
        interaction.notify({
          message: `Login validation failed: ${error instanceof Error ? error.message : String(error)}. Please re-enter the connection.`,
          type: "progress",
        });
      }
    }
  };

  const provider: Provider<CliproxyApi> = {
    ...core,
    auth: {
      apiKey: {
        name: "CLIProxyAPI environment or configuration",
        resolve: ({ credential }) => {
          const connection = credential?.key
            ? { ...options.connection, apiKey: credential.key }
            : (resolveExtensionConnection({
                agentDir: options.agentDir,
                env: process.env,
                providerId: options.providerId,
              }) ?? options.connection);

          if (options.configured === false) {
            return Promise.resolve(undefined);
          }

          return Promise.resolve({
            auth: { apiKey: connection.apiKey },
            source: "CLIPROXYAPI_API_KEY or cliproxyapi.json",
          });
        },
      },
      oauth: {
        login,
        name: options.providerName,
        refresh: (credential) =>
          Promise.resolve({
            ...credential,
            expires: Date.now() + CREDENTIAL_TTL_MS,
          }),
        toAuth: (credential) => Promise.resolve({ apiKey: credential.access }),
      },
    },
    filterModels: (models) => options.filterAvailable?.(models) ?? models,
    // core's own getAllModels returns its startup baseline, so it must follow currentModels too.
    getAllModels: () => currentModels,
    getModels: () => currentModels,
    refreshModels,
  };

  return {
    getCatalogFetchedAt: () => catalogFetchedAt,
    getModels: () => currentModels,
    getStandardCost: (modelId) => {
      const costs = currentCosts ?? prices.cached();

      if (costs) {
        return matchModelCost(modelId, costs);
      }

      return options.fast.isEnabled()
        ? undefined
        : currentModels.find((model) => model.id === modelId)?.cost;
    },
    provider,
    refresh,
  };
};
