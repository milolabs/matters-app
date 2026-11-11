/**
 * The agent proposes, the person presses (ADR 0102). The loop may end with offers: a view to save,
 * a clean-up to run, a message to open as a draft. Each is text until the person presses its
 * button. Here: the shape the model writes, and the one check per kind that accepts an offer or
 * drops it. A new kind is a new entry in `OFFER_KINDS`, the schema's fields, and one function here.
 */

import type {
  TalkActAction,
  TalkActOffer,
  TalkMessageOffer,
  TalkOffer,
  TalkOfferKind,
  TalkViewOffer,
} from "../domain/agent.ts";
import { MAX_TALK_QUERY_CHARS } from "../domain/agentSchemas.ts";
import type { SavedView } from "../domain/views.ts";
import { MAX_VIEW_NAME } from "../domain/views.ts";
import { type QueryCount, sameQueryText } from "./mailCounts.ts";
import { isEmptyQuery, type ParsedQuery, parseQuery } from "./parseQuery.ts";
import { clean } from "./thingsThatMatter.ts";
import { viewNameProblem, viewQueryProblem } from "./views.ts";

// --- Limits. Starting values (ADR 0102). ---

/** Offers one answer may make, of all kinds together. */
export const MAX_OFFERS = 6;
/** The line on why an offer helps. */
export const MAX_OFFER_WHY_CHARS = 160;
/** Recipients of a message offer. */
export const MAX_MESSAGE_TO = 5;
export const MAX_MESSAGE_SUBJECT_CHARS = 200;
export const MAX_MESSAGE_BODY_CHARS = 4000;

export const OFFER_KINDS: readonly TalkOfferKind[] = ["view", "act", "message"];
export const ACT_ACTIONS: readonly TalkActAction[] = ["archive", "trash", "markRead"];

/**
 * One offer in the loop's final value. Structured output takes a flat object more reliably than a
 * union, so every kind's fields are here, optional, beside `kind` and `why`, and the code checks
 * per kind which must be present (as `REMEMBER_SCHEMA` does with its scopes).
 */
export const TALK_OFFER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "why"],
  properties: {
    kind: { type: "string", enum: OFFER_KINDS },
    why: { type: "string", minLength: 1, maxLength: MAX_OFFER_WHY_CHARS },
    name: { type: "string", minLength: 1, maxLength: MAX_VIEW_NAME },
    query: { type: "string", minLength: 1, maxLength: MAX_TALK_QUERY_CHARS },
    notify: { type: "boolean" },
    action: { type: "string", enum: ACT_ACTIONS },
    to: {
      type: "array",
      maxItems: MAX_MESSAGE_TO,
      items: { type: "string", minLength: 3, maxLength: 320 },
    },
    subject: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_SUBJECT_CHARS },
    body: { type: "string", minLength: 1, maxLength: MAX_MESSAGE_BODY_CHARS },
  },
} as const;

/** An offer as the model wrote it: only its shape is known. */
export interface ProposedOffer {
  readonly kind: TalkOfferKind;
  readonly why: string;
  readonly name?: string;
  readonly query?: string;
  readonly notify?: boolean;
  readonly action?: TalkActAction;
  readonly to?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
}

const STRING_FIELDS = ["why", "name", "query", "subject", "body"] as const;

/** The shape of one offer, or null. Lengths and per-kind fields are checked on acceptance. */
export function parseProposedOffer(value: unknown): ProposedOffer | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  const allowed = Object.keys(TALK_OFFER_SCHEMA.properties);
  if (Object.keys(o).some((k) => !allowed.includes(k))) return null;
  if (!OFFER_KINDS.includes(o.kind as TalkOfferKind)) return null;
  for (const f of STRING_FIELDS) {
    if (o[f] !== undefined && typeof o[f] !== "string") return null;
  }
  if (typeof o.why !== "string") return null;
  if (o.notify !== undefined && typeof o.notify !== "boolean") return null;
  if (o.action !== undefined && !ACT_ACTIONS.includes(o.action as TalkActAction)) return null;
  if (o.to !== undefined) {
    if (!Array.isArray(o.to) || !o.to.every((t) => typeof t === "string")) return null;
  }
  return o as unknown as ProposedOffer;
}

export interface OfferContext {
  /** The person's views now. */
  readonly existing: readonly Pick<SavedView, "name" | "query">[];
  readonly nowMs: number;
  /** For `account:` and `from:me`, as in search. */
  readonly accounts: readonly { id: string; address: string; displayName: string }[];
  /** The count by code; null when it could not be made, which drops the offer. */
  count(parsed: ParsedQuery): Promise<QueryCount | null>;
  /** Lowercase addresses the person has sent mail to (their Sent mail's To and Cc). */
  readonly writtenTo: ReadonlySet<string>;
}

/** One kind's check: the offer the code stands behind, or null. `before` are those accepted so far. */
type Acceptor = (
  p: ProposedOffer,
  ctx: OfferContext,
  before: readonly TalkOffer[],
) => Promise<TalkOffer | null>;

/** A name or query must come as written: control or invisible characters drop it, never repaired. */
const exact = (text: string) => clean(text) === text && !/\n/.test(text);
/** A line of the model's own: cleaned, on one line. */
const line = (text: string) => clean(text).replace(/\s+/g, " ").trim();

/** The query of a view or a clean-up, checked and counted, or null. */
async function countedQuery(
  raw: string | undefined,
  ctx: OfferContext,
): Promise<{ query: string; counted: QueryCount } | null> {
  if (raw === undefined || !exact(raw)) return null;
  const query = raw.trim();
  if (query.length > MAX_TALK_QUERY_CHARS || viewQueryProblem(query) !== null) return null;
  const parsed = parseQuery(query, { nowMs: ctx.nowMs, accounts: ctx.accounts });
  if (parsed.diagnostics.length > 0 || isEmptyQuery(parsed)) return null;
  const counted = await ctx.count(parsed);
  if (counted === null || counted.matches === 0) return null;
  return { query, counted };
}

/**
 * A view (rule 6): a name `createView` takes beside the person's views and the views offered
 * before it; a query that is no view's text and no earlier view offer's; a count above 0.
 */
const acceptView: Acceptor = async (p, ctx, before) => {
  if (p.name === undefined || !exact(p.name)) return null;
  const name = p.name.trim();
  const views = before.filter((o): o is TalkViewOffer => o.kind === "view");
  if (viewNameProblem(name, [...ctx.existing, ...views]) !== null) return null;
  const taken = new Set([...ctx.existing, ...views].map((v) => sameQueryText(v.query)));
  if (p.query === undefined || taken.has(sameQueryText(p.query))) return null;
  const q = await countedQuery(p.query, ctx);
  if (q === null) return null;
  return {
    kind: "view",
    name,
    query: q.query,
    why: line(p.why),
    ...(p.notify === true ? { notify: true as const } : {}),
    matches: q.counted.matches,
    matchesCapped: q.counted.capped,
    unread: q.counted.unread,
  };
};

/**
 * A clean-up (rule 7): one of the three actions; a query checked as a view's; a count above 0, and
 * unread mail when it marks read; not the same action and query as an earlier offer.
 */
const acceptAct: Acceptor = async (p, ctx, before) => {
  if (p.action === undefined || p.query === undefined) return null;
  const action = p.action;
  const query = p.query;
  if (
    before.some(
      (o) =>
        o.kind === "act" && o.action === action && sameQueryText(o.query) === sameQueryText(query),
    )
  ) {
    return null;
  }
  const q = await countedQuery(query, ctx);
  if (q === null || (action === "markRead" && q.counted.unread === 0)) return null;
  const offer: TalkActOffer = {
    kind: "act",
    action,
    query: q.query,
    why: line(p.why),
    matches: q.counted.matches,
    matchesCapped: q.counted.capped,
    unread: q.counted.unread,
  };
  return offer;
};

const ADDRESS = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

/**
 * A message (rule 8). An address is kept only when the person has written to it before; the rest
 * are named in `unknownTo` and never reach the draft, so mail cannot make the agent address a
 * stranger. A subject and a body are needed; both are cleaned of control and invisible characters.
 */
const acceptMessage: Acceptor = async (p, ctx) => {
  const subject = line(p.subject ?? "");
  const body = clean(p.body ?? "").trim();
  if (subject === "" || subject.length > MAX_MESSAGE_SUBJECT_CHARS) return null;
  if (body === "" || body.length > MAX_MESSAGE_BODY_CHARS) return null;
  const to: string[] = [];
  const unknownTo: string[] = [];
  for (const raw of (p.to ?? []).slice(0, MAX_MESSAGE_TO)) {
    const address = clean(raw).trim().toLowerCase();
    if (!ADDRESS.test(address) || to.includes(address) || unknownTo.includes(address)) continue;
    (ctx.writtenTo.has(address) ? to : unknownTo).push(address);
  }
  const offer: TalkMessageOffer = {
    kind: "message",
    to,
    unknownTo,
    subject,
    body,
    why: line(p.why),
  };
  return offer;
};

/** The check of each kind. */
const ACCEPTORS: Readonly<Record<TalkOfferKind, Acceptor>> = {
  view: acceptView,
  act: acceptAct,
  message: acceptMessage,
};

/**
 * The offers the code stands behind (ADR 0102), in the model's order, at most `MAX_OFFERS`. Each
 * goes to the check of its kind; an offer whose line on why is empty or too long is dropped
 * whatever its kind. An offer that fails is dropped, never repaired. Counts are the code's.
 */
export async function acceptOffers(
  proposed: readonly ProposedOffer[] | undefined,
  ctx: OfferContext,
): Promise<TalkOffer[]> {
  const accepted: TalkOffer[] = [];
  for (const p of (proposed ?? []).slice(0, MAX_OFFERS)) {
    const why = line(p.why ?? "");
    if (why === "" || why.length > MAX_OFFER_WHY_CHARS) continue;
    const accept = ACCEPTORS[p.kind];
    if (accept === undefined) continue;
    const made = await accept(p, ctx, accepted);
    if (made !== null) accepted.push(made);
  }
  return accepted;
}
