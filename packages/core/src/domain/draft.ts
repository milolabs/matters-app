import type {
  DraftAttachment,
  LargeNotice,
  OfferingCarrier,
  StoredAttachment,
} from "./attachment.ts";
import { describeLargeNotice, notifyIfLarge } from "./attachment.ts";
import type { Participant } from "./entities.ts";
import { isValidAddress } from "./recipients.ts";

/** What the user edits. Everything a send covers, nothing the app adds later. */
export interface DraftContent {
  readonly accountId: string;
  readonly from: Participant;
  readonly to: readonly Participant[];
  readonly cc: readonly Participant[];
  readonly bcc: readonly Participant[];
  readonly subject: string;
  readonly bodyMarkdown: string;
  /** `Message-ID` of the message answered, with angle brackets; empty for a new message. */
  readonly inReplyTo: string;
  readonly references: readonly string[];
  /** The thread being answered, so the sent message lands in it. */
  readonly threadId?: string;
  /** The files to send, in order. Absent or empty means none; both fingerprint the same. */
  readonly attachments?: readonly DraftAttachment[];
  /**
   * Started as a forward (ADR 0045), so a reopened draft is titled so. It changes nothing that is
   * sent, so it is not in the fingerprint and never voids an approval.
   */
  readonly forwarded?: boolean;
}

export interface Draft extends DraftContent {
  readonly id: string;
  /** Starts at 1; increases only when the content really changes. */
  readonly version: number;
  /** SHA-256 (hex) over `canonicalDraft(content)`. */
  readonly fingerprint: string;
  readonly updatedAtMs: number;
}

/** SHA-256 as lower-case hex of the UTF-8 text. Core has no `node:crypto`: adapters bring it. */
export type Sha256Hex = (text: string) => string;

/** A draft cannot be encoded for hashing; never answered with a constant fingerprint. */
export class DraftEncodingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftEncodingError";
  }
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new DraftEncodingError(`${field} must be text`);
  // A lone surrogate does not survive UTF-8; hashing it would hide a change.
  if (/\p{Cs}/u.test(value)) throw new DraftEncodingError(`${field} is not valid Unicode`);
  return value;
}

function person(value: unknown, field: string): [string, string] {
  const p = value as Partial<Participant> | null;
  if (typeof p !== "object" || p === null) throw new DraftEncodingError(`${field} is not a person`);
  return [
    text(p.address, `${field}.address`).trim().toLowerCase(),
    text(p.name ?? "", field).trim(),
  ];
}

function people(list: unknown, field: string): [string, string][] {
  if (!Array.isArray(list)) throw new DraftEncodingError(`${field} must be a list`);
  return list.map((p, i) => person(p, `${field}[${i}]`));
}

function attachmentList(list: unknown): unknown[][] {
  if (!Array.isArray(list)) throw new DraftEncodingError("attachments must be a list");
  return list.map((a, i) => {
    const field = `attachments[${i}]`;
    const f = a as Partial<DraftAttachment> | null;
    if (typeof f !== "object" || f === null) throw new DraftEncodingError(`${field} is not a file`);
    if (typeof f.size !== "number" || !Number.isSafeInteger(f.size) || f.size < 0) {
      throw new DraftEncodingError(`${field}.size must be a number of bytes`);
    }
    const delivery = f.delivery;
    if (delivery?.kind !== "inline" && delivery?.kind !== "link") {
      throw new DraftEncodingError(`${field}.delivery is unknown`);
    }
    return [
      text(f.id, `${field}.id`),
      text(f.name, `${field}.name`),
      f.size,
      delivery.kind === "inline"
        ? "inline"
        : `link:${text(delivery.carrierId, `${field}.carrier`)}`,
    ];
  });
}

/**
 * The exact string the fingerprint covers: fixed key order, addresses lower-cased and trimmed,
 * body and subject untouched. Files are covered by id, name, size and delivery, in order, and
 * the key is left out without any, so drafts from before attachments keep their fingerprints.
 * Whether the draft is a forward is not covered: it is how the draft is titled, not what is sent.
 * Throws `DraftEncodingError` for anything that is not a draft.
 */
export function canonicalDraft(content: DraftContent): string {
  if (typeof content !== "object" || content === null) throw new DraftEncodingError("no draft");
  const references = content.references;
  if (!Array.isArray(references)) throw new DraftEncodingError("references must be a list");
  return JSON.stringify({
    account: text(content.accountId, "accountId"),
    from: person(content.from, "from"),
    to: people(content.to, "to"),
    cc: people(content.cc, "cc"),
    bcc: people(content.bcc, "bcc"),
    subject: text(content.subject, "subject"),
    body: text(content.bodyMarkdown, "bodyMarkdown"),
    inReplyTo: text(content.inReplyTo, "inReplyTo"),
    references: references.map((r, i) => text(r, `references[${i}]`)),
    thread: content.threadId === undefined ? null : text(content.threadId, "threadId"),
    ...(content.attachments === undefined || content.attachments.length === 0
      ? {}
      : { attachments: attachmentList(content.attachments) }),
  });
}

export function fingerprintOf(content: DraftContent, sha256: Sha256Hex): string {
  return sha256(canonicalDraft(content));
}

export function createDraft(
  id: string,
  content: DraftContent,
  sha256: Sha256Hex,
  nowMs: number,
): Draft {
  return {
    ...content,
    id,
    version: 1,
    fingerprint: fingerprintOf(content, sha256),
    updatedAtMs: nowMs,
  };
}

/**
 * Applies new content. The same content returns the same draft object; a real change makes the
 * next version with a new fingerprint (which voids every approval of the old one).
 */
export function reviseDraft(
  draft: Draft,
  content: DraftContent,
  sha256: Sha256Hex,
  nowMs: number,
): Draft {
  const fingerprint = fingerprintOf(content, sha256);
  if (fingerprint === draft.fingerprint) return draft;
  return { ...content, id: draft.id, version: draft.version + 1, fingerprint, updatedAtMs: nowMs };
}

export function contentOf(draft: Draft): DraftContent {
  const { id: _id, version: _v, fingerprint: _f, updatedAtMs: _u, ...content } = draft;
  return content;
}

export interface Gap {
  readonly where: "subject" | "body";
  /** As written, with brackets. */
  readonly token: string;
}

// `[like this]`, but not a Markdown link `[text](url)`, a reference `[text][id]` or `[id]:`, an
// image, or a task box `[ ]` / `[x]`.
const PLACEHOLDER = /(?<![!\]])\[(?![ xX]\])([^\][\n]+)\](?![([:])/g;

// `[https://…]`, `[mailto:…]`, `[www.…]`: how a text version of HTML shows a link, never a gap.
const BRACKETED_LINK = /^\[\s*(?:[a-z][a-z0-9+.-]*:|www\.)/i;

/**
 * The lines the writer wrote: a quoted line (`>`, a reply's or a forward's) is someone else's
 * text, and its brackets are theirs, not gaps left to fill (ADR 0096).
 */
function ownLines(body: string): string {
  return body
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((line) => !/^\s*>/.test(line))
    .join("\n");
}

/** Placeholders the writer left for information still missing. */
export function gaps(content: Pick<DraftContent, "subject" | "bodyMarkdown">): Gap[] {
  const found: Gap[] = [];
  for (const [where, value] of [
    ["subject", content.subject],
    ["body", ownLines(content.bodyMarkdown)],
  ] as const) {
    for (const m of value.matchAll(PLACEHOLDER)) {
      if (!BRACKETED_LINK.test(m[0])) found.push({ where, token: m[0] });
    }
  }
  return found;
}

export type SendBlocker =
  | { readonly kind: "noRecipients" }
  | { readonly kind: "invalidAddress"; readonly address: string }
  | { readonly kind: "gaps"; readonly gaps: readonly Gap[] }
  /** The files together are over what the account's server takes (ADR 0040). */
  | { readonly kind: "tooLarge"; readonly notice: LargeNotice }
  /** A file that cannot go: its copy failed, or there is none. */
  | { readonly kind: "attachmentProblem"; readonly name: string; readonly reason: string };

/** What the files of a draft add to `sendBlockers`; without it only the text is checked. */
export interface SendBlockerContext {
  /** The account's message limit; null or absent when the server announced none. */
  readonly limitBytes?: number | null;
  /** The stored rows of the draft's files. A listed file without a row is a problem. */
  readonly attachments?: readonly StoredAttachment[];
  readonly carriers?: readonly OfferingCarrier[];
}

function attachmentBlockers(
  content: DraftContent,
  context: SendBlockerContext,
): readonly SendBlocker[] {
  const listed = content.attachments ?? [];
  if (listed.length === 0 || context.attachments === undefined) return [];
  const rows = new Map(context.attachments.map((r) => [r.id, r]));
  const blockers: SendBlocker[] = [];
  const present: StoredAttachment[] = [];
  const problems: SendBlocker[] = [];
  for (const file of listed) {
    const row = rows.get(file.id);
    if (!row) {
      problems.push({
        kind: "attachmentProblem",
        name: file.name,
        reason: "It is not attached yet",
      });
      continue;
    }
    present.push(row);
    // `reading` is not a problem: Send waits for the copy by itself (ADR 0041, rule 7).
    if (row.state === "failed") {
      problems.push({
        kind: "attachmentProblem",
        name: row.name,
        reason: row.reason ?? "Can't read this file",
      });
    }
  }
  const notice = notifyIfLarge(present, context.limitBytes ?? null, context.carriers ?? []);
  if (notice?.kind === "tooLarge") blockers.push({ kind: "tooLarge", notice });
  else {
    for (const row of present) {
      if (row.state === "tooLarge") {
        problems.push({
          kind: "attachmentProblem",
          name: row.name,
          reason: row.reason ?? "Too large for your server",
        });
      }
    }
  }
  return [...blockers, ...problems];
}

/** Why this draft must not be sent yet; empty when it may. */
export function sendBlockers(
  content: DraftContent,
  context: SendBlockerContext = {},
): SendBlocker[] {
  const blockers: SendBlocker[] = [];
  const all = [...content.to, ...content.cc, ...content.bcc];
  if (content.to.length + content.cc.length + content.bcc.length === 0) {
    blockers.push({ kind: "noRecipients" });
  }
  for (const p of [content.from, ...all]) {
    if (!isValidAddress(p.address)) blockers.push({ kind: "invalidAddress", address: p.address });
  }
  const open = gaps(content);
  if (open.length > 0) blockers.push({ kind: "gaps", gaps: open });
  blockers.push(...attachmentBlockers(content, context));
  return blockers;
}

export function describeBlocker(b: SendBlocker): string {
  switch (b.kind) {
    case "noRecipients":
      return "Add a recipient.";
    case "invalidAddress":
      return `"${b.address}" is not a valid address.`;
    case "gaps":
      return `Fill in ${b.gaps.map((g) => g.token).join(", ")} first.`;
    case "tooLarge":
      return describeLargeNotice(b.notice);
    case "attachmentProblem":
      return `${b.name}: ${b.reason}`;
  }
}

export class SendBlockedError extends Error {
  readonly blockers: readonly SendBlocker[];
  constructor(blockers: readonly SendBlocker[]) {
    super(blockers.map(describeBlocker).join(" "));
    this.name = "SendBlockedError";
    this.blockers = blockers;
  }
}
