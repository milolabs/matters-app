import { isReplySubject, normalizeSubject } from "./conversation.ts";

export interface ThreadingHeaders {
  /** Own `Message-ID`, without surrounding whitespace; empty when the message has none. */
  readonly messageId: string;
  readonly inReplyTo: string;
  readonly references: readonly string[];
}

/**
 * Thread id for providers without thread ids: the root of the conversation as far as the headers
 * tell: first `References` id, else `In-Reply-To`, else the message's own id.
 *
 * This only names the thread from the headers. The store joins it to the threads of the messages
 * it touches (ADR 0091); `threadParents` and `chooseThread` are the rules it applies.
 */
export function localThreadRoot({ messageId, inReplyTo, references }: ThreadingHeaders): string {
  return references[0] || inReplyTo || messageId;
}

/** Prefix of a thread computed here, as opposed to a provider's thread id (`pt:`). */
export const LOCAL_THREAD = "lt:";

export function isLocalThread(threadId: string): boolean {
  return threadId.startsWith(LOCAL_THREAD);
}

/**
 * The ids a message points to (ADR 0091, rule 1): `References` in order, then `In-Reply-To`,
 * each once, without blanks and without the message's own id.
 */
export function threadParents({ messageId, inReplyTo, references }: ThreadingHeaders): string[] {
  const out: string[] = [];
  for (const raw of [...references, inReplyTo]) {
    const id = raw.trim();
    if (id !== "" && id !== messageId && !out.includes(id)) out.push(id);
  }
  return out;
}

/** The root a local thread id names (`lt:<account>:<root>`), or "" for any other id. */
export function localThreadRootOf(threadId: string, accountId: string): string {
  const prefix = `${LOCAL_THREAD}${accountId}:`;
  return threadId.startsWith(prefix) ? threadId.slice(prefix.length) : "";
}

/** A thread that may take a message, with the date of its first message (none: not stored yet). */
export interface ThreadCandidate {
  readonly threadId: string;
  readonly firstDateMs: number | null;
}

/**
 * Which thread keeps its id when several meet (ADR 0091, rule 3): the one whose first message is
 * the oldest; one with no stored message comes last; a tie goes to the smaller id.
 */
export function chooseThread(candidates: readonly ThreadCandidate[]): string {
  let best: ThreadCandidate | undefined;
  for (const c of candidates) {
    if (best === undefined) {
      best = c;
      continue;
    }
    const a = c.firstDateMs ?? Number.POSITIVE_INFINITY;
    const b = best.firstDateMs ?? Number.POSITIVE_INFINITY;
    if (a < b || (a === b && c.threadId < best.threadId)) best = c;
  }
  if (best === undefined) throw new Error("no thread to choose from");
  return best.threadId;
}

// ADR 0104 (amends ADR 0091, rule 7): a reply that points to nothing joins, by its subject, the
// thread in which the person wrote to its sender.

/** How much older than the reply the message it answers may be. */
export const SUBJECT_JOIN_DAYS = 30;
export const SUBJECT_JOIN_WINDOW_MS = SUBJECT_JOIN_DAYS * 86_400_000;
/** The shortest normalised subject a reply is joined by. */
export const SUBJECT_JOIN_MIN_LENGTH = 3;

/** What the rule needs to know of the message being stored. */
export interface SubjectJoinMessage {
  readonly messageId: string;
  /** The ids it points to; absent when its headers were not read. */
  readonly parentIds?: readonly string[];
  readonly subject: string;
  /** Its sender's address, any case. */
  readonly sender: string;
  readonly dateMs: number;
  /** Whether the person (the owner of the mailbox) wrote it. */
  readonly byPerson: boolean;
}

/** A stored message of a thread that may take the reply. */
export interface SubjectJoinCandidate {
  readonly threadId: string;
  readonly dateMs: number;
  readonly subject: string;
  /** Whether the person wrote it. */
  readonly byPerson: boolean;
  /** Its `To` and `Cc` addresses, any case. */
  readonly recipients: readonly string[];
}

/** A `Message-ID` that names nothing. */
function blankId(id: string): boolean {
  const t = id.trim();
  return t === "" || t === "<>";
}

/**
 * The normalised subject a message may be joined by (ADR 0104, rules 1 to 3), or "" when it may
 * not: its headers were read and point to nothing, its `Message-ID` is not blank, the person did
 * not write it, and its subject is a reply's with at least `SUBJECT_JOIN_MIN_LENGTH` characters
 * left once normalised.
 */
export function subjectToJoinBy(m: SubjectJoinMessage): string {
  if (m.parentIds === undefined || m.parentIds.length > 0) return "";
  if (blankId(m.messageId) || m.byPerson || !isReplySubject(m.subject)) return "";
  const subject = normalizeSubject(m.subject);
  return subject.length >= SUBJECT_JOIN_MIN_LENGTH ? subject : "";
}

/**
 * The thread a reply that points to nothing joins by its subject (ADR 0104), or undefined.
 * `own` are the threads it is in already; `candidates` are stored messages of other threads of
 * its account. A thread qualifies when it is local, holds a message dated before the reply and at
 * most `SUBJECT_JOIN_DAYS` older with the same normalised subject, and holds a message the person
 * wrote before the reply to its sender. Of several, the one whose such subject is the newest; a
 * tie goes to the smaller id.
 */
export function threadBySubject(
  m: SubjectJoinMessage,
  own: readonly string[],
  candidates: readonly SubjectJoinCandidate[],
): string | undefined {
  const subject = subjectToJoinBy(m);
  if (subject === "") return undefined;
  const sender = m.sender.trim().toLowerCase();
  if (sender === "") return undefined;
  const newest = new Map<string, number>();
  const wrote = new Set<string>();
  for (const c of candidates) {
    if (!isLocalThread(c.threadId) || own.includes(c.threadId) || c.dateMs >= m.dateMs) continue;
    if (c.byPerson && c.recipients.some((address) => address.trim().toLowerCase() === sender)) {
      wrote.add(c.threadId);
    }
    if (m.dateMs - c.dateMs <= SUBJECT_JOIN_WINDOW_MS && normalizeSubject(c.subject) === subject) {
      newest.set(c.threadId, Math.max(newest.get(c.threadId) ?? c.dateMs, c.dateMs));
    }
  }
  let best: string | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const [threadId, ms] of newest) {
    if (!wrote.has(threadId)) continue;
    if (ms > bestMs || (ms === bestMs && best !== undefined && threadId < best)) {
      best = threadId;
      bestMs = ms;
    }
  }
  return best;
}
