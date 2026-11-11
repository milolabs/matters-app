// The hostile-mail corpus (ADR 0047): loading the manifest, reading a case's bytes, and the
// ratchet that judges a measured value against what the manifest says it should be.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateCase } from "./corpusGenerators.ts";

export const CORPUS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "corpus");

export type Category =
  | "identity"
  | "auth-results"
  | "html"
  | "mime"
  | "attachments"
  | "compose"
  | "transport"
  | "agent";
export const CATEGORIES: readonly Category[] = [
  "identity",
  "auth-results",
  "html",
  "mime",
  "attachments",
  "compose",
  "transport",
  "agent",
];
export type Tier = "node" | "browser" | "compose" | "transport";
export const TIERS: readonly Tier[] = ["node", "browser", "compose", "transport"];
export type Severity = "critical" | "high" | "medium" | "low";
export const SEVERITIES: readonly Severity[] = ["critical", "high", "medium", "low"];

/** A defence that does not hold today: the test asserts the weak behaviour until it is fixed. */
export interface Gap {
  readonly severity: Severity;
  /** One line: what the weak behaviour is. */
  readonly reason: string;
  /** What the check measures today. The test fails when this stops being true. */
  readonly current: unknown;
}

export interface Check {
  readonly name: string;
  /** What must be true for the defence to hold. */
  readonly ideal: unknown;
  /** Extra input a check needs (a domain to build a rule for, an address to compare). */
  readonly arg?: unknown;
  readonly gap?: Gap;
}

export interface TierSpec {
  readonly checks: readonly Check[];
  /** Browser tier: `bypass` puts the case's HTML in the frame without the sanitizer. */
  readonly mode?: "pipeline" | "bypass";
  /** Transport tier: which protocols the scenario runs for. */
  readonly protocols?: readonly string[];
}

export interface CorpusCase {
  readonly id: string;
  readonly category: Category;
  readonly title: string;
  readonly sources: readonly string[];
  readonly attacks: string;
  /** Relative to the corpus directory; absent for cases that are code (transport, compose). */
  readonly file?: string;
  /** Messages too large to commit are made by name at run time. */
  readonly generator?: string;
  readonly tiers: Partial<Record<Tier, TierSpec>>;
}

export function loadManifest(): CorpusCase[] {
  const text = readFileSync(join(CORPUS_DIR, "manifest.json"), "utf8");
  return (JSON.parse(text) as { cases: CorpusCase[] }).cases;
}

/** The host a case writes for the canary; the runner swaps in the real address. */
export const CANARY_TOKEN = "canary.test";

/**
 * The bytes of a case, exactly as stored. `canary` replaces the token host (`127.0.0.1:PORT` in the
 * browser tier); without it the token stays, which is a name that never resolves.
 */
export function caseBytes(c: CorpusCase, canary?: string): Buffer {
  let bytes: Buffer;
  if (c.file) bytes = readFileSync(join(CORPUS_DIR, c.file));
  else if (c.generator) bytes = generateCase(c.generator, c.id);
  else throw new Error(`${c.id} has no message`);
  if (canary === undefined) return bytes;
  return Buffer.from(bytes.toString("latin1").replaceAll(CANARY_TOKEN, canary), "latin1");
}

/** JSON with object keys in a fixed order, so equal values compare equal however they were built. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** JSON equality, plus `{ $includes }` and `{ $notIncludes }` for text. */
export function matches(expected: unknown, actual: unknown): boolean {
  if (typeof expected === "object" && expected !== null && !Array.isArray(expected)) {
    const e = expected as Record<string, unknown>;
    if (typeof e.$includes === "string")
      return typeof actual === "string" && actual.includes(e.$includes);
    if (typeof e.$notIncludes === "string") {
      return typeof actual === "string" && !actual.includes(e.$notIncludes);
    }
  }
  return deepEqual(expected, actual);
}

export type Verdict =
  | { readonly status: "holds" }
  | { readonly status: "knownGap"; readonly gap: Gap }
  | { readonly status: "fail"; readonly why: string };

/** The ratchet: a gap is asserted as it is, and fails when it stops being true. */
export function judge(check: Check, actual: unknown): Verdict {
  const shown = JSON.stringify(actual);
  if (check.gap === undefined) {
    return matches(check.ideal, actual)
      ? { status: "holds" }
      : {
          status: "fail",
          why: `${check.name}: expected ${JSON.stringify(check.ideal)}, measured ${shown}`,
        };
  }
  if (matches(check.ideal, actual)) {
    return {
      status: "fail",
      why: `${check.name}: the known gap (${check.gap.reason}) no longer holds, so the defence works now. Remove the gap entry from the manifest.`,
    };
  }
  return matches(check.gap.current, actual)
    ? { status: "knownGap", gap: check.gap }
    : {
        status: "fail",
        why: `${check.name}: the weak behaviour changed: recorded ${JSON.stringify(check.gap.current)}, measured ${shown}. Re-read it and update the manifest.`,
      };
}

export interface Tally {
  holds: number;
  knownGap: number;
  bySeverity: Record<Severity, number>;
}

/** Collects verdicts per category, to print at the end of a tier. */
export class TierSummary {
  private readonly rows = new Map<string, Tally>();
  private readonly gaps: { id: string; check: string; gap: Gap }[] = [];
  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  record(c: CorpusCase, check: Check, verdict: Verdict): void {
    if (verdict.status === "fail") return;
    const row = this.rows.get(c.category) ?? {
      holds: 0,
      knownGap: 0,
      bySeverity: { critical: 0, high: 0, medium: 0, low: 0 },
    };
    if (verdict.status === "holds") row.holds++;
    else {
      row.knownGap++;
      row.bySeverity[verdict.gap.severity]++;
      this.gaps.push({ id: c.id, check: check.name, gap: verdict.gap });
    }
    this.rows.set(c.category, row);
  }

  print(): string {
    const lines = [`corpus ${this.name} tier: checks by category (holds / knownGap)`];
    let holds = 0;
    let gaps = 0;
    for (const [category, t] of this.rows) {
      holds += t.holds;
      gaps += t.knownGap;
      lines.push(`  ${category.padEnd(13)} ${String(t.holds).padStart(4)} / ${t.knownGap}`);
    }
    lines.push(`  total         ${String(holds).padStart(4)} / ${gaps}`);
    for (const g of this.gaps) {
      lines.push(`  gap [${g.gap.severity}] ${g.id} ${g.check}: ${g.gap.reason}`);
    }
    return lines.join("\n");
  }
}
