import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { Value } from "typebox/value";

import type { Settings } from "./config.ts";
import type { FastModeController } from "./fast.ts";
import type { Paint, StatPart, UsageSegment } from "./footer-render.ts";
import {
  contextSegment,
  formatAccountRows,
  formatCwd,
  formatRow1,
  formatTokens,
} from "./footer-render.ts";
import type { PauseController } from "./pause.ts";
import { ELAPSED_STATUS_KEY, USAGE_STATUS_KEY } from "./status-keys.ts";

const PATCH = Symbol.for("cliproxyapi-provider/fast-footer");

/** Clearing a status makes pi render the stock footer again. */
const RERENDER_KEY = "cliproxyapi-fast-refresh";
const ORANGE_TRUECOLOR = "\u001B[38;2;255;165;0m";
const ORANGE_256 = "\u001B[38;5;214m";
const FG_RESET = "\u001B[39m";

/** The part of pi's private footer session this patch reads. Checked on every render, because pi may change it. */
const FooterSessionSchema = Type.Object({
  state: Type.Object({
    model: Type.Optional(
      Type.Object({
        id: Type.String(),
        provider: Type.String(),
        reasoning: Type.Boolean(),
      })
    ),
    thinkingLevel: Type.Optional(Type.String()),
  }),
});

interface ModelRef {
  id: string;
  provider: string;
}

interface PatchState {
  controllers: Set<FooterController>;
  original: FooterComponent["render"];
  patched: FooterComponent["render"];
}

type PatchableFooter = FooterComponent & { [PATCH]?: PatchState };

const thinkingText = (reasoning: boolean, level: string): string => {
  if (!reasoning) {
    return "";
  }

  return level === "off" ? " • thinking off" : ` • ${level}`;
};

const fastWord = (theme: Theme | undefined): string =>
  theme?.fg("warning", "fast") ?? "fast";

/** pi's themes have no orange, so paused uses its own color. */
const pausedWord = (theme: Theme | undefined): string => {
  if (!theme) {
    return "paused";
  }

  const color =
    theme.getColorMode() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;

  return `${color}paused${FG_RESET}`;
};

const install = (controller: FooterController): void => {
  // SAFETY: FooterComponent is the runtime class whose prototype carries this extension's symbol-owned patch metadata.
  const prototype = FooterComponent.prototype as PatchableFooter;
  let state = prototype[PATCH];

  if (!state) {
    const original = prototype.render;
    state = {
      controllers: new Set(),
      original,
      patched(this: FooterComponent, width: number): string[] {
        const session: unknown = this["session"];

        if (!Value.Check(FooterSessionSchema, session)) {
          return original.call(this, width);
        }

        const { model } = session.state;

        const active = model
          ? [...(state?.controllers ?? [])].find((candidate) =>
              candidate.isProviderModel(model)
            )
          : undefined;

        if (!model || !active) {
          return original.call(this, width);
        }

        const { id } = model;
        const { reasoning } = model;
        const fast = active.isEffectiveFor(model);

        if (fast || active.isPaused()) {
          model.id = active.formatModelStatus(
            id,
            reasoning,
            session.state.thinkingLevel ?? "off",
            fast
          );
          model.reasoning = false;
        }

        try {
          return original.call(this, width);
        } finally {
          model.id = id;
          model.reasoning = reasoning;
        }
      },
    };
    prototype[PATCH] = state;
    prototype.render = state.patched;
  }

  state.controllers.add(controller);
};

const uninstall = (controller: FooterController): void => {
  // SAFETY: This is the same symbol-owned footer prototype augmented by install().
  const prototype = FooterComponent.prototype as PatchableFooter;
  const state = prototype[PATCH];
  state?.controllers.delete(controller);

  if (!state || state.controllers.size > 0) {
    return;
  }

  if (prototype.render === state.patched) {
    prototype.render = state.original;
  }

  Reflect.deleteProperty(prototype, PATCH);
};

export interface FooterControllerOptions {
  settings: Settings;
  getSegments: (ctx: ExtensionContext) => UsageSegment[];
}

interface UsageTotals {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  input: number;
  output: number;
}

interface StatsCache {
  contextUsage: ReturnType<ExtensionContext["getContextUsage"]>;
  entryCount: number;
  latestCacheHitRate?: number;
  leafId: string | null;
  model: ExtensionContext["model"];
  sessionId: string;
  totals: UsageTotals;
}

/** Adapts pi's Theme to the renderer's Paint. Pi only accepts its ThemeColor union, never a plain string. */
const themePaint = (theme: Theme): Paint => ({
  // SAFETY: Paint color strings come only from this extension's fixed color names, each a valid ThemeColor.
  fg: (color, text) => theme.fg(color as ThemeColor, text),
});

const sanitizeStatusText = (text: string): string =>
  text
    .replaceAll(/[\r\n\t]/gu, " ")
    .replaceAll(/ +/gu, " ")
    .trim();

export class FooterController {
  private activeContext: ExtensionContext | undefined;
  private installed = false;
  private owned = false;
  private tuiHandle: { requestRender: () => void } | undefined;
  private statsCache: StatsCache | undefined;
  private readonly providerId: string;
  private readonly fast: FastModeController;
  private readonly pause: PauseController;
  private readonly options: FooterControllerOptions;

  constructor(
    providerId: string,
    fast: FastModeController,
    pause: PauseController,
    options: FooterControllerOptions
  ) {
    this.providerId = providerId;
    this.fast = fast;
    this.pause = pause;
    this.options = options;
  }

  register(pi: ExtensionAPI): void {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.mode !== "tui") {
        return;
      }

      this.activeContext = ctx;

      // Read on each session_start, so a config edit applies to the next session.
      if (this.options.settings.config().footer ?? true) {
        this.owned = true;
        ctx.ui.setFooter((tui, theme, footerData) => {
          this.tuiHandle = tui;

          const unsubscribe = footerData.onBranchChange(() =>
            tui.requestRender()
          );

          return {
            dispose: () => {
              unsubscribe();

              if (this.tuiHandle === tui) {
                this.tuiHandle = undefined;
              }
            },
            invalidate: () => tui.requestRender(),
            render: (width: number): string[] =>
              this.renderOwned(ctx, themePaint(theme), footerData, width),
          };
        });

        return;
      }

      if (!this.installed) {
        install(this);
        this.installed = true;
      }
    });
    pi.on("session_shutdown", (_event, ctx) => {
      this.activeContext = undefined;
      this.tuiHandle = undefined;
      this.statsCache = undefined;

      if (this.owned) {
        this.owned = false;

        if (ctx.mode === "tui") {
          ctx.ui.setFooter(undefined);
        }
      }

      if (this.installed) {
        uninstall(this);
        this.installed = false;
      }
    });
  }

  isProviderModel(model: ModelRef): boolean {
    return model.provider === this.providerId;
  }

  isEffectiveFor(model: ModelRef): boolean {
    return this.isProviderModel(model) && this.fast.isEffectiveFor(model.id);
  }

  isPaused(): boolean {
    return this.pause.isEnabled();
  }

  formatModelStatus(
    modelName: string,
    reasoning: boolean,
    thinkingLevel: string,
    fast: boolean
  ): string {
    return [
      modelName + thinkingText(reasoning, thinkingLevel),
      ...this.modeWords(fast, this.activeContext?.ui.theme),
    ].join(" • ");
  }

  /** The words that say what the next request does differently. Both footers show them. */
  private modeWords(fast: boolean, theme: Theme | undefined): string[] {
    return [
      ...(fast ? [fastWord(theme)] : []),
      ...(this.isPaused() ? [pausedWord(theme)] : []),
    ];
  }

  refresh(ctx: ExtensionContext): void {
    if (ctx.mode !== "tui") {
      return;
    }

    this.activeContext = ctx;

    if (this.owned && this.tuiHandle) {
      this.tuiHandle.requestRender();

      return;
    }

    ctx.ui.setStatus(RERENDER_KEY, undefined);
  }

  private scanStats(ctx: ExtensionContext): StatsCache {
    const entries = ctx.sessionManager.getEntries();
    const sessionId = ctx.sessionManager.getSessionId();
    const leafId = ctx.sessionManager.getLeafId();
    const cached = this.statsCache;

    if (
      cached &&
      cached.sessionId === sessionId &&
      cached.leafId === leafId &&
      cached.entryCount === entries.length &&
      cached.model === ctx.model
    ) {
      return cached;
    }

    const totals: UsageTotals = {
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      input: 0,
      output: 0,
    };

    let latestCacheHitRate: number | undefined;

    const add = (usage: {
      cacheRead: number;
      cacheWrite: number;
      cost: { total: number };
      input: number;
      output: number;
    }): void => {
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      totals.cost += usage.cost.total;
    };

    for (const entry of entries) {
      if (entry.type === "usage") {
        add(entry.usage);
      } else if (
        entry.type === "message" &&
        entry.message.role === "assistant"
      ) {
        add(entry.message.usage);

        const prompt =
          entry.message.usage.input +
          entry.message.usage.cacheRead +
          entry.message.usage.cacheWrite;

        latestCacheHitRate =
          prompt > 0
            ? (entry.message.usage.cacheRead / prompt) * 100
            : undefined;
      } else if (
        entry.type === "message" &&
        entry.message.role === "toolResult" &&
        entry.message.usage
      ) {
        add(entry.message.usage);
      } else if (
        (entry.type === "branch_summary" || entry.type === "compaction") &&
        entry.usage
      ) {
        add(entry.usage);
      }
    }

    const next: StatsCache = {
      contextUsage: ctx.getContextUsage(),
      entryCount: entries.length,
      leafId,
      model: ctx.model,
      sessionId,
      totals,
    };

    if (latestCacheHitRate !== undefined) {
      next.latestCacheHitRate = latestCacheHitRate;
    }

    this.statsCache = next;

    return next;
  }

  private static statParts(
    totals: UsageTotals,
    latestCacheHitRate: number | undefined,
    kimi: boolean,
    paint: Paint
  ): StatPart[] {
    const parts: StatPart[] = [];

    if (totals.input) {
      parts.push({ text: paint.fg("dim", `↑${formatTokens(totals.input)}`) });
    }

    if (totals.output) {
      parts.push({ text: paint.fg("dim", `↓${formatTokens(totals.output)}`) });
    }

    if (totals.cacheRead) {
      parts.push({
        droppable: "R",
        text: paint.fg("dim", `R${formatTokens(totals.cacheRead)}`),
      });
    }

    if (totals.cacheWrite) {
      parts.push({
        droppable: "W",
        text: paint.fg("dim", `W${formatTokens(totals.cacheWrite)}`),
      });
    }

    if (
      (totals.cacheRead > 0 || totals.cacheWrite > 0) &&
      latestCacheHitRate !== undefined
    ) {
      parts.push({
        droppable: "CH",
        text: paint.fg("dim", `CH${latestCacheHitRate.toFixed(1)}%`),
      });
    }

    if (totals.cost || kimi) {
      parts.push({
        droppable: "cost",
        text: paint.fg(
          "dim",
          `$${totals.cost.toFixed(3)}${kimi ? " (sub)" : ""}`
        ),
      });
    }

    return parts;
  }

  private renderOwned(
    ctx: ExtensionContext,
    paint: Paint,
    footerData: ReadonlyFooterDataProvider,
    width: number
  ): string[] {
    const stats = this.scanStats(ctx);
    const { totals } = stats;
    const { model } = ctx;

    // Pi also marks subscription use and routed models here. Only the
    // kimi-coding case below has a public extension API, so the routed
    // "→ model" suffix and the experimental marker stay out.
    const statParts = FooterController.statParts(
      totals,
      stats.latestCacheHitRate,
      model?.provider === "kimi-coding",
      paint
    );

    const { contextUsage } = stats;

    const contextPart = contextSegment(
      contextUsage?.percent ?? null,
      contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
      this.options.settings.autoCompact(),
      paint
    );

    const branch = footerData.getGitBranch();
    const sessionName = ctx.sessionManager.getSessionName();

    const cwdPart =
      paint.fg(
        "dim",
        formatCwd(ctx.sessionManager.getCwd(), this.options.settings.home())
      ) +
      (branch ? paint.fg("accent", ` (${branch})`) : "") +
      (sessionName ? paint.fg("dim", ` • ${sessionName}`) : "");

    const row1 = formatRow1(
      cwdPart,
      statParts,
      contextPart,
      this.modelPart(ctx, paint, footerData),
      this.modelPart(ctx, paint, footerData, false),
      paint,
      width,
      (text, available) =>
        this.modelPart(ctx, paint, footerData, false, available)
    );

    const statuses = footerData.getExtensionStatuses();
    const elapsed = statuses.get(ELAPSED_STATUS_KEY);
    const rows = [row1];

    rows.push(
      ...formatAccountRows(
        this.options.getSegments(ctx),
        paint,
        width,
        Date.now(),
        elapsed
      )
    );

    const others = [...statuses.entries()]
      .filter(([key]) => key !== USAGE_STATUS_KEY && key !== ELAPSED_STATUS_KEY)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .flatMap(([, text]) => {
        const sanitized = sanitizeStatusText(text);

        return sanitized ? [sanitized] : [];
      });

    if (others.length > 0) {
      rows.push(
        truncateToWidth(others.join(" "), width, paint.fg("dim", "..."))
      );
    }

    return rows;
  }

  private modelPart(
    ctx: ExtensionContext,
    paint: Paint,
    footerData: ReadonlyFooterDataProvider,
    includeProvider = true,
    maxBaseWidth?: number
  ): string {
    const { theme } = ctx.ui;
    const { model } = ctx;

    let base =
      (model?.id || "no-model") +
      thinkingText(model?.reasoning ?? false, ctx.thinkingLevel ?? "off");

    // Keep fast and paused when the model name must shrink; they change what the next request does.
    if (maxBaseWidth !== undefined) {
      base = truncateToWidth(base, maxBaseWidth, "");
    }

    let right =
      includeProvider && footerData.getAvailableProviderCount() > 1 && model
        ? paint.fg("dim", `(${model.provider}) `)
        : "";

    right += paint.fg("dim", base);

    const fast = model !== undefined && this.isEffectiveFor(model);

    for (const word of this.modeWords(fast, theme)) {
      right += paint.fg("dim", " • ") + word;
    }

    return right;
  }
}
