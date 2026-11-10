import { Type } from "typebox";
import type { Static, TSchema } from "typebox";

import { activeCredentials, servedModels } from "./credentials.ts";
import type { Credential, Signals } from "./credentials.ts";
import { managementRequest, parseJson } from "./management.ts";
import type { ManagementRequestOptions } from "./management.ts";
import { MINUTE_MS, SECOND_MS } from "./time.ts";
import { footerName, usageSource } from "./upstreams.ts";

/** One rate-limit window of an upstream account, such as Claude's five hours. Times are epoch milliseconds. */
const UsageWindowSchema = Type.Object({
  label: Type.String(),
  resetAt: Type.Optional(Type.Number()),
  usedPercent: Type.Number(),
});

export type UsageWindow = Static<typeof UsageWindowSchema>;

/**
 * Usage of one CLIProxyAPI credential, the upstream account behind some
 * models. `provider` is CLIProxyAPI's id, such as `kimi-ai`; `name` is
 * the footer's. `observedAt` is when the server recorded the quota signals
 * behind the windows, when it reports one. Times are epoch milliseconds.
 */
export const ProviderUsageSchema = Type.Object({
  exhaustedUntil: Type.Optional(Type.Number()),
  models: Type.Array(Type.String()),
  name: Type.String(),
  observedAt: Type.Optional(Type.Number()),
  provider: Type.String(),
  windows: Type.Array(UsageWindowSchema),
});

export type ProviderUsage = Static<typeof ProviderUsageSchema>;

export interface UsageFetchOptions extends ManagementRequestOptions {
  now?: number;
}

export interface ResetCooldownsOptions extends ManagementRequestOptions {
  /** Reset only the credentials that serve this model. Omit to reset every credential. */
  modelId?: string;
}

const FULL_PERCENT = 100;

/** Wait this long when a quota error names no reset time and nothing else knows it. */
export const QUOTA_FALLBACK_MS = 15 * MINUTE_MS;

const QUOTA_ERROR =
  /quota exhausted|subscription quota|usage[ _]limit|usage window|insufficient_quota|rate limit reached|exceed your account's rate limit/iu;

const RESETS_AT_EPOCH = /"resets_at"\s*:\s*(?<seconds>\d{9,})/u;
const RESETS_AT_ISO = /resets at (?<time>\d{4}-\d{2}-\d{2}T[\d:.]+Z)/iu;
const RESETS_IN_SECONDS = /"resets_in_seconds"\s*:\s*(?<seconds>\d+)/u;
const TRY_AGAIN_MINUTES = /try again in ~?\s*(?<minutes>\d+)\s*min/iu;
const COOLDOWN_SECONDS = /"reset_seconds"\s*:\s*(?<seconds>\d+)/u;

const COOLDOWN_AFTER =
  /\(reset after (?=\d)(?:(?<hours>\d+)h)?(?:(?<minutes>\d+)m)?(?:(?<seconds>\d+)s)?\)/u;

const finite = (value: string | number | undefined): number | undefined => {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : undefined;
};

const isoTime = (value: string | undefined): number | undefined => {
  const parsed = value === undefined ? Number.NaN : Date.parse(value);

  return Number.isNaN(parsed) ? undefined : parsed;
};

/** Milliseconds in a Go duration such as `2h30m0s`, as CLIProxyAPI writes a cooldown. */
const cooldownAfterMs = (message: string): number | undefined => {
  const groups = COOLDOWN_AFTER.exec(message)?.groups;

  if (!groups) {
    return undefined;
  }

  const { hours = "0", minutes = "0", seconds = "0" } = groups;

  return (
    (Number(hours) * 60 + Number(minutes)) * MINUTE_MS +
    Number(seconds) * SECOND_MS
  );
};

/**
 * When an error message says an upstream account ran out of quota, returns the
 * epoch milliseconds when it resets. Undefined for every other error. A message
 * that names no reset time resets at `fallbackAt`, such as the reset of the
 * account's full usage window.
 */
export const quotaResetFromError = (
  message: string,
  now = Date.now(),
  fallbackAt = now + QUOTA_FALLBACK_MS
): number | undefined => {
  if (!QUOTA_ERROR.test(message)) {
    return undefined;
  }

  const epoch = finite(RESETS_AT_EPOCH.exec(message)?.groups?.seconds);
  const inSeconds = finite(RESETS_IN_SECONDS.exec(message)?.groups?.seconds);
  const inMinutes = finite(TRY_AGAIN_MINUTES.exec(message)?.groups?.minutes);

  const cooldownSeconds = finite(
    COOLDOWN_SECONDS.exec(message)?.groups?.seconds
  );

  const cooldownMs = cooldownAfterMs(message);

  const candidates = [
    epoch === undefined ? undefined : epoch * SECOND_MS,
    isoTime(RESETS_AT_ISO.exec(message)?.groups?.time),
    inSeconds === undefined ? undefined : now + inSeconds * SECOND_MS,
    inMinutes === undefined ? undefined : now + inMinutes * MINUTE_MS,
    cooldownSeconds === undefined
      ? undefined
      : now + cooldownSeconds * SECOND_MS,
    cooldownMs === undefined ? undefined : now + cooldownMs,
  ];

  return (
    candidates.find((time) => time !== undefined && time > now) ?? fallbackAt
  );
};

const CooldownResetSchema = Type.Object({
  auth_index: Type.String(),
  models: Type.Array(Type.String()),
  status: Type.String(),
});

/** CLIProxyAPI relays the upstream body as text. */
const ApiCallSchema = Type.Object({
  body: Type.Optional(Type.String()),
  status_code: Type.Number(),
});

const KimiUsageSchema = Type.Object({
  usages: Type.Record(
    Type.String(),
    Type.Object({
      reset_time: Type.Optional(Type.String()),
      used_ratio: Type.Number(),
    })
  ),
});

type KimiUsage = Static<typeof KimiUsageSchema>;

const XaiBillingSchema = Type.Object({
  config: Type.Object({
    creditUsagePercent: Type.Number(),
    currentPeriod: Type.Optional(
      Type.Object({
        end: Type.Optional(Type.String()),
        start: Type.Optional(Type.String()),
      })
    ),
  }),
});

type XaiBilling = Static<typeof XaiBillingSchema>;

/** Normalized quota a CLIProxyAPI quota plugin returns for one credential. */
const PluginQuotaSchema = Type.Object({
  groups: Type.Optional(
    Type.Array(
      Type.Object({
        buckets: Type.Optional(
          Type.Array(
            Type.Object({
              remainingFraction: Type.Optional(Type.Number()),
              remaining_fraction: Type.Optional(
                Type.Union([Type.Number(), Type.String()])
              ),
              resetTime: Type.Optional(Type.String()),
              reset_time: Type.Optional(Type.String()),
              window: Type.Optional(Type.String()),
            })
          )
        ),
        displayName: Type.Optional(Type.String()),
        display_name: Type.Optional(Type.String()),
      })
    )
  ),
});

type PluginQuota = Static<typeof PluginQuotaSchema>;

const KIMI_WINDOWS = [
  ["limit_5h", "5h"],
  ["limit_month_total", "mo"],
] as const;

const DEVIN_WINDOWS = [
  ["daily", "1d"],
  ["weekly", "7d"],
] as const;

const XAI_BILLING_URL =
  "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const KIMI_AI_USAGE_URL = "https://api.kimi.ai/coding/v1/usages";
const KIMI_AI = /kimi-ai|kimi\.ai/iu;

/** CLIProxyAPI swaps this placeholder for the credential's own access token. */
const TOKEN_HEADER = { Authorization: "Bearer $TOKEN$" } as const;

const windowLabel = (minutes: number): string => {
  const day = 24 * 60;

  if (minutes >= day && minutes % day === 0) {
    return `${minutes / day}d`;
  }

  if (minutes >= 60 && minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  return `${Math.round(minutes)}m`;
};

const usageWindow = (
  label: string,
  usedPercent: number,
  resetAt: number | undefined
): UsageWindow => {
  const window: UsageWindow = { label, usedPercent };

  if (resetAt !== undefined) {
    window.resetAt = resetAt;
  }

  return window;
};

/** Header names arrive in any case. */
const signalReader = (signals: Signals) => {
  const byLowerKey = new Map(
    Object.entries(signals).map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    number: (key: string): number | undefined =>
      finite(byLowerKey.get(key.toLowerCase())),
    text: (key: string): string | undefined => {
      const value = byLowerKey.get(key.toLowerCase());

      return value === undefined ? undefined : String(value);
    },
  };
};

/** Claude's unified limits, which CLIProxyAPI records from response headers. */
const claudeWindows = (signals: Signals): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const label of ["5h", "7d"]) {
    const prefix = `Anthropic-Ratelimit-Unified-${label}`;
    const utilization = read.number(`${prefix}-Utilization`);
    const rejected = read.text(`${prefix}-Status`) === "rejected";

    if (utilization === undefined && !rejected) {
      continue;
    }

    const reset = read.number(`${prefix}-Reset`);
    windows.push(
      usageWindow(
        label,
        rejected ? FULL_PERCENT : (utilization ?? 0) * FULL_PERCENT,
        reset === undefined ? undefined : reset * SECOND_MS
      )
    );
  }

  return windows;
};

/** Codex's primary and secondary limits, which CLIProxyAPI records from response headers. */
const codexWindows = (signals: Signals, observedAt: number): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const slot of ["Primary", "Secondary"]) {
    const prefix = `X-Codex-${slot}`;
    const used = read.number(`${prefix}-Used-Percent`);
    const minutes = read.number(`${prefix}-Window-Minutes`);

    // Plans without a secondary limit report it as a zero-minute window.
    if (used === undefined || minutes === 0) {
      continue;
    }

    const resetAt = read.number(`${prefix}-Reset-At`);
    const resetAfter = read.number(`${prefix}-Reset-After-Seconds`);
    let reset: number | undefined;

    if (resetAt !== undefined) {
      reset = resetAt * SECOND_MS;
    } else if (resetAfter !== undefined) {
      reset = observedAt + resetAfter * SECOND_MS;
    }

    windows.push(
      usageWindow(
        minutes === undefined ? slot.toLowerCase() : windowLabel(minutes),
        used,
        reset
      )
    );
  }

  return windows;
};

/**
 * Devin's daily and weekly limits, which CLIProxyAPI records in quota signals
 * as remaining percents such as `55%`, with RFC 3339 reset times.
 */
const devinWindows = (signals: Signals): UsageWindow[] => {
  const read = signalReader(signals);
  const windows: UsageWindow[] = [];

  for (const [period, label] of DEVIN_WINDOWS) {
    const remainingText = read.text(`${period}_quota_remaining_percent`);

    const remaining =
      remainingText === undefined
        ? undefined
        : finite(remainingText.trim().replace(/%$/u, ""));

    if (remaining === undefined) {
      continue;
    }

    windows.push(
      usageWindow(
        label,
        FULL_PERCENT - remaining,
        isoTime(read.text(`${period}_quota_reset_at`))
      )
    );
  }

  return windows;
};

const pluginWindows = (body: PluginQuota | undefined): UsageWindow[] => {
  const windows: UsageWindow[] = [];

  for (const group of body?.groups ?? []) {
    for (const bucket of group.buckets ?? []) {
      const fraction = finite(
        bucket.remainingFraction ?? bucket.remaining_fraction
      );

      if (fraction === undefined) {
        continue;
      }

      const usedPercent = Math.min(
        FULL_PERCENT,
        Math.max(0, (1 - fraction) * FULL_PERCENT)
      );

      windows.push(
        usageWindow(
          bucket.window ?? group.displayName ?? group.display_name ?? "quota",
          usedPercent,
          isoTime(bucket.resetTime ?? bucket.reset_time)
        )
      );
    }
  }

  return windows;
};

const kimiWindows = (body: KimiUsage | undefined): UsageWindow[] => {
  const windows: UsageWindow[] = [];

  for (const [key, label] of KIMI_WINDOWS) {
    const usage = body?.usages[key];

    if (usage) {
      windows.push(
        usageWindow(
          label,
          usage.used_ratio * FULL_PERCENT,
          isoTime(usage.reset_time)
        )
      );
    }
  }

  return windows;
};

const xaiWindows = (body: XaiBilling | undefined): UsageWindow[] => {
  if (!body) {
    return [];
  }

  const period = body.config.currentPeriod;
  const start = isoTime(period?.start);
  const end = isoTime(period?.end);

  const minutes =
    start === undefined || end === undefined
      ? undefined
      : (end - start) / MINUTE_MS;

  return [
    usageWindow(
      minutes !== undefined && minutes > 0 ? windowLabel(minutes) : "period",
      body.config.creditUsagePercent,
      end
    ),
  ];
};

const fullUntil = (windows: readonly UsageWindow[]): number | undefined => {
  let until: number | undefined;

  for (const window of windows) {
    if (window.usedPercent >= FULL_PERCENT && window.resetAt !== undefined) {
      until = Math.max(until ?? 0, window.resetAt);
    }
  }

  return until;
};

interface Observed {
  windows: UsageWindow[];
  observedAt?: number;
}

export const fetchUsage = async (
  options: UsageFetchOptions
): Promise<ProviderUsage[]> => {
  const now = options.now ?? Date.now();

  const upstream = async <Schema extends TSchema>(
    credential: Credential,
    url: string,
    schema: Schema
  ): Promise<Static<Schema> | undefined> => {
    const result = await managementRequest(
      options,
      "/requests/api-call",
      ApiCallSchema,
      {
        body: JSON.stringify({
          auth_index: credential.auth_index,
          header: TOKEN_HEADER,
          method: "GET",
          url,
        }),
        method: "POST",
      }
    );

    const ok = result.status_code >= 200 && result.status_code < 300;

    return ok && result.body !== undefined
      ? parseJson(schema, result.body)
      : undefined;
  };

  const live = (windows: UsageWindow[]): Observed => ({
    observedAt: now,
    windows,
  });

  /** Signal windows carry the server's observation time. Every other source is fetched live, so it is observed now. */
  const windowsFor = async (credential: Credential): Promise<Observed> => {
    const signals = credential.quota?.signals ?? {};
    const recordedAt = isoTime(credential.quota?.observed_at);

    const recorded = (windows: UsageWindow[]): Observed =>
      recordedAt === undefined
        ? { windows }
        : { observedAt: recordedAt, windows };

    // A kimi credential whose file names kimi.ai or kimi-ai belongs to the .ai service.
    const kimiUrl = (source: "kimi-com-usages" | "kimi-ai-usages"): string =>
      source === "kimi-ai-usages" || KIMI_AI.test(credential.name)
        ? KIMI_AI_USAGE_URL
        : KIMI_USAGE_URL;

    const source = usageSource(credential.provider);

    switch (source) {
      case "claude-signals": {
        return recorded(claudeWindows(signals));
      }

      case "codex-signals": {
        return recorded(codexWindows(signals, recordedAt ?? now));
      }

      case "devin-signals": {
        return recorded(devinWindows(signals));
      }

      case "xai-billing": {
        return live(
          xaiWindows(
            await upstream(credential, XAI_BILLING_URL, XaiBillingSchema)
          )
        );
      }

      case "kimi-com-usages":
      case "kimi-ai-usages": {
        return live(
          kimiWindows(
            await upstream(credential, kimiUrl(source), KimiUsageSchema)
          )
        );
      }

      default: {
        break;
      }
    }

    // Providers such as antigravity and gemini record no quota signals, so
    // their windows come from a quota plugin when CLIProxyAPI names one for
    // the credential. Without one there is no recorded format to parse.
    if (credential.quota_plugin_id !== undefined) {
      return live(
        pluginWindows(
          await managementRequest(
            options,
            `/plugins/${encodeURIComponent(credential.quota_plugin_id)}/quota`,
            PluginQuotaSchema,
            {
              body: JSON.stringify({ auth_index: credential.auth_index }),
              method: "POST",
            }
          )
        )
      );
    }

    return recorded([]);
  };

  const credentials = await activeCredentials(options);

  const accounts = await Promise.all(
    credentials.map(async (credential): Promise<ProviderUsage | undefined> => {
      const [models, { observedAt, windows }] = await Promise.all([
        servedModels(options, credential).catch((): null => null),
        windowsFor(credential).catch((): Observed => ({ windows: [] })),
      ]);

      // One failing account must not empty the footer, so only it is left out.
      if (!models) {
        return undefined;
      }

      const retryAt = isoTime(credential.next_retry_after);

      const cooling =
        credential.unavailable === true &&
        retryAt !== undefined &&
        retryAt > now
          ? retryAt
          : undefined;

      const full = fullUntil(windows);

      const account: ProviderUsage = {
        models,
        name: footerName(credential.provider),
        provider: credential.provider,
        windows,
      };

      if (observedAt !== undefined) {
        account.observedAt = observedAt;
      }

      if (cooling !== undefined || full !== undefined) {
        account.exhaustedUntil = Math.max(cooling ?? 0, full ?? 0);
      }

      return account;
    })
  );

  return accounts.filter((account) => account !== undefined);
};

/**
 * Resets CLIProxyAPI routing cooldowns on the server and returns the model
 * ids the server reports as affected. With a model id, only the credentials
 * that serve that model are reset; without one, every credential is reset.
 * Credential `auth_index` values stay inside this function: callers pass a
 * model id, never an index.
 */
export const resetCooldowns = async (
  options: ResetCooldownsOptions
): Promise<string[]> => {
  const modelId = options.modelId?.trim() || undefined;
  const credentials = await activeCredentials(options);

  const served = await Promise.all(
    credentials.map(async (credential) => ({
      credential,
      models: await servedModels(options, credential),
    }))
  );

  const targets =
    modelId === undefined
      ? served
      : served.filter((entry) => entry.models.includes(modelId));

  if (targets.length === 0) {
    return [];
  }

  const results = await Promise.all(
    targets.map(async ({ credential }) => {
      const result = await managementRequest(
        options,
        "/routing/cooldown/reset",
        CooldownResetSchema,
        {
          body: JSON.stringify({ auth_index: credential.auth_index }),
          method: "POST",
        }
      );

      if (result.status !== "ok") {
        throw new Error(
          `CLIProxyAPI management /routing/cooldown/reset returned status ${result.status}`
        );
      }

      return result.models;
    })
  );

  return [...new Set(results.flat())];
};

/**
 * Models that no account can serve right now, with the time each comes back.
 * A model served by several accounts stays available until all of them run out.
 */
export const unavailableModels = (
  usage: readonly ProviderUsage[],
  exhausted: Readonly<Record<string, number>>,
  now = Date.now(),
  ignoreAccountExhaustion?: (account: ProviderUsage, model: string) => boolean
): Map<string, number> => {
  const hidden = new Map<string, number>();
  const accountsByModel = new Map<string, ProviderUsage[]>();

  for (const account of usage) {
    for (const model of account.models) {
      const accounts = accountsByModel.get(model);

      if (accounts) {
        accounts.push(account);
      } else {
        accountsByModel.set(model, [account]);
      }
    }
  }

  for (const [model, accounts] of accountsByModel) {
    const until = accounts.map((account) =>
      ignoreAccountExhaustion?.(account, model)
        ? 0
        : (account.exhaustedUntil ?? 0)
    );

    if (until.every((time) => time > now)) {
      hidden.set(model, Math.min(...until));
    }
  }

  for (const [model, until] of Object.entries(exhausted)) {
    if (until > now) {
      hidden.set(model, Math.max(hidden.get(model) ?? 0, until));
    }
  }

  return hidden;
};
