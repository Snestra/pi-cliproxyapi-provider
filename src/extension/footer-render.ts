import path from "node:path";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { DAY_MS, HOUR_MS, MINUTE_MS } from "../core/time.ts";
import type { UsageWindow } from "../core/usage.ts";

export type UsageSegment =
  | {
      kind: "windows";
      name: string;
      current: boolean;
      windows: UsageWindow[];
    }
  | { kind: "out"; name: string; current: boolean; until: number }
  | { kind: "unknown"; name: string; current: boolean }
  | { kind: "model-out"; modelId: string; until: number };

/** The slice of pi's Theme the renderer needs. Pi's Theme satisfies this structurally. */
export interface Paint {
  fg: (color: string, text: string) => string;
}

const FULL = "█";
const TRACK = "░";
const PARTIALS = "▏▎▍▌▋▊▉";
const EIGHTHS = 8;
const SAME_DAY_MS = 20 * 60 * 60_000;

const LEFT_INDICATORS = { error: "🔴", warning: "🟡" } as const;

const quotaLeft = (usedPercent: number): number =>
  Math.round(100 - Math.min(100, Math.max(0, usedPercent)));

export const severity = (left: number): "error" | "warning" | undefined => {
  if (left <= 10) {
    return "error";
  }

  return left <= 25 ? "warning" : undefined;
};

export const bar = (
  percent: number,
  cells: number,
  paint: Paint,
  tone?: "error" | "warning"
): string => {
  const clamped = Math.min(100, Math.max(0, percent));
  const eighths = Math.round((clamped / 100) * cells * EIGHTHS);
  const full = Math.floor(eighths / EIGHTHS);
  const partial = eighths % EIGHTHS;

  const fill =
    FULL.repeat(full) + (partial > 0 ? (PARTIALS[partial - 1] ?? "") : "");

  const track = TRACK.repeat(Math.max(0, cells - full - (partial > 0 ? 1 : 0)));
  const paintedFill = fill ? paint.fg(tone ?? "syntaxKeyword", fill) : "";
  const paintedTrack = track ? paint.fg("dim", track) : "";

  return paintedFill + paintedTrack;
};

export const countdown = (resetAt: number, now: number): string => {
  if (resetAt <= now) {
    return "";
  }

  const diff = resetAt - now;

  if (diff < HOUR_MS) {
    return `↺${Math.max(1, Math.floor(diff / MINUTE_MS))}m`;
  }

  if (diff < DAY_MS) {
    return `↺${Math.floor(diff / HOUR_MS)}h`;
  }

  return `↺${Math.floor(diff / DAY_MS)}d`;
};

export const outUntil = (until: number, now: number): string => {
  const options: Intl.DateTimeFormatOptions =
    until - now < SAME_DAY_MS
      ? { hour: "2-digit", hourCycle: "h23", minute: "2-digit" }
      : {
          hour: "2-digit",
          hourCycle: "h23",
          minute: "2-digit",
          weekday: "short",
        };

  return new Intl.DateTimeFormat(undefined, options).format(until);
};

const percentText = (left: number, paint: Paint): string => {
  const text = `${left}%`.padStart(4);
  const color = severity(left);

  return color ? paint.fg(color, text) : text;
};

interface SegmentOptions {
  cells: number;
  countdowns: boolean;
}

const renderSegment = (
  segment: UsageSegment,
  paint: Paint,
  now: number,
  options: SegmentOptions
): string => {
  if (segment.kind === "model-out") {
    return paint.fg(
      "error",
      `${segment.modelId} ⏸ ${outUntil(segment.until, now)}`
    );
  }

  const marker = segment.current ? paint.fg("accent", "▸") : "";

  // The marker's own color reset would clear the segment's color, so it stays outside the painted text.
  if (segment.kind === "out") {
    return (
      marker +
      paint.fg("error", `${segment.name} ⏸ ${outUntil(segment.until, now)}`)
    );
  }

  if (segment.kind === "unknown") {
    return marker + paint.fg("dim", `${segment.name} n/a`);
  }

  const windows = segment.windows.map((window) => {
    const left = quotaLeft(window.usedPercent);

    const reset =
      options.countdowns && window.resetAt !== undefined
        ? countdown(window.resetAt, now)
        : "";

    const resetText = reset ? ` ${paint.fg("dim", reset)}` : "";

    return `${paint.fg("dim", window.label)} ${bar(left, options.cells, paint, severity(left))} ${percentText(left, paint)}${resetText}`;
  });

  return `${marker}${segment.name} ${windows.join(" ")}`;
};

const renderPlainSegment = (segment: UsageSegment, now: number): string => {
  if (segment.kind === "model-out") {
    return `⏸ ${segment.modelId} 0% until ${outUntil(segment.until, now)}`;
  }

  if (segment.kind === "out") {
    return `⏸ ${segment.name} 0% until ${outUntil(segment.until, now)}`;
  }

  if (segment.kind === "unknown") {
    return `⚪ ${segment.name} n/a`;
  }

  const left = Math.min(
    ...segment.windows.map((window) => quotaLeft(window.usedPercent))
  );

  const color = severity(left);
  const indicator = color ? LEFT_INDICATORS[color] : "🟢";

  return `${indicator} ${segment.name} ${left}%`;
};

/** Plain text also survives status clients that strip ANSI colors and collapse spaces. */
export const formatStatusLine = (
  segments: readonly UsageSegment[],
  now: number
): string | undefined => {
  if (segments.length === 0) {
    return undefined;
  }

  return `Left: ${segments.map((segment) => renderPlainSegment(segment, now)).join(" · ")}`;
};

const isImportant = (segment: UsageSegment): boolean => {
  if (segment.kind === "out" || segment.kind === "model-out") {
    return true;
  }

  if (segment.kind === "windows") {
    return (
      segment.current ||
      segment.windows.some(
        (window) => severity(quotaLeft(window.usedPercent)) !== undefined
      )
    );
  }

  return segment.current;
};

const wrapSegments = (
  parts: readonly string[],
  paint: Paint,
  width: number,
  maxRows = 2
): string[] | undefined => {
  const separator = paint.fg("dim", " │ ");
  const separatorWidth = visibleWidth(separator);
  const rows: string[] = [];
  let row = "";
  let rowWidth = 0;

  for (const part of parts) {
    const partWidth = visibleWidth(part);

    if (partWidth > width) {
      const truncated = truncateToWidth(part, width, paint.fg("dim", "..."));
      rows.push(truncated);
      row = "";
      rowWidth = 0;
      continue;
    }

    if (!row) {
      row = part;
      rowWidth = partWidth;
    } else if (rowWidth + separatorWidth + partWidth > width) {
      rows.push(row);
      row = part;
      rowWidth = partWidth;
    } else {
      row += separator + part;
      rowWidth += separatorWidth + partWidth;
    }
  }

  if (row) {
    rows.push(row);
  }

  return rows.length <= maxRows ? rows : undefined;
};

const joinRow = (parts: readonly string[], paint: Paint): string =>
  parts.join(paint.fg("dim", " │ "));

const fitsOneRow = (
  parts: readonly string[],
  paint: Paint,
  width: number
): boolean => visibleWidth(joinRow(parts, paint)) <= width;

/**
 * Account rows for the owned footer. The ladder drops countdowns, then bar
 * cells, then quiet accounts, before it wraps or truncates. A variant wins
 * when its segments fit on one row, because the acceptance probe at 60
 * columns drops countdowns rather than wrapping the full form. When no
 * variant fits one row, the quietest variant wraps over two rows, then
 * truncates.
 */
export const formatAccountRows = (
  segments: readonly UsageSegment[],
  paint: Paint,
  width: number,
  now: number,
  elapsed?: string
): string[] => {
  if (segments.length === 0) {
    return elapsed ? [elapsed] : [];
  }

  const withLabel = (parts: string[]): string[] =>
    parts.map((part, index) =>
      index === 0 ? `${paint.fg("dim", "left")} ${part}` : part
    );

  const renderAll = (options: SegmentOptions): string[] =>
    withLabel([
      ...segments.map((segment) => renderSegment(segment, paint, now, options)),
      ...(elapsed ? [elapsed] : []),
    ]);

  const full = renderAll({ cells: 5, countdowns: true });

  if (fitsOneRow(full, paint, width)) {
    return [joinRow(full, paint)];
  }

  const noCountdowns = renderAll({ cells: 5, countdowns: false });

  if (fitsOneRow(noCountdowns, paint, width)) {
    return [joinRow(noCountdowns, paint)];
  }

  const smallBars = renderAll({ cells: 3, countdowns: false });

  if (fitsOneRow(smallBars, paint, width)) {
    return [joinRow(smallBars, paint)];
  }

  const renderFolded = (keep: (segment: UsageSegment) => boolean): string[] => {
    const kept: string[] = [];
    let folded = 0;

    for (const segment of segments) {
      if (keep(segment)) {
        kept.push(
          renderSegment(segment, paint, now, { cells: 3, countdowns: false })
        );
      } else {
        folded += 1;
      }
    }

    if (elapsed) {
      kept.push(elapsed);
    }

    if (folded > 0) {
      kept.push(paint.fg("dim", `+${folded} more`));
    }

    return withLabel(kept);
  };

  const noUnknown = renderFolded(
    (segment) => segment.kind !== "unknown" || segment.current
  );

  if (fitsOneRow(noUnknown, paint, width)) {
    return [joinRow(noUnknown, paint)];
  }

  const importantOnly = renderFolded(isImportant);

  if (fitsOneRow(importantOnly, paint, width)) {
    return [joinRow(importantOnly, paint)];
  }

  const wrapped = wrapSegments(importantOnly, paint, width);

  if (wrapped) {
    return wrapped;
  }

  const rows = wrapSegments(
    importantOnly,
    paint,
    width,
    importantOnly.length
  ) ?? [joinRow(importantOnly, paint)];

  return rows.map((row) => truncateToWidth(row, width, paint.fg("dim", "...")));
};

export interface StatPart {
  droppable?: "CH" | "W" | "R" | "cost";
  text: string;
}

/** Row 1 of the owned footer. Stats drop, then the cwd shrinks, then the model part, the way pi's footer gives way. */
export const formatRow1 = (
  cwdPart: string,
  statParts: StatPart[],
  contextPart: string,
  right: string,
  rightWithoutProvider: string,
  paint: Paint,
  width: number,
  shrinkRight: (text: string, available: number) => string
): string => {
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
      available > 0 ? shrinkRight(rightWithoutProvider, available) : "";
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
};

/** Pi's token thresholds: 999, 1.0k under 10k, 999k, 1.0M under 10M, then whole millions. */
export const formatTokens = (count: number): string => {
  if (count < 1000) {
    return count.toString();
  }

  if (count < 10_000) {
    return `${(count / 1000).toFixed(1)}k`;
  }

  if (count < 1_000_000) {
    return `${Math.round(count / 1000)}k`;
  }

  if (count < 10_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`;
  }

  return `${Math.round(count / 1_000_000)}M`;
};

/** Pi's cwd folding: `~` at home, `~/sub` inside home, the plain path outside it. */
export const formatCwd = (cwd: string, home: string | undefined): string => {
  if (!home) {
    return cwd;
  }

  const relativeToHome = path.relative(path.resolve(home), path.resolve(cwd));

  const isInsideHome =
    relativeToHome === "" ||
    (relativeToHome !== ".." &&
      !relativeToHome.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relativeToHome));

  if (!isInsideHome) {
    return cwd;
  }

  return relativeToHome === "" ? "~" : `~${path.sep}${relativeToHome}`;
};

export const contextSegment = (
  percent: number | null,
  contextWindow: number,
  auto: boolean,
  paint: Paint
): string => {
  const pct = percent === null ? "?" : percent.toFixed(1);
  const suffix = auto ? " (auto)" : "";

  const display =
    percent === null
      ? `?/${formatTokens(contextWindow)}${suffix}`
      : `${pct}%/${formatTokens(contextWindow)}${suffix}`;

  let colored = display;

  if (percent !== null && percent > 90) {
    colored = paint.fg("error", display);
  } else if (percent !== null && percent > 70) {
    colored = paint.fg("warning", display);
  }

  const used = percent ?? 0;
  let tone: "error" | "warning" | undefined;

  if (used >= 90) {
    tone = "error";
  } else if (used >= 75) {
    tone = "warning";
  }

  return `${paint.fg("dim", "ctx")} ${bar(used, 10, paint, tone)} ${colored}`;
};
