import type {
  AnthropicMessagesCompat,
  Api,
  Model,
  ModelPromptCache,
  ThinkingLevelMap,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { resolveEndpoints } from "./connection.ts";
import { matchModelCost, ZERO_COST } from "./costs.ts";
import type { CostCatalog } from "./costs.ts";

export type CliproxyApi =
  | "anthropic-messages"
  | "openai-responses"
  | "openai-completions";

export type ThoughtSummary = "omitted" | "summarized";

export type ModelFamilies = Readonly<Record<string, CliproxyApi>>;

/**
 * Family patterns. The wildcard is the fallback regardless of table order.
 * Kimi uses Anthropic Messages. On Responses CLIProxyAPI rejects its
 * prompt_cache_retention, and on Chat Completions it rejects the developer
 * role pi-ai sends for system prompts. Messages takes both and caches.
 */
export const MODEL_API_BY_FAMILY = {
  "*": "openai-responses",
  "claude-*": "anthropic-messages",
  "kimi-*": "anthropic-messages",
} satisfies ModelFamilies;

const OptionalString = Type.Optional(Type.String());
const OptionalNumber = Type.Optional(Type.Number());
const EffortName = Type.String();

const CatalogModelSchema = Type.Object({
  context_window: OptionalNumber,
  cpa_capabilities: Type.Optional(
    Type.Object({
      web_search: Type.Optional(Type.Boolean()),
    })
  ),
  description: OptionalString,
  display_name: OptionalString,
  id: OptionalString,
  input_modalities: Type.Optional(Type.Array(Type.String())),
  max_completion_tokens: OptionalNumber,
  max_context_window: OptionalNumber,
  max_output_tokens: OptionalNumber,
  max_tokens: OptionalNumber,
  name: OptionalString,
  service_tiers: Type.Optional(
    Type.Array(
      Type.Union([
        Type.String(),
        Type.Object({
          description: OptionalString,
          id: OptionalString,
          name: OptionalString,
        }),
      ])
    )
  ),
  slug: OptionalString,
  supported_reasoning_levels: Type.Optional(
    Type.Array(
      Type.Union([
        EffortName,
        Type.Object({ description: OptionalString, effort: OptionalString }),
      ])
    )
  ),
  supports_reasoning_effort_updates: Type.Optional(Type.Boolean()),
  visibility: OptionalString,
});

export type CatalogModel = Static<typeof CatalogModelSchema>;

/** When a model was last listed. mergeCatalog keeps an unlisted model as stale for a while. */
export interface Tracked {
  id: string;
  stale?: boolean;
  lastSeenAt?: number;
  staleSince?: number;
}

export const TrackedEntrySchema = Type.Object({
  ...CatalogModelSchema.properties,
  id: Type.String(),
  lastSeenAt: OptionalNumber,
  stale: Type.Optional(Type.Boolean()),
  staleSince: OptionalNumber,
});

export type TrackedEntry = Static<typeof TrackedEntrySchema>;

const CatalogEntries = Type.Array(CatalogModelSchema);

const CatalogEnvelope = Type.Union([
  CatalogEntries,
  Type.Object({ models: CatalogEntries }),
  Type.Object({ data: CatalogEntries }),
]);

export interface CliproxyModel extends Model<CliproxyApi>, Tracked {
  thoughtSummary: ThoughtSummary;
  supportsFast: boolean;
  supportsWebSearch?: boolean;
  thinkingLevelMap?: ThinkingLevelMap & { ultra?: string | null };
}

/** Models this provider built carry its own fields; pi hands back plain Model objects too. */
export const isCliproxyModel = (model: Model<Api>): model is CliproxyModel =>
  "thoughtSummary" in model && "supportsFast" in model;

export const DEFAULT_PROVIDER_ID = "cliproxyapi";

export interface MappingOptions {
  baseUrl: string;
  providerId?: string;
  families?: ModelFamilies;
  costs?: CostCatalog;
  fast?: () => boolean;
  thoughtSummaries?: Readonly<Record<string, ThoughtSummary>>;
  /** Output token limits by model id, for upstreams the catalog lists without one. */
  maxTokens?: Readonly<Record<string, number>>;
  /** Image input by model id, for upstreams the catalog lists with the wrong modalities. */
  imageInput?: Readonly<Record<string, boolean>>;
  /** Prompt cache lifetimes by model id. Core has no built-in numbers. */
  promptCache?: (id: string) => ModelPromptCache | undefined;
  /** pi-ai's own compat flags by model id, such as adaptive thinking for Claude 5. */
  anthropicCompat?: (id: string) => AnthropicMessagesCompat | undefined;
}

export interface CatalogFetchOptions {
  baseUrl: string;
  apiKey: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

export interface MergeOptions {
  now?: number;
  staleTtlMs?: number;
}

const DEFAULT_MODEL_STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

/** The model part of a prefixed alias (`<channel>/<model>`, such as devin/claude-fable-5-1). */
export const modelSegment = (id: string): string =>
  id.slice(id.lastIndexOf("/") + 1);

export const selectModelApi = (
  id: string,
  families: ModelFamilies = MODEL_API_BY_FAMILY
): CliproxyApi => {
  const modelId = id.trim().toLowerCase();
  // A prefix hides the family, so the segment matches too. Full-id matches
  // win, so an explicit prefixed pattern still takes over.
  const segment = modelSegment(modelId);
  const candidates = segment === modelId ? [modelId] : [modelId, segment];

  for (const candidate of candidates) {
    for (const [pattern, api] of Object.entries(families)) {
      if (pattern === "*") {
        continue;
      }

      if (
        pattern.endsWith("*")
          ? candidate.startsWith(pattern.slice(0, -1))
          : candidate === pattern
      ) {
        return api;
      }
    }
  }

  return families["*"] ?? "openai-responses";
};

const thinkingMap = (efforts: string[]): CliproxyModel["thinkingLevelMap"] => {
  if (efforts.length === 0) {
    return undefined;
  }

  const map: NonNullable<CliproxyModel["thinkingLevelMap"]> = {};

  for (const level of THINKING_LEVELS) {
    const effort = level === "off" ? "none" : level;
    map[level] = efforts.includes(effort) ? effort : null;
  }

  return map;
};

const positive = (...values: (number | undefined)[]): number | undefined =>
  values.find(
    (value) => value !== undefined && Number.isFinite(value) && value > 0
  );

const withImageInput = (
  input: readonly ("text" | "image")[],
  image: boolean | undefined
): ("text" | "image")[] => {
  if (image === undefined) {
    return [...input];
  }

  return image ? ["text", "image"] : ["text"];
};

const capabilities = (
  entry: CatalogModel,
  id: string,
  { imageInput, maxTokens }: Pick<MappingOptions, "imageInput" | "maxTokens">
) => {
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map((level) => {
      const effort = Value.Check(EffortName, level)
        ? level
        : (level.effort ?? "");

      return effort.trim().toLowerCase();
    })
    .filter(Boolean);

  const input: ("text" | "image")[] = [];

  for (const modality of entry.input_modalities ?? []) {
    const value = modality.trim().toLowerCase();

    if ((value === "text" || value === "image") && !input.includes(value)) {
      input.push(value);
    }
  }

  if (!input.includes("text")) {
    input.unshift("text");
  }

  return {
    contextWindow:
      positive(entry.context_window, entry.max_context_window) ?? 128_000,
    input: withImageInput(input, imageInput?.[id]),
    maxTokens:
      positive(
        maxTokens?.[id],
        entry.max_tokens,
        entry.max_output_tokens,
        entry.max_completion_tokens
      ) ?? 16_384,
    reasoning: efforts.some((effort) => effort !== "none"),
    thinkingLevelMap: thinkingMap(efforts),
  };
};

const webSearchCapability = (
  entry: CatalogModel
): { supportsWebSearch?: boolean } =>
  entry.cpa_capabilities?.web_search === undefined
    ? {}
    : { supportsWebSearch: entry.cpa_capabilities.web_search };

const applyAnthropicSettings = (
  model: CliproxyModel,
  options: Pick<MappingOptions, "anthropicCompat" | "promptCache">
): void => {
  // pi-ai sends the session id as X-Session-Affinity only when asked.
  // CLIProxyAPI's session affinity reads it to keep a session, and the
  // prompt cache, on one upstream account. Responses always sends one.
  model.compat = {
    ...options.anthropicCompat?.(model.id),
    sendSessionAffinityHeaders: true,
  };

  // pi warms the prompt cache only for models that declare its lifetimes.
  const promptCache = options.promptCache?.(model.id);

  if (promptCache) {
    model.promptCache = promptCache;
  }
};

const applyApiSettings = (
  model: CliproxyModel,
  entry: CatalogModel,
  options: MappingOptions
): void => {
  if (model.api === "anthropic-messages") {
    applyAnthropicSettings(model, options);
  } else if (
    model.api === "openai-responses" &&
    entry.supports_reasoning_effort_updates === true
  ) {
    // Effort then changes through configuration_update items, which keep the prompt cache.
    model.compat = { supportsMidConvoEffort: true };
  }
};

export const catalogId = (entry: CatalogModel): string =>
  (entry.slug ?? entry.id ?? "").trim();

const tracking = (entry: CatalogModel & Partial<Tracked>): Partial<Tracked> => {
  const result: Partial<Tracked> = {};

  if (entry.stale !== undefined) {
    result.stale = entry.stale;
  }

  if (entry.lastSeenAt !== undefined) {
    result.lastSeenAt = entry.lastSeenAt;
  }

  if (entry.staleSince !== undefined) {
    result.staleSince = entry.staleSince;
  }

  return result;
};

export const mapCatalog = (
  entries: readonly (CatalogModel & Partial<Tracked>)[],
  options: MappingOptions
): CliproxyModel[] => {
  const endpoints = resolveEndpoints(options.baseUrl);
  const models = new Map<string, CliproxyModel>();
  const fastPricing = options.fast?.() ?? false;

  for (const entry of entries) {
    const id = catalogId(entry);

    if (!id || entry.visibility?.toLowerCase() === "hide") {
      continue;
    }

    const api = selectModelApi(id, options.families);

    // Only Responses requests carry the priority tier.
    const supportsFast =
      api === "openai-responses" && (entry.service_tiers?.length ?? 0) > 0;

    const model: CliproxyModel = {
      ...capabilities(entry, id, options),
      api,
      baseUrl:
        api === "anthropic-messages"
          ? endpoints.anthropicBaseUrl
          : endpoints.openaiBaseUrl,
      cost: options.costs
        ? matchModelCost(id, options.costs, fastPricing && supportsFast)
        : { ...ZERO_COST },
      id,
      name: (entry.display_name ?? entry.name ?? id).trim() || id,
      provider: options.providerId ?? DEFAULT_PROVIDER_ID,
      supportsFast,
      thoughtSummary: options.thoughtSummaries?.[id] ?? "omitted",
      ...webSearchCapability(entry),
      ...tracking(entry),
    };

    applyApiSettings(model, entry, options);

    models.set(id, model);
  }

  return [...models.values()];
};

class CatalogHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string) {
    super(`Catalog request failed: ${status} ${statusText}`);
    this.name = "CatalogHttpError";
    this.status = status;
  }
}

export const fetchCatalog = async (
  options: CatalogFetchOptions
): Promise<CatalogModel[]> => {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 60_000);

  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;

  const response = await (options.fetch ?? globalThis.fetch)(
    resolveEndpoints(options.baseUrl).modelsUrl,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${options.apiKey}`,
      },
      signal,
    }
  );

  if (!response.ok) {
    throw new CatalogHttpError(response.status, response.statusText);
  }

  const payload: unknown = await response.json();

  if (!Value.Check(CatalogEnvelope, payload)) {
    throw new TypeError(
      "Invalid model catalog: expected an array, models, or data of catalog entries"
    );
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return "models" in payload ? payload.models : payload.data;
};

/**
 * Drops models the latest catalog no longer lists. mergeCatalog keeps them so
 * a session that uses one still resolves, but nobody should pick one anew.
 */
export const withoutStale = <T extends object>(models: readonly T[]): T[] =>
  models.filter((model) => !("stale" in model && model.stale === true));

export const mergeCatalog = <T extends Tracked>(
  previous: readonly T[],
  fresh: readonly T[],
  options: MergeOptions = {}
): T[] => {
  const now = options.now ?? Date.now();
  const ttl = options.staleTtlMs ?? DEFAULT_MODEL_STALE_TTL_MS;
  const merged = new Map<string, T>();

  for (const model of fresh) {
    const updated = { ...model, lastSeenAt: now, stale: false };
    delete updated.staleSince;
    merged.set(model.id, updated);
  }

  for (const model of previous) {
    if (merged.has(model.id)) {
      continue;
    }

    const lastSeenAt = model.lastSeenAt ?? now;
    const staleSince = model.stale ? (model.staleSince ?? lastSeenAt) : now;

    if (now - staleSince < ttl) {
      merged.set(model.id, { ...model, lastSeenAt, stale: true, staleSince });
    }
  }

  return [...merged.values()];
};
