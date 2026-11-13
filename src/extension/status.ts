import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { ThoughtSummary } from "../core/catalog.ts";
import type { ValueSource } from "../core/connection.ts";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "../core/time.ts";
import { MANAGEMENT_KEY_ENV } from "./config.ts";
import type { ManagementKeySource } from "./config.ts";
import { errorText } from "./error-text.ts";

/** Everything /cliproxyapi-status shows. It holds where keys come from, never the keys. */
export interface StatusSnapshot {
  baseUrl: string;
  /** Undefined when no API key is configured. */
  keySource?: ValueSource;
  models: number;
  stale: number;
  /** Undefined when the catalog was never fetched. */
  catalogAgeMs?: number;
  /** Undefined before prices were first loaded. */
  prices?: { ageMs: number; etag?: string };
  fast: boolean;
  fastModels: number;
  /** True when the extension owns the footer, false when pi's stock footer shows. */
  footer: boolean;
  paused: boolean;
  /** Undefined without a management key. */
  management?: { source: ManagementKeySource; usageAgeMs?: number };
  /** Why the managementKey command gave no key. */
  managementError?: string;
  searchModel: { configured?: string; effective?: string };
  thinking: Readonly<Record<string, ThoughtSummary>>;
}

const ETAG_PREFIX_LENGTH = 8;
const ETAG_WRAPPING = /^(?:W\/)?"?|"$/gu;

const KEY_SOURCE_LABELS: Readonly<Record<ValueSource, string>> = {
  "cliproxyapi.json": "key from cliproxyapi.json",
  default: "not configured",
  env: "key from env CLIPROXYAPI_API_KEY",
  login: "key from auth.json (/login)",
};

const MANAGEMENT_SOURCE_LABELS: Readonly<Record<ManagementKeySource, string>> =
  {
    "cliproxyapi.json": "key set (cliproxyapi.json)",
    env: `key set (env ${MANAGEMENT_KEY_ENV})`,
  };

const THINKING_ORDER: readonly ThoughtSummary[] = ["summarized", "omitted"];

const formatShortAge = (ageMs: number): string => {
  if (ageMs < MINUTE_MS) {
    return "just now";
  }

  if (ageMs < HOUR_MS) {
    return `${Math.floor(ageMs / MINUTE_MS)} min old`;
  }

  if (ageMs < 2 * DAY_MS) {
    return `${Math.floor(ageMs / HOUR_MS)} h old`;
  }

  return `${Math.floor(ageMs / DAY_MS)} d old`;
};

const formatModels = (snapshot: StatusSnapshot): string => {
  const stale = snapshot.stale > 0 ? ` (${snapshot.stale} stale)` : "";

  const catalog =
    snapshot.catalogAgeMs === undefined
      ? "not fetched"
      : formatShortAge(snapshot.catalogAgeMs);

  return `${snapshot.models}${stale}, catalog ${catalog}`;
};

const formatPrices = (prices: StatusSnapshot["prices"]): string => {
  if (!prices) {
    return "not loaded";
  }

  const etag = prices.etag
    ?.replaceAll(ETAG_WRAPPING, "")
    .slice(0, ETAG_PREFIX_LENGTH);

  return `models.dev, ${formatShortAge(prices.ageMs)}${etag ? ` (etag ${etag})` : ""}`;
};

const formatFast = (snapshot: StatusSnapshot): string => {
  const support =
    snapshot.fastModels === 1
      ? "1 model supports it"
      : `${snapshot.fastModels} models support it`;

  return `${snapshot.fast ? "on" : "off"} (${support})`;
};

const formatManagement = (
  management: StatusSnapshot["management"],
  error: string | undefined
): string => {
  if (!management) {
    return error ? `key command failed: ${error}` : "not set";
  }

  const usage =
    management.usageAgeMs === undefined
      ? ""
      : `, usage ${formatShortAge(management.usageAgeMs)}`;

  return `${MANAGEMENT_SOURCE_LABELS[management.source]}${usage}`;
};

const formatSearchModel = (
  searchModel: StatusSnapshot["searchModel"]
): string =>
  searchModel.configured ??
  `auto (${searchModel.effective ?? "none available"})`;

const formatThinking = (thinking: StatusSnapshot["thinking"]): string => {
  const groups = THINKING_ORDER.flatMap((value) => {
    const ids = Object.keys(thinking)
      .filter((id) => thinking[id] === value)
      .toSorted();

    return ids.length > 0 ? [`${value}: ${ids.join(", ")}`] : [];
  });

  return groups.length > 0 ? groups.join("; ") : "omitted for all models";
};

export const formatStatus = (snapshot: StatusSnapshot): string =>
  [
    `CLIProxyAPI  ${snapshot.baseUrl}  ${snapshot.keySource ? KEY_SOURCE_LABELS[snapshot.keySource] : "not configured"}`,
    `Models       ${formatModels(snapshot)}`,
    `Prices       ${formatPrices(snapshot.prices)}`,
    `Fast         ${formatFast(snapshot)}    Paused  ${snapshot.paused ? "yes" : "no"}    Footer  ${snapshot.footer ? "custom" : "pi stock"}`,
    `Management   ${formatManagement(snapshot.management, snapshot.managementError)}`,
    `Web search   ${formatSearchModel(snapshot.searchModel)}`,
    `Thinking     ${formatThinking(snapshot.thinking)}`,
  ].join("\n");

export interface StatusSources {
  gather: () => StatusSnapshot;
  /** Brings the server and the model list up to date. Returns one line per step that failed. */
  refresh: (ctx: ExtensionContext) => Promise<string[]>;
}

export const registerStatus = (
  pi: ExtensionAPI,
  { gather, refresh }: StatusSources
): void => {
  pi.registerCommand("cliproxyapi-status", {
    description:
      "Reload CLIProxyAPI models, clear cooldowns, and show the connection, models, prices, Fast, pause, usage, web search model, and thought summaries.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /cliproxyapi-status", "error");

        return;
      }

      const problems = await refresh(ctx);

      try {
        ctx.ui.notify(
          [formatStatus(gather()), ...problems].join("\n"),
          problems.length > 0 ? "warning" : "info"
        );
      } catch (error) {
        ctx.ui.notify(
          `Failed to read CLIProxyAPI status: ${errorText(error)}`,
          "error"
        );
      }
    },
  });
};
