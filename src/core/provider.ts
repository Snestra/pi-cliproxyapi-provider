import type { ProviderStreams } from "@earendil-works/pi-ai";
// pi maps only some pi-ai entry points into extensions. compat re-exports the same lazy API factories.
import {
  anthropicMessagesApi,
  openAICompletionsApi,
  openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Provider } from "@earendil-works/pi-ai/models";

import {
  DEFAULT_PROVIDER_ID,
  fetchCatalog,
  isCliproxyModel,
  mapCatalog,
  mergeCatalog,
  withoutStale,
} from "./catalog.ts";
import type { CliproxyApi, CliproxyModel, MappingOptions } from "./catalog.ts";
import { resolveEndpoints } from "./connection.ts";
import { fetchCosts } from "./costs.ts";
import { wrapCliproxyStreams } from "./streams.ts";
import type { PayloadSettings } from "./streams.ts";

export const cliproxyApis = (
  settings: PayloadSettings
): Record<CliproxyApi, ProviderStreams> => ({
  "anthropic-messages": wrapCliproxyStreams(anthropicMessagesApi(), settings),
  "openai-completions": wrapCliproxyStreams(openAICompletionsApi(), settings),
  "openai-responses": wrapCliproxyStreams(openAIResponsesApi(), settings),
});

export interface CliproxyProviderOptions extends MappingOptions {
  apiKey: string;
  providerName?: string;
  /** Static baseline models, available before the first refresh. */
  models?: readonly CliproxyModel[];
  fetch?: typeof globalThis.fetch;
  costsUrl?: string;
  staleTtlMs?: number;
}

export const createCliproxyProvider = (
  options: CliproxyProviderOptions
): Provider<CliproxyApi> => {
  if (!options.apiKey.trim()) {
    throw new Error("CLIProxyAPI apiKey is empty");
  }

  const endpoints = resolveEndpoints(options.baseUrl);
  const id = options.providerId ?? DEFAULT_PROVIDER_ID;

  const provider: Provider<CliproxyApi> = createProvider<CliproxyApi>({
    api: cliproxyApis(options),
    auth: {
      apiKey: {
        name: "CLIProxyAPI API key",
        resolve: () => Promise.resolve({ auth: { apiKey: options.apiKey } }),
      },
    },
    baseUrl: endpoints.rootUrl,
    fetchModels: async ({ signal, baseUrl }) => {
      const root = baseUrl ?? options.baseUrl;

      const [entries, costs] = await Promise.all([
        fetchCatalog({
          apiKey: options.apiKey,
          baseUrl: root,
          fetch: options.fetch,
          signal,
        }),
        options.costs ??
          fetchCosts({ fetch: options.fetch, signal, url: options.costsUrl }),
      ]);

      const mapped = mapCatalog(entries, { ...options, baseUrl: root, costs });

      const previous = provider.getModels().filter(isCliproxyModel);

      return mergeCatalog(previous, mapped, {
        staleTtlMs: options.staleTtlMs,
      });
    },
    filterModels: (models) => withoutStale(models),
    id,
    models: options.models ?? [],
    name: options.providerName ?? "CLIProxyAPI",
  });

  return provider;
};
