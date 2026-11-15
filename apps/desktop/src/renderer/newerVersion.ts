// What a window knows of newer versions (ADR 0137): main's state, asked once and kept in step as
// main tells every window of a change (ADR 0115). And the words the gear and About say of it.
import type { ReleaseInfo } from "@matters/contracts";
import { createSignal } from "solid-js";
import { askRelease, onReleaseChanged } from "./files.ts";

export function createReleaseStore() {
  const [info, setInfo] = createSignal<ReleaseInfo | null>(null);
  // A change main pushed is newer than the answer to an ask sent before it.
  let pushed = false;
  onReleaseChanged((next) => {
    pushed = true;
    setInfo(next);
  });
  void askRelease({ action: "get" }).then((got) => {
    if (got && !pushed) setInfo(got);
  });
  return {
    info,
    /** Keeps main's answer to an ask, as a push would. */
    take(next: ReleaseInfo | null) {
      if (next) setInfo(next);
    },
  };
}

export type ReleaseStore = ReturnType<typeof createReleaseStore>;

/** The gear's name for a screen reader and its tooltip (rule 9). */
export function gearLabel(info: ReleaseInfo | null): string {
  return info?.dot && info.newer ? `Settings · Matters ${info.newer.version} is out` : "Settings";
}

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayMonth = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long" });
const dayMonthYear = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

/** "14 November", with the year when it is not this one. */
function day(ms: number, now: number): string {
  const d = new Date(ms);
  return d.getFullYear() === new Date(now).getFullYear()
    ? dayMonth.format(d)
    : dayMonthYear.format(d);
}

/** "today at 09:14" or "on 12 November". */
function when(ms: number, now: number): string {
  const d = new Date(ms);
  return sameDay(d, new Date(now)) ? `today at ${time.format(d)}` : `on ${day(ms, now)}`;
}

/** The running version's stage, as About names it: "an alpha". */
export function stageWords(stage: string | null): string | null {
  if (stage === null) return null;
  if (stage === "alpha") return "an alpha";
  if (stage === "beta") return "a beta";
  if (stage === "rc") return "a release candidate";
  return "a pre-release";
}

/** "Version 0.1.0-alpha.4 · an alpha". */
export function versionLine(info: ReleaseInfo): string {
  const stage = stageWords(info.stage);
  return stage === null ? `Version ${info.version}` : `Version ${info.version} · ${stage}`;
}

/** "Published on 14 November." */
export function publishedLine(dateMs: number | null, now = Date.now()): string {
  return dateMs === null ? "" : `Published on ${day(dateMs, now)}.`;
}

/** Beside Check now: "Checked today at 09:14." */
export function checkedLine(info: ReleaseInfo, now = Date.now()): string {
  if (!info.asks || !info.enabled) return "";
  if (info.checking) return "Checking…";
  return info.checkedMs === null ? "Not checked yet." : `Checked ${when(info.checkedMs, now)}.`;
}

/** The line under the version, in each state of the design. */
export type AboutState =
  | { readonly kind: "source" }
  | { readonly kind: "off" }
  | { readonly kind: "newer" }
  | { readonly kind: "failed"; readonly line: string; readonly sub: string }
  | { readonly kind: "newest" }
  | { readonly kind: "unchecked"; readonly line: string };

/**
 * Which line About shows. A newer version stays said while it is true, also after a check that
 * failed (rule 10); a failure is said only when there is nothing newer to say (rule 12).
 */
export function aboutState(info: ReleaseInfo, now = Date.now()): AboutState {
  if (!info.asks) return { kind: "source" };
  if (!info.enabled) return { kind: "off" };
  if (info.newer) return { kind: "newer" };
  if (info.failure !== null && !info.checking) {
    const last = info.checkedMs === null ? "" : `Last checked ${when(info.checkedMs, now)}. `;
    return {
      kind: "failed",
      line: `Could not check: ${info.failure}`,
      sub: `${last}Matters tries again when it next starts.`,
    };
  }
  if (info.checkedMs !== null) return { kind: "newest" };
  return {
    kind: "unchecked",
    line: info.checking ? "Checking for a newer version…" : "Matters has not checked yet.",
  };
}
