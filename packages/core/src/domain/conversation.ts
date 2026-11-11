/**
 * One conversation in many threads (ADR 0081). Mail clients and servers split a conversation
 * when a header is lost or a subject is edited, so a search finds nine fragments of two or three
 * messages where the person remembers one thread. Fragments of one account that carry the same
 * subject (after the prefixes of replies and forwards) and share a person are one conversation,
 * represented by its longest thread. Pure.
 */
import { foldText } from "./text.ts";

/** The words a mail program puts in front of the subject of a reply, folded. */
const ANSWER_WORDS = ["re", "odp", "aw", "sv", "vs"];
/** The words it puts in front of the subject of a forward, folded. */
const FORWARD_WORDS = ["fwd", "fw", "pd", "wg"];

/** A prefix made of one of `words`, with an optional counter (`Re[2]:`), on a folded subject. */
const prefixOf = (words: readonly string[]) =>
  new RegExp(`^\\s*(?:${words.join("|")})(?:\\s*\\[\\d+\\])?\\s*:\\s*`);

/** A prefix a mail program puts in front of a subject, in the languages mail is likely written in. */
const REPLY_PREFIX = prefixOf([...ANSWER_WORDS, ...FORWARD_WORDS]);
/** A prefix of a reply only, not of a forward. */
const ANSWER_PREFIX = prefixOf(ANSWER_WORDS);

/** Whether the subject starts with the prefix of a reply (`Re:`, `Odp:`, `AW:`, `Re[2]:`), any case; a forward is not one. */
export function isReplySubject(subject: string): boolean {
  return ANSWER_PREFIX.test(foldText(subject));
}

/** The subject without `Re:`, `Fwd:`, `Odp:`, `PD:`, `AW:`, `WG:` and the like, however often repeated; folded. */
export function normalizeSubject(subject: string): string {
  let s = foldText(subject);
  for (let i = 0; i < 20; i++) {
    const next = s.replace(REPLY_PREFIX, "");
    if (next === s) break;
    s = next;
  }
  return s.replace(/\s+/g, " ").trim();
}

export interface ConversationPart {
  readonly threadId: string;
  readonly accountId: string;
  readonly subject: string;
  /** Addresses of the people on the thread (from, to and cc), any case. */
  readonly participants: readonly string[];
  readonly messages: number;
}

/**
 * For each thread, the thread that stands for its conversation: itself when it has no fragment
 * beside it, otherwise the longest of the fragments (more messages; then the smaller id). Two
 * threads are fragments of one conversation when they are in the same account, their subjects are
 * equal once normalised and not empty, and, directly or through a third, they share an address.
 * `ignore` holds addresses that say nothing (the person's own).
 */
export function consolidateConversations(
  parts: readonly ConversationPart[],
  ignore: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const groups = new Map<string, ConversationPart[]>();
  for (const part of parts) {
    const subject = normalizeSubject(part.subject);
    if (subject === "") continue;
    const key = `${part.accountId}\u0000${subject}`;
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [part]);
    else group.push(part);
  }
  const out = new Map(parts.map((p) => [p.threadId, p.threadId]));
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const parent = group.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root] as number;
      parent[i] = root;
      return root;
    };
    const owner = new Map<string, number>();
    for (const [i, part] of group.entries()) {
      for (const raw of part.participants) {
        const address = raw.trim().toLowerCase();
        if (address === "" || ignore.has(address)) continue;
        const known = owner.get(address);
        if (known === undefined) owner.set(address, i);
        else parent[find(i)] = find(known);
      }
    }
    const best = new Map<number, ConversationPart>();
    for (const [i, part] of group.entries()) {
      const root = find(i);
      const have = best.get(root);
      if (
        have === undefined ||
        part.messages > have.messages ||
        (part.messages === have.messages && part.threadId < have.threadId)
      ) {
        best.set(root, part);
      }
    }
    for (const [i, part] of group.entries()) {
      out.set(part.threadId, (best.get(find(i)) as ConversationPart).threadId);
    }
  }
  return out;
}
