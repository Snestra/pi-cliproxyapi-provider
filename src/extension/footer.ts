import { FooterComponent } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ReadonlyFooterDataProvider,
  Theme,
  ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { loadAutoCompactEnabled } from "./config.ts";
import type { FastModeController } from "./fast.ts";
import type { Paint, UsageSegment } from "./footer-render.ts";
import {
  contextSegment,
  formatAccountRows,
  formatCwd,
  formatTokens,
} from "./footer-render.ts";
import type { PauseController } from "./pause.ts";

const PATCH = Symbol.for("cliproxyapi-provider/fast-footer");
const REFRESH_KEY = "cliproxyapi-fast-refresh";
const ORANGE_TRUECOLOR = "\u001B[38;2;255;165;0m";
const ORANGE_256 = "\u001B[38;5;214m";
const FG_RESET = "\u001B[39m";
const USAGE_KEY = "cliproxyapi-usage";
const TPS_KEY = "tps";

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

type MutableModel = NonNullable<
  Static<typeof FooterSessionSchema>["state"]["model"]
>;

interface PatchState {
  controllers: Set<FooterController>;
  original: FooterComponent["render"];
  patched: FooterComponent["render"];
}

type PatchableFooter = FooterComponent & { [PATCH]?: PatchState };

export const formatFastModelStatus = (
  modelName: string,
  reasoning: boolean,
  thinkingLevel: string,
  fast: boolean,
  fastLabel = "fast",
  paused = false,
  pausedLabel = "paused"
): string => {
  let status = modelName;

  if (reasoning) {
    status +=
      thinkingLevel === "off" ? " • thinking off" : ` • ${thinkingLevel}`;
  }

  if (fast) {
    status += ` • ${fastLabel}`;
  }

  if (paused) {
    status += ` • ${pausedLabel}`;
  }

  return status;
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
  /** Read fresh on each session_start, so a config edit applies to the next session. */
  enabled: () => boolean;
  agentDir: string;
  getSegments: (ctx: ExtensionContext) => UsageSegment[];
  /** Defaults to reading settings.json in agentDir. */
  autoCompact?: () => boolean;
}

interface UsageTotals {
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  input: number;
  output: number;
}

interface StatsCache {
  entryCount: number;
  latestCacheHitRate?: number;
  leafId: string | null;
  model: ExtensionContext["model"];
  sessionId: string;
  totals: UsageTotals;
}

interface StatPart {
  droppable?: "CH" | "W" | "R" | "cost";
  text: string;
}

/** Adapts pi's Theme to the renderer's Paint. Pi only accepts its ThemeColor union, never a plain string. */
export const themePaint = (theme: Theme): Paint => ({
  bold: (text) => theme.bold(text),
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

      if (this.options.enabled()) {
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

  isProviderModel(model: MutableModel): boolean {
    return model.provider === this.providerId;
  }

  isEffectiveFor(model: MutableModel): boolean {
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
    const theme = this.activeContext?.ui.theme;

    const color =
      theme?.getColorMode?.() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;

    const pausedLabel = theme ? `${color}paused${FG_RESET}` : "paused";

    return formatFastModelStatus(
      modelName,
      reasoning,
      thinkingLevel,
      fast,
      theme?.fg("warning", "fast") ?? "fast",
      this.pause.isEnabled(),
      pausedLabel
    );
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

    ctx.ui.setStatus(REFRESH_KEY, undefined);
  }

  private autoCompact(): boolean {
    return this.options.autoCompact
      ? this.options.autoCompact()
      : loadAutoCompactEnabled(this.options.agentDir);
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

  /** Exported for the narrow-width row 1 test. */
  static assembleRow1(
    cwdPart: string,
    statParts: StatPart[],
    contextPart: string,
    right: string,
    rightWithoutProvider: string,
    paint: Paint,
    width: number
  ): string {
    return FooterController.assembleRow1Parts(
      cwdPart,
      statParts,
      contextPart,
      right,
      rightWithoutProvider,
      paint,
      width
    );
  }

  private static assembleRow1Parts(
    cwdPart: string,
    statParts: StatPart[],
    contextPart: string,
    right: string,
    rightWithoutProvider: string,
    paint: Paint,
    width: number
  ): string {
    let cwd = cwdPart;

    const buildLeft = (): string =>
      [cwd, ...statParts.map((part) => part.text), contextPart].join(" ");

    let left = buildLeft();

    const fits = (): boolean =>
      visibleWidth(left) + 2 + visibleWidth(right) <= width;

    if (!fits()) {
      for (const key of ["CH", "W", "R", "cost"] as const) {
        const index = statParts.findIndex((part) => part.droppable === key);

        if (index !== -1) {
          statParts.splice(index, 1);
          left = buildLeft();
        }

        if (fits()) {
          break;
        }
      }
    }

    if (!fits()) {
      const excess = visibleWidth(left) + 2 + visibleWidth(right) - width;
      cwd = truncateToWidth(
        cwd,
        Math.max(0, visibleWidth(cwd) - excess),
        paint.fg("dim", "...")
      );
      left = buildLeft();
    }

    // Pi drops the provider prefix before it truncates the model name.
    let rightPart = right;

    if (!fits()) {
      rightPart = rightWithoutProvider;
    }

    const fitsWithoutProvider = (): boolean =>
      visibleWidth(left) + 2 + visibleWidth(rightPart) <= width;

    if (!fitsWithoutProvider()) {
      const available = width - visibleWidth(left) - 2;
      rightPart =
        available > 0
          ? truncateToWidth(rightWithoutProvider, available, "")
          : "";
    }

    const leftWidth = visibleWidth(left);
    const rightWidth = visibleWidth(rightPart);
    let padding = "";

    if (rightPart && leftWidth + rightWidth < width) {
      padding = " ".repeat(width - leftWidth - rightWidth);
    } else if (rightPart) {
      padding = "  ";
    }

    return truncateToWidth(
      left + padding + rightPart,
      width,
      paint.fg("dim", "...")
    );
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

    const contextUsage = ctx.getContextUsage();

    const contextPart = contextSegment(
      contextUsage?.percent ?? null,
      contextUsage?.contextWindow ?? model?.contextWindow ?? 0,
      this.autoCompact(),
      paint
    );

    const branch = footerData.getGitBranch();
    const sessionName = ctx.sessionManager.getSessionName();

    const cwdPart =
      paint.fg(
        "dim",
        formatCwd(
          ctx.sessionManager.getCwd(),
          process.env.HOME || process.env.USERPROFILE
        )
      ) +
      (branch ? paint.fg("accent", ` (${branch})`) : "") +
      (sessionName ? paint.fg("dim", ` • ${sessionName}`) : "");

    const row1 = FooterController.assembleRow1(
      cwdPart,
      statParts,
      contextPart,
      this.modelPart(ctx, paint, footerData),
      this.modelPart(ctx, paint, footerData, false),
      paint,
      width
    );

    const statuses = footerData.getExtensionStatuses();
    const elapsed = statuses.get(TPS_KEY);
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
      .filter(
        ([key]) => key !== USAGE_KEY && key !== REFRESH_KEY && key !== TPS_KEY
      )
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
    includeProvider = true
  ): string {
    const { theme } = ctx.ui;
    const { model } = ctx;
    const modelName = model?.id || "no-model";
    let base = modelName;

    if (model?.reasoning) {
      const level = ctx.thinkingLevel ?? "off";
      base += level === "off" ? " • thinking off" : ` • ${level}`;
    }

    let right =
      includeProvider && footerData.getAvailableProviderCount() > 1 && model
        ? paint.fg("dim", `(${model.provider}) `)
        : "";

    right += paint.fg("dim", base);

    if (
      model &&
      this.isEffectiveFor({
        id: model.id,
        provider: model.provider,
        reasoning: model.reasoning,
      })
    ) {
      right += paint.fg("dim", " • ") + theme.fg("warning", "fast");
    }

    if (this.isPaused()) {
      const color =
        theme.getColorMode() === "truecolor" ? ORANGE_TRUECOLOR : ORANGE_256;

      right += `${paint.fg("dim", " • ")}${color}paused${FG_RESET}`;
    }

    return right;
  }
}
