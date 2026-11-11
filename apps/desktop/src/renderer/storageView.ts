import type {
  MainStorageInfo,
  ProcessKind,
  StorageReport,
  StorageSampleInfo,
} from "@matters/contracts";

/** One row of the bar and the list under it (ADR 0089, rule 1). */
export interface StoragePart {
  readonly id:
    | "search"
    | "html"
    | "mail"
    | "text"
    | "filesText"
    | "caches"
    | "files"
    | "other"
    | "free";
  readonly label: string;
  readonly detail: string;
  readonly bytes: number;
  /** A CSS colour; `free` is drawn striped instead. */
  readonly color: string;
}

/** Compact is offered from this share of the database free (ADR 0089, rule 6). */
export const COMPACT_FROM_SHARE = 0.1;
const DAY_MS = 86_400_000;

/** Sizes as Finder counts them: 1 KB is a thousand bytes. */
export function storageSize(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(0, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${Math.round(bytes / 1_000_000)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
}

export function count(n: number): string {
  return n.toLocaleString("en-US");
}

/** Every part, largest first, free space last; the database's parts come from the last sample. */
export function storageParts(
  report: StorageReport,
  main: MainStorageInfo | null,
): readonly StoragePart[] {
  const sample = report.samples.at(-1);
  const parts: StoragePart[] = [];
  if (sample) {
    parts.push(
      {
        id: "search",
        label: "Search index",
        detail: "Every word of every message, for search as you type",
        bytes: sample.searchBytes,
        color: "var(--acct-blue)",
      },
      {
        id: "html",
        label: "Messages as sent",
        detail: "Their HTML as the senders wrote it, kept together by sender",
        bytes: sample.htmlBytes,
        color: "var(--acct-teal)",
      },
      {
        id: "mail",
        label: "Messages and headers",
        detail: "Senders, subjects, dates, threads, labels",
        bytes: sample.mailBytes,
        color: "var(--acct-indigo)",
      },
      {
        id: "text",
        label: "Text of messages",
        detail: "What search, replies and agents read",
        bytes: sample.textBytes,
        color: "var(--acct-green)",
      },
      {
        id: "filesText",
        label: "Text of files",
        detail: "What agents read from attachments",
        bytes: sample.filesTextBytes,
        color: "var(--acct-rust)",
      },
    );
  }
  if (main) {
    parts.push(
      {
        id: "caches",
        label: "Caches",
        detail: "Pages and code the app keeps to start fast",
        bytes: main.folders.cachesBytes,
        color: "var(--acct-graphite)",
      },
      {
        id: "files",
        label: "Files",
        detail: "Attachments you or the agent opened, saved or pasted",
        bytes: main.folders.filesBytes,
        color: "var(--acct-ochre)",
      },
      {
        id: "other",
        label: "Settings and the rest",
        detail: "Window places, preferences, saved passwords",
        bytes: main.folders.otherBytes,
        color: "var(--acct-plum)",
      },
    );
  }
  parts.sort((a, b) => b.bytes - a.bytes);
  parts.push({
    id: "free",
    label: "Free space in the database",
    detail: "Left by moves and deletions; new mail reuses it",
    bytes: report.freeBytes,
    color: "transparent",
  });
  return parts;
}

/** What is on this Mac: main's folders when it answered, else the database file alone. */
export function totalBytes(report: StorageReport, main: MainStorageInfo | null): number {
  if (!main) return report.fileBytes;
  const f = main.folders;
  return f.databaseBytes + f.filesBytes + f.cachesBytes + f.otherBytes;
}

/** Clear is offered for the text of files once any file was read (ADR 0087, rule 11). */
export function canClearFileText(report: StorageReport): boolean {
  return report.filesRead > 0;
}

/** "3 files read" beside the text of files. */
export function filesReadLine(n: number): string {
  return `${count(n)} ${n === 1 ? "file" : "files"} read`;
}

export function canCompact(report: StorageReport): boolean {
  return report.fileBytes > 0 && report.freeBytes / report.fileBytes >= COMPACT_FROM_SHARE;
}

/** The database's size over time, and how it changed in the last 30 days, when known. */
export function overTime(
  samples: readonly StorageSampleInfo[],
  nowMs: number,
): {
  points: readonly { atMs: number; bytes: number }[];
  change30?: number;
  newMessages30?: number;
} {
  const points = samples.map((s) => ({ atMs: s.atMs, bytes: s.fileBytes - s.freeBytes }));
  const last = samples.at(-1);
  const before = [...samples].reverse().find((s) => s.atMs <= nowMs - 30 * DAY_MS);
  if (!last || !before) return { points };
  return {
    points,
    change30: last.fileBytes - last.freeBytes - (before.fileBytes - before.freeBytes),
    newMessages30: last.messages - before.messages,
  };
}

/** A polyline for an SVG of this size: oldest on the left, scaled to the values' range. */
export function linePoints(
  points: readonly { atMs: number; bytes: number }[],
  width: number,
  height: number,
): string {
  if (points.length === 0) return "";
  const first = points[0] as { atMs: number };
  const last = points.at(-1) as { atMs: number };
  const span = Math.max(1, last.atMs - first.atMs);
  const values = points.map((p) => p.bytes);
  const low = Math.min(...values);
  const high = Math.max(...values);
  const range = Math.max(1, high - low);
  return points
    .map((p) => {
      const x = points.length === 1 ? width : ((p.atMs - first.atMs) / span) * width;
      const y = height - 4 - ((p.bytes - low) / range) * (height - 8);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

const PROCESS_LABELS: Record<ProcessKind, { label: string; detail: string }> = {
  backend: { label: "Database and sync", detail: "search, mail, the background work" },
  mail: { label: "Mail window", detail: "the list and the reader" },
  settings: { label: "Settings window", detail: "" },
  app: { label: "App", detail: "windows, menus, notifications" },
  gpu: { label: "Graphics", detail: "" },
  network: { label: "Network", detail: "" },
  other: { label: "Other", detail: "" },
};

export function processLabel(kind: ProcessKind): { label: string; detail: string } {
  return PROCESS_LABELS[kind];
}

/** "Measured 2 min ago", or nothing when there is no measurement. */
export function measuredAgo(atMs: number | undefined, nowMs: number): string {
  if (atMs === undefined) return "Not measured yet";
  const minutes = Math.round((nowMs - atMs) / 60_000);
  if (minutes < 1) return "Measured just now";
  if (minutes < 60) return `Measured ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Measured ${hours} h ago`;
  return `Measured ${Math.round(hours / 24)} d ago`;
}
