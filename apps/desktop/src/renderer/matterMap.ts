// The threads of a matter as an order of work (ADR 0059, rule 5): what can start now at the left, what
// waits for it under it, and the reason on the line between them. Pure, so the tree, the guides and
// the words are tested without a page.
import type { ThingBundle } from "@matters/core";

export interface MapRow {
  readonly threadId: string;
  readonly depth: number;
  /** Nothing holds it up: it can start now. */
  readonly ready: boolean;
  /** For each level to the left, whether a line runs on past this row. */
  readonly guides: readonly boolean[];
  /** It has rows of its own below: a line leaves its dot. */
  readonly stem: boolean;
  /** What the line above it rests on. */
  readonly quote?: string;
  /** Who else it waits for, beyond the row it is drawn under. */
  readonly alsoWaitsOn: readonly string[];
}

function reachFrom(id: string, bundle: ThingBundle): Set<string> {
  const seen = new Set<string>();
  const walk = (at: string) => {
    for (const e of bundle.edges) {
      if (e.blocker === at && !seen.has(e.blocked)) {
        seen.add(e.blocked);
        walk(e.blocked);
      }
    }
  };
  walk(id);
  return seen;
}

/** Every thread once, under the first thing that holds it up; what frees the most comes first. */
export function matterRows(bundle: ThingBundle): MapRow[] {
  const ids = new Set(bundle.members.map((m) => m.threadId));
  const edges = bundle.edges.filter((e) => ids.has(e.blocker) && ids.has(e.blocked));
  const known = { ...bundle, edges };
  const who = (id: string) => bundle.members.find((m) => m.threadId === id)?.who ?? "";
  const frees = (id: string) => reachFrom(id, known).size;
  const byWeight = (list: readonly string[]) =>
    [...list].sort((a, b) => frees(b) - frees(a) || list.indexOf(a) - list.indexOf(b));
  const blockers = (id: string) => edges.filter((e) => e.blocked === id);

  const rows: MapRow[] = [];
  const placed = new Set<string>();
  const place = (id: string, depth: number, guides: readonly boolean[], quote?: string) => {
    placed.add(id);
    // A child belongs under its first blocker alone, so a thread is never drawn twice.
    const children = byWeight(edges.filter((e) => e.blocker === id).map((e) => e.blocked)).filter(
      (c) => !placed.has(c) && blockers(c)[0]?.blocker === id,
    );
    const others = blockers(id).slice(1);
    rows.push({
      threadId: id,
      depth,
      ready: blockers(id).length === 0,
      guides,
      stem: children.length > 0,
      ...(quote === undefined ? {} : { quote }),
      alsoWaitsOn: others.map((e) => who(e.blocker)),
    });
    children.forEach((child, i) => {
      const edge = edges.find((e) => e.blocker === id && e.blocked === child);
      place(child, depth + 1, [...guides, i < children.length - 1], edge?.quote);
    });
  };
  const roots = byWeight(
    bundle.members.map((m) => m.threadId).filter((id) => !blockers(id).length),
  );
  for (const root of roots) place(root, 0, []);
  return rows;
}

const others = (n: number) => `${n} ${n === 1 ? "other" : "others"}`;

export interface MatterSummary {
  readonly text: string;
  /** It rests on what an agent said blocks what, and is drawn as the agent's. */
  readonly agent: boolean;
}

/** The one sentence the map exists for: where to start, and what that does. */
export function matterSummary(bundle: ThingBundle): MatterSummary {
  const rows = matterRows(bundle);
  const starts = rows.filter((r) => r.ready && r.stem);
  const held = rows.filter((r) => !r.ready).length;
  if (held === 0) {
    return {
      text: `${rows.length} threads about the same thing. None holds up another.`,
      agent: false,
    };
  }
  const [only] = starts;
  if (starts.length === 1 && only !== undefined) {
    const name = bundle.members.find((m) => m.threadId === only.threadId)?.who ?? "";
    return { text: `Start with ${name}. It frees ${others(held)}.`, agent: true };
  }
  return { text: `${starts.length} can start now, and free ${others(held)}.`, agent: true };
}

/** What lights up with a row: what it waits for and what waits for it. Empty for no row. */
export function pathOf(bundle: ThingBundle, id: string | null): ReadonlySet<string> {
  if (id === null) return new Set();
  const out = reachFrom(id, bundle);
  out.add(id);
  const up = (at: string) => {
    for (const e of bundle.edges) {
      if (e.blocked === at && !out.has(e.blocker)) {
        out.add(e.blocker);
        up(e.blocker);
      }
    }
  };
  up(id);
  return out;
}

/** Which part of a matter's rail a row draws, from its neighbours in the list. */
export function railAt(
  ids: readonly (string | undefined)[],
  at: number,
): "first" | "middle" | "last" | undefined {
  const id = ids[at];
  if (id === undefined) return undefined;
  const before = ids[at - 1] === id;
  const after = ids[at + 1] === id;
  if (!before && !after) return undefined;
  return !before ? "first" : after ? "middle" : "last";
}
