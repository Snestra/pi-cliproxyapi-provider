import path from "node:path";

import { Type } from "typebox";
import type { Static } from "typebox";

import {
  costCatalogFromPrices,
  DEFAULT_COSTS_URL,
  fetchCostsConditional,
  resolvePrices,
} from "../core/costs.ts";
import type { CostCatalog } from "../core/costs.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../core/time.ts";
import { readJsonMemo, writeJsonAtomic } from "./files.ts";

const PRICES_FILE_NAME = "cliproxyapi-prices.json";

/** models.dev prices change rarely, so they are revalidated at most once a day. */
const PRICES_TTL_MS = DAY_MS;

const RateFields = {
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  input: Type.Number(),
  output: Type.Number(),
};

/** pi-ai's ModelCost. pi does not expose pi-ai's model-schema module to extensions, and typecheck holds this to ModelCost where the file feeds costCatalogFromPrices. */
const ModelCostSchema = Type.Object({
  ...RateFields,
  tiers: Type.Optional(
    Type.Array(Type.Object({ ...RateFields, inputTokensAbove: Type.Number() }))
  ),
});

const PricesFileSchema = Type.Object({
  etag: Type.Optional(Type.String()),
  fetchedAt: Type.Number(),
  prices: Type.Record(
    Type.String(),
    Type.Union([
      Type.Null(),
      Type.Object({
        fast: Type.Optional(ModelCostSchema),
        standard: ModelCostSchema,
      }),
    ])
  ),
  source: Type.String(),
});

type PricesFile = Static<typeof PricesFileSchema>;

export interface PriceCacheOptions {
  agentDir: string;
  costsUrl?: string;
  now?: () => number;
}

export interface PriceLoad {
  catalog: CostCatalog;
  /** Set when models.dev failed. The text is ready to show the user. */
  warning?: string;
}

export interface PriceCacheInfo {
  fetchedAt?: number;
  etag?: string;
}

const plural = (count: number, unit: string): string =>
  `${count} ${unit}${count === 1 ? "" : "s"}`;

const formatAge = (ageMs: number): string => {
  if (ageMs < MINUTE_MS) {
    return "less than a minute";
  }

  if (ageMs < HOUR_MS) {
    return plural(Math.floor(ageMs / MINUTE_MS), "minute");
  }

  if (ageMs < 2 * DAY_MS) {
    return plural(Math.floor(ageMs / HOUR_MS), "hour");
  }

  return plural(Math.floor(ageMs / DAY_MS), "day");
};

/**
 * Keeps the models.dev prices of the catalog's ids in
 * `<agentDir>/cliproxyapi-prices.json`. Prices under 24 h old are used without
 * a request. Older ones are revalidated with If-None-Match, so an unchanged
 * catalog costs one 304 instead of a 5.9 MB download and parse.
 */
export class PriceCache {
  private readonly filePath: string;
  private readonly costsUrl: string;
  private readonly now: () => number;

  constructor(options: PriceCacheOptions) {
    this.filePath = path.join(options.agentDir, PRICES_FILE_NAME);
    this.costsUrl = options.costsUrl ?? DEFAULT_COSTS_URL;
    this.now = options.now ?? Date.now;
  }

  /** Prices for these catalog ids, fetching only when needed. Never throws for a models.dev failure. */
  async load(ids: readonly string[], signal?: AbortSignal): Promise<PriceLoad> {
    const file = this.read();
    const now = this.now();

    const complete =
      file?.source === this.costsUrl && ids.every((id) => id in file.prices);

    // A 304 cannot price an id the file lacks, so only a complete file is revalidated.
    const revalidating = complete ? file : undefined;

    if (revalidating) {
      const age = now - revalidating.fetchedAt;

      if (age >= 0 && age < PRICES_TTL_MS) {
        return { catalog: costCatalogFromPrices(revalidating.prices) };
      }
    }

    const result = await fetchCostsConditional({
      etag: revalidating?.etag,
      signal,
      url: this.costsUrl,
    });

    if (result.status === "fresh") {
      const prices = resolvePrices(ids, result.costs);
      this.write({ etag: result.etag, fetchedAt: now, prices });

      return { catalog: costCatalogFromPrices(prices) };
    }

    if (result.status === "not-modified" && revalidating) {
      this.write({ ...revalidating, fetchedAt: now });

      return { catalog: costCatalogFromPrices(revalidating.prices) };
    }

    const reason = result.status === "failed" ? result.reason : "HTTP 304";

    if (!file) {
      return {
        catalog: costCatalogFromPrices({}),
        warning: `Couldn't load prices from models.dev (${reason}). Costs show $0 until prices load.`,
      };
    }

    return {
      catalog: costCatalogFromPrices(file.prices),
      warning: `Couldn't update prices from models.dev (${reason}). Using prices from ${formatAge(Math.max(0, now - file.fetchedAt))} ago.`,
    };
  }

  cached(): CostCatalog | undefined {
    const file = this.read();

    return file ? costCatalogFromPrices(file.prices) : undefined;
  }

  describe(): PriceCacheInfo | undefined {
    const file = this.read();

    if (!file) {
      return undefined;
    }

    return {
      etag: file.etag,
      fetchedAt: file.fetchedAt,
    };
  }

  /** A missing or damaged file reads as no prices, so the next load fetches and rewrites it. */
  private read(): PricesFile | undefined {
    try {
      return readJsonMemo(this.filePath, PricesFileSchema);
    } catch {
      return undefined;
    }
  }

  private write(file: Omit<PricesFile, "source">): void {
    writeJsonAtomic(this.filePath, { ...file, source: this.costsUrl });
  }
}
