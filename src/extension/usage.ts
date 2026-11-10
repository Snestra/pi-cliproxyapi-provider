import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";

import { hasAccountWideQuota } from "../core/upstreams.ts";
import {
  QUOTA_FALLBACK_MS,
  fetchUsage,
  quotaResetFromError,
  resetCooldowns as resetServerCooldowns,
  ProviderUsageSchema,
  unavailableModels,
} from "../core/usage.ts";
import type { ProviderUsage } from "../core/usage.ts";
import type { ManagementKeySource, Settings } from "./config.ts";
import { errorText } from "./error-text.ts";
import { readJsonMemo, writeJsonAtomic } from "./files.ts";
import type { UsageSegment } from "./footer-render.ts";
import { formatStatusLine, outUntil } from "./footer-render.ts";
import { USAGE_STATUS_KEY } from "./status-keys.ts";

/** Shared by every pi process, so a quota error in one agent hides the model in all of them. */
const USAGE_FILE_NAME = "cliproxyapi-usage.json";

/** How old the shared usage snapshot may get before a session fetches a new one. */
const USAGE_TTL_MS = 2 * 60_000;
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

const UsageFileSchema = Type.Object({
  baseUrl: Type.Optional(Type.String()),
  exhausted: Type.Record(Type.String(), Type.Number()),
  fetchedAt: Type.Optional(Type.Number()),
  providers: Type.Array(ProviderUsageSchema),
  resets: Type.Optional(Type.Record(Type.String(), Type.Number())),
});

type UsageFile = Static<typeof UsageFileSchema>;

const EMPTY: UsageFile = { exhausted: {}, providers: [] };

/** For /cliproxyapi-status. Holds where the key comes from, never the key. */
export interface ManagementStatus {
  source: ManagementKeySource;
  /** When usage was last fetched for the current base URL. */
  usageFetchedAt?: number;
}

export interface UsageTrackerOptions {
  settings: Settings;
}

export class UsageTracker {
  private readonly filePath: string;
  private readonly settings: Settings;
  /** Quota marks this tracker guessed, by model id, until a usage fetch names the real reset. */
  private readonly guessedMarks = new Map<
    string,
    { recordedAt: number; until: number }
  >();

  constructor(options: UsageTrackerOptions) {
    this.settings = options.settings;
    this.filePath = path.join(options.settings.agentDir, USAGE_FILE_NAME);
  }

  /**
   * A missing or broken file counts as empty: it only holds a cache. The
   * result is shared through the file memo, so callers build new objects
   * instead of changing it.
   */
  private read(): UsageFile {
    try {
      return readJsonMemo(this.filePath, UsageFileSchema) ?? EMPTY;
    } catch {
      return EMPTY;
    }
  }

  private write(update: (current: UsageFile) => UsageFile): void {
    const now = Date.now();
    const next = update(this.read());

    const exhausted = Object.fromEntries(
      Object.entries(next.exhausted).filter(([, until]) => until > now)
    );

    writeJsonAtomic(this.filePath, { ...next, exhausted });
  }

  /** The snapshot's accounts and fetch time count only for the base URL they were fetched from. */
  private current(file: UsageFile): {
    providers: ProviderUsage[];
    fetchedAt?: number;
  } {
    return file.baseUrl === this.settings.connection()?.baseUrl
      ? { fetchedAt: file.fetchedAt, providers: file.providers }
      : { providers: [] };
  }

  managementStatus(): ManagementStatus | undefined {
    const managed = this.settings.managementKey();

    if (!managed || !("key" in managed)) {
      return undefined;
    }

    const { fetchedAt } = this.current(this.read());

    return fetchedAt === undefined
      ? { source: managed.source }
      : { source: managed.source, usageFetchedAt: fetchedAt };
  }

  /**
   * Hidden models from one usage file. A reset clears the server cooldown
   * but not its preserved quota observations, so an observation recorded
   * before the reset must not hide the model again; a local quota-error
   * mark (re)recorded after the reset still does.
   */
  private hiddenFrom(file: UsageFile, now: number): Map<string, number> {
    const resets = file.resets ?? {};

    // Discard each account's stale exhaustion on its own: one account
    // observed after the reset must not let another account's pre-reset
    // exhaustion hide a model the reset account can serve again. Local
    // quota-error marks in file.exhausted are merged separately and still hide.
    return unavailableModels(
      this.current(file).providers,
      file.exhausted,
      now,
      (account, model) => {
        const resetAt = resets[model];

        return (
          resetAt !== undefined &&
          (account.observedAt ?? file.fetchedAt ?? 0) <= resetAt
        );
      }
    );
  }

  hidden(now = Date.now()): Map<string, number> {
    return this.hiddenFrom(this.read(), now);
  }

  filter<T extends { id: string }>(models: readonly T[]): T[] {
    const hidden = this.hidden();

    return models.filter((model) => !hidden.has(model.id));
  }

  /**
   * True when the message was a quota error, which hides the model until its
   * reset. Like CLIProxyAPI, a quota error covers the whole account, so its
   * other models hide too. Claude is the exception: it also has per-model weekly
   * limits, and its account-wide windows come from the usage fetch instead.
   *
   * The mark is written at once, without a network call. When the message
   * names no reset time, as Claude's account rate limit does, the mark is a
   * guess: the reset of the account's full window in the snapshot on disk,
   * else 15 minutes. The next usage fetch replaces the guess with the reset
   * it reports, unless the mark changed in between, such as by a reset.
   */
  recordError(modelId: string, message: string): boolean {
    const now = Date.now();

    const guess =
      this.accountResets(this.read(), now).get(modelId) ??
      now + QUOTA_FALLBACK_MS;

    const until = quotaResetFromError(message, now, guess);

    if (until === undefined) {
      return false;
    }

    const marked: string[] = [];

    this.write((file) => {
      const siblings = this.current(file)
        .providers.filter(
          (account) =>
            hasAccountWideQuota(account.provider) &&
            account.models.includes(modelId)
        )
        .flatMap((account) => account.models);

      const exhausted = { ...file.exhausted };

      for (const id of [modelId, ...siblings]) {
        if ((exhausted[id] ?? 0) < until) {
          exhausted[id] = until;
          marked.push(id);
        }
      }

      return { ...file, exhausted };
    });

    if (until === guess) {
      for (const id of marked) {
        this.guessedMarks.set(id, { recordedAt: now, until });
      }
    }

    return true;
  }

  /**
   * Each model whose accounts are all full, with the time the first comes
   * back. Local quota marks don't count.
   */
  private accountResets(file: UsageFile, now: number): Map<string, number> {
    return this.hiddenFrom({ ...file, exhausted: {} }, now);
  }

  private clearMarks(
    ids: readonly string[] | undefined,
    extra: (file: UsageFile) => Partial<UsageFile> = () => ({})
  ): boolean {
    const marked = Object.keys(this.read().exhausted).some(
      (id) => ids === undefined || ids.includes(id)
    );

    this.write((file) => ({
      ...file,
      ...extra(file),
      exhausted:
        ids === undefined
          ? {}
          : Object.fromEntries(
              Object.entries(file.exhausted).filter(([id]) => !ids.includes(id))
            ),
    }));

    return marked;
  }

  async resetCooldowns(modelId?: string): Promise<string[]> {
    const affected = await resetServerCooldowns({
      ...this.settings.requireManagementAccess(),
      modelId,
    });

    // A server reset clears the whole credential, so its other models come
    // back too: recordError hid them locally alongside this one. The server
    // keeps its quota observations across a reset, so the reset time lets
    // hiddenFrom ignore the older ones.
    const resetAt = Date.now();
    const resetIds = modelId === undefined ? affected : [modelId, ...affected];

    this.clearMarks(modelId === undefined ? undefined : resetIds, (file) => ({
      resets: {
        ...file.resets,
        ...Object.fromEntries(resetIds.map((id) => [id, resetAt])),
      },
    }));

    return affected;
  }

  /** A reply proves the model works again. True when that cleared a quota mark. */
  recordSuccess(modelId: string): boolean {
    return (
      this.read().exhausted[modelId] !== undefined && this.clearMarks([modelId])
    );
  }

  async refresh(force = false, signal?: AbortSignal): Promise<void> {
    const access = this.settings.managementAccess();

    if (!access) {
      return;
    }

    const current = this.read();

    if (
      !force &&
      current.baseUrl === access.baseUrl &&
      current.fetchedAt !== undefined &&
      Date.now() - current.fetchedAt < USAGE_TTL_MS
    ) {
      return;
    }

    const startedAt = Date.now();

    const providers = await fetchUsage({
      ...access,
      signal,
    });

    this.write((file) => {
      const fetchedAt = Date.now();

      const next: UsageFile = {
        ...file,
        baseUrl: access.baseUrl,
        fetchedAt,
        providers,
      };

      const resets = this.accountResets(next, fetchedAt);
      const exhausted = { ...next.exhausted };

      // A fetch that started before a guess was made can't know its reset.
      for (const [id, guessed] of this.guessedMarks) {
        if (guessed.recordedAt > startedAt) {
          continue;
        }

        this.guessedMarks.delete(id);
        const reset = resets.get(id);

        // A mark that changed since the guess, or was cleared, is not ours to move.
        if (reset !== undefined && exhausted[id] === guessed.until) {
          exhausted[id] = reset;
        }
      }

      return { ...next, exhausted };
    });
  }

  nextChangeAt(now = Date.now()): number {
    const returns = [...this.hidden(now).values()];
    const fetchedAt = this.read().fetchedAt ?? now;

    const stale = this.settings.managementAccess()
      ? fetchedAt + USAGE_TTL_MS
      : Infinity;

    return Math.max(now + 1000, Math.min(stale, ...returns));
  }

  segments(
    catalogIds: readonly string[],
    currentModelId?: string,
    now = Date.now()
  ): UsageSegment[] {
    const file = this.read();
    const hidden = this.hiddenFrom(file, now);
    const catalog = new Set(catalogIds);
    const covered = new Set<string>();
    const segments: UsageSegment[] = [];

    for (const account of this.current(file).providers) {
      const models = account.models.filter((model) => catalog.has(model));

      if (models.length === 0) {
        continue;
      }

      for (const model of models) {
        covered.add(model);
      }

      const current =
        currentModelId !== undefined && models.includes(currentModelId);

      const returns = models.map((model) => hidden.get(model));

      if (returns.every((time) => time !== undefined)) {
        let until = Number.POSITIVE_INFINITY;

        for (const time of returns) {
          if (time !== undefined && time < until) {
            until = time;
          }
        }

        segments.push({ current, kind: "out", name: account.name, until });
        continue;
      }

      if (account.windows.length === 0) {
        segments.push({ current, kind: "unknown", name: account.name });
        continue;
      }

      segments.push({
        current,
        kind: "windows",
        name: account.name,
        windows: account.windows,
      });
    }

    for (const [model, until] of hidden) {
      if (catalog.has(model) && !covered.has(model)) {
        segments.push({ kind: "model-out", modelId: model, until });
      }
    }

    return segments;
  }
}

export interface RegisterUsageOptions {
  settings: Settings;
  tracker: UsageTracker;
  /** Recomputes pi's available list through filterModels without a network call. Throws on failure. */
  reapplyFilter: (ctx: ExtensionContext) => Promise<void>;
  getCatalogIds: () => readonly string[];
}

export interface UsageHandle {
  refresh: (ctx: ExtensionContext) => Promise<void>;
}

/**
 * Keeps pi's model list and the usage footer in step with the shared usage
 * file: quota errors hide a model, replies and resets bring it back.
 */
export const registerUsage = (
  pi: ExtensionAPI,
  options: RegisterUsageOptions
): UsageHandle => {
  const { tracker } = options;
  const { providerId } = options.settings;
  let active: ExtensionContext | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastHidden = "";
  let notifiedModel: string | undefined;
  let lastWarning: string | undefined;

  const warn = (ctx: ExtensionContext, message: string): void => {
    if (ctx.hasUI && message !== lastWarning) {
      lastWarning = message;
      ctx.ui.notify(message, "warning");
    }
  };

  const noticeCurrentModel = (
    ctx: ExtensionContext,
    hidden: ReadonlyMap<string, number>
  ): void => {
    const current = ctx.model;

    const until =
      current?.provider === providerId ? hidden.get(current.id) : undefined;

    if (until === undefined || !current) {
      notifiedModel = undefined;

      return;
    }

    if (notifiedModel !== current.id) {
      notifiedModel = current.id;
      warn(
        ctx,
        `${current.id} is out of quota until ${outUntil(until, Date.now())}. Pick another model with /model.`
      );
    }
  };

  const sync = async (ctx: ExtensionContext): Promise<void> => {
    const hidden = tracker.hidden();
    const key = [...hidden.keys()].toSorted().join(",");

    if (key !== lastHidden) {
      lastHidden = key;
      await options.reapplyFilter(ctx);
    }

    noticeCurrentModel(ctx, hidden);

    if (!ctx.hasUI) {
      return;
    }

    ctx.ui.setStatus(
      USAGE_STATUS_KEY,
      formatStatusLine(
        tracker.segments(
          options.getCatalogIds(),
          ctx.model?.provider === providerId ? ctx.model.id : undefined
        ),
        Date.now()
      )
    );
  };

  const syncNow = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await sync(ctx);
    } catch (error) {
      warn(ctx, `CLIProxyAPI model list: ${errorText(error)}`);
    }
  };

  const update = async (
    ctx: ExtensionContext,
    force: boolean
  ): Promise<void> => {
    try {
      await tracker.refresh(force);
    } catch (error) {
      warn(ctx, `CLIProxyAPI usage: ${errorText(error)}`);
    }

    await syncNow(ctx);

    if (!ctx.hasUI || !active) {
      return;
    }

    if (timer) {
      clearTimeout(timer);
    }

    const delay = tracker.nextChangeAt() - Date.now();

    if (!Number.isFinite(delay)) {
      return;
    }

    timer = setTimeout(
      () => {
        timer = undefined;

        if (active) {
          void update(active, false);
        }
      },
      // Node runs longer delays after 1 ms.
      Math.min(delay, MAX_TIMER_DELAY_MS)
    );
    timer.unref();
  };

  pi.on("message_end", async (event, ctx) => {
    const { message } = event;

    if (message.role !== "assistant" || message.provider !== providerId) {
      return;
    }

    const quotaError =
      message.stopReason === "error" &&
      tracker.recordError(message.model, message.errorMessage ?? "");

    const changed =
      quotaError ||
      (message.stopReason !== "error" &&
        message.stopReason !== "aborted" &&
        tracker.recordSuccess(message.model));

    if (!changed) {
      return;
    }

    // pi awaits this handler before it retries, so only the local change
    // waits. The usage fetch runs after it and names a guessed reset.
    await syncNow(ctx);
    void update(ctx, quotaError);
  });
  pi.on("session_start", async (_event, ctx) => {
    active = ctx;
    const managed = options.settings.managementKey();

    if (managed && "error" in managed) {
      warn(
        ctx,
        `CLIProxyAPI management key from cliproxyapi.json is unavailable: ${managed.error}. The usage footer, /cliproxyapi-login, and /cliproxyapi-reset need it.`
      );
    }

    await update(ctx, false);
  });
  pi.on("agent_end", async (_event, ctx) => {
    await update(ctx, false);
  });
  pi.on("model_select", (_event, ctx) => {
    noticeCurrentModel(ctx, tracker.hidden());
  });
  pi.on("session_shutdown", (_event, ctx) => {
    active = undefined;
    lastHidden = "";
    notifiedModel = undefined;

    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus(USAGE_STATUS_KEY, undefined);
    }
  });

  return { refresh: (ctx) => update(ctx, true) };
};
