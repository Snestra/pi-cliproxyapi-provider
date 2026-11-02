import path from "node:path";

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One account or model as the footer shows it. The tracker builds these, the renderer paints them. */
export type UsageSegment =
  | {
      kind: "windows";
      name: string;
      current: boolean;
      windows: { label: string; usedPercent: number; resetAt?: number }[];
    }
  | { kind: "out"; name: string; current: boolean; until: number }
  | { kind: "unknown"; name: string; current: boolean }
  | { kind: "model-out"; modelId: string; until: number };

/** The slice of pi's Theme the renderer needs. Pi's Theme satisfies this structurally. */
export interface Paint {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

const FULL = "█";
const TRACK = "░";
const PARTIALS = "▏▎▍▌▋▊▉";
const EIGHTHS = 8;
const SAME_DAY_MS = 20 * 60 * 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const severity = (percent: number): "error" | "warning" | undefined => {
  if (percent >= 90) {
    return "error";
  }

  return percent >= 75 ? "warning" : undefined;
};

/** A bar of `cells` blocks, filled by rounded eighths, with a dim track. */
export const bar = (percent: number, cells: number, paint: Paint): string => {
  const clamped = Math.min(100, Math.max(0, percent));
  const eighths = Math.round((clamped / 100) * cells * EIGHTHS);
  const full = Math.floor(eighths / EIGHTHS);
  const partial = eighths % EIGHTHS;

  const fill =
    FULL.repeat(full) + (partial > 0 ? (PARTIALS[partial - 1] ?? "") : "");

  const track = TRACK.repeat(Math.max(0, cells - full - (partial > 0 ? 1 : 0)));
  const color = severity(clamped) ?? "syntaxKeyword";
  const paintedFill = fill ? paint.fg(color, fill) : "";
  const paintedTrack = track ? paint.fg("dim", track) : "";

  return paintedFill + paintedTrack;
};

/** The coarsest single unit until a reset. Empty when the reset has passed, so callers skip it. */
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

/** A clock time, with the weekday once the time is at least 20 hours away. */
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

const percentText = (usedPercent: number, paint: Paint): string => {
  const text = `${Math.round(usedPercent)}%`.padStart(4);
  const color = severity(usedPercent);

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
    const reset =
      options.countdowns && window.resetAt !== undefined
        ? countdown(window.resetAt, now)
        : "";

    const resetText = reset ? ` ${paint.fg("dim", reset)}` : "";

    return `${paint.fg("dim", window.label)} ${bar(window.usedPercent, options.cells, paint)} ${percentText(window.usedPercent, paint)}${resetText}`;
  });

  return `${marker}${segment.name} ${windows.join(" ")}`;
};

const renderPlainSegment = (
  segment: UsageSegment,
  paint: Paint,
  now: number
): string => {
  if (segment.kind === "model-out") {
    return paint.fg(
      "error",
      `${segment.modelId} ⏸ ${outUntil(segment.until, now)}`
    );
  }

  if (segment.kind === "out") {
    return paint.fg(
      "error",
      `${segment.name} ⏸ ${outUntil(segment.until, now)}`
    );
  }

  if (segment.kind === "unknown") {
    return paint.fg("dim", `${segment.name} n/a`);
  }

  const windows = segment.windows.map(
    (window) =>
      `${paint.fg("dim", window.label)} ${bar(window.usedPercent, 5, paint)} ${percentText(window.usedPercent, paint)}`
  );

  return `${segment.name} ${windows.join(" ")}`;
};

/** The one-line fallback for users who opt out of the owned footer. No countdowns here. */
export const formatStatusLine = (
  segments: readonly UsageSegment[],
  paint: Paint,
  now: number
): string | undefined => {
  if (segments.length === 0) {
    return undefined;
  }

  return segments
    .map((segment) => renderPlainSegment(segment, paint, now))
    .join(paint.fg("dim", " · "));
};

const isImportant = (segment: UsageSegment): boolean => {
  if (segment.kind === "out" || segment.kind === "model-out") {
    return true;
  }

  if (segment.kind === "windows") {
    return (
      segment.current ||
      segment.windows.some(
        (window) => severity(window.usedPercent) !== undefined
      )
    );
  }

  return segment.current;
};

/** Whole segments greedily packed into at most two rows. Undefined when a segment or the pack exceeds them. */
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

  const renderAll = (options: SegmentOptions): string[] => [
    ...segments.map((segment) => renderSegment(segment, paint, now, options)),
    ...(elapsed ? [elapsed] : []),
  ];

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

    return kept;
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

/** The context part of row 1: a 10-cell bar, the percent, and the window size. */
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

  return `${paint.fg("dim", "ctx")} ${bar(percent ?? 0, 10, paint)} ${colored}`;
};
