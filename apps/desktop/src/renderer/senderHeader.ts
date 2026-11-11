import type { Participant, SenderAuth } from "@matters/core";
import { displayName, isReallyOwn } from "./format.ts";
import { type PersonMark, personMark } from "./personMark.ts";

/** The part of a message the header reads. */
export interface HeadMessage {
  readonly from: Participant;
  readonly to: readonly Participant[];
  readonly cc: readonly Participant[];
  readonly senderAuth: SenderAuth;
  readonly mailboxes?: number;
}

/**
 * Who the header of a thread shows (ADR 0078): the other side of the conversation.
 *
 * - `sender`: the sender of the newest message that is not the person's own.
 * - `recipient`: every message is the person's own, so the first person they wrote to.
 * - `self`: the person wrote to nobody else; the header shows them.
 *
 * A message counts as the person's own by the rule of ADR 0048: their address and either the
 * server's word for it or a Sent or Drafts folder.
 */
export interface Counterpart {
  readonly person: Participant;
  readonly role: "sender" | "recipient" | "self";
  /** The server verified the sender of the message the person was taken from (ADR 0048). */
  readonly verified: boolean;
  /** The authentication result says this sender is not who they claim (ADR 0048: `fail`). */
  readonly failed: boolean;
}

export function counterpart(
  messages: readonly HeadMessage[],
  own: ReadonlySet<string>,
): Counterpart | undefined {
  const isOwn = (p: Participant) => own.has(p.address.toLowerCase());
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m !== undefined && !(isOwn(m.from) && isReallyOwn(m))) {
      return {
        person: m.from,
        role: "sender",
        verified: m.senderAuth === "pass",
        failed: m.senderAuth === "fail",
      };
    }
  }
  for (const m of messages) {
    for (const p of [...m.to, ...m.cc]) {
      if (p.address.trim() !== "" && !isOwn(p)) {
        return { person: p, role: "recipient", verified: false, failed: false };
      }
    }
  }
  const first = messages[0];
  return first === undefined
    ? undefined
    : { person: first.from, role: "self", verified: false, failed: false };
}

/** The domain after the `@`, lower case; null when the address has none. */
export function addressDomain(address: string): string | null {
  const at = address.lastIndexOf("@");
  const host =
    at < 0
      ? ""
      : address
          .slice(at + 1)
          .trim()
          .toLowerCase();
  return host === "" ? null : host;
}

/**
 * The verified badge (ADR 0078): "Verified · domain", only when the server's authentication
 * result for this sender is a pass (`senderAuth`, the verdict that ADR 0048 and the image bar
 * already use). Never for a recipient, and never from anything else: no result, no badge.
 */
export function verifiedBadge(c: Counterpart): string | null {
  if (c.role !== "sender" || !c.verified) return null;
  const domain = addressDomain(c.person.address);
  return domain === null ? null : `Verified · ${domain}`;
}

/**
 * The warning badge (ADR 0079): "Not verified · domain" when the authentication result for this
 * sender is a fail. No result at all is common and says nothing, so it shows nothing; only a fail
 * is a claim that the name and the address may not be who they say.
 */
export function failedBadge(c: Counterpart): string | null {
  if (c.role !== "sender" || !c.failed) return null;
  const domain = addressDomain(c.person.address);
  return domain === null ? "Not verified" : `Not verified · ${domain}`;
}

/**
 * Who a row of the list shows (ADR 0078): the sender, or for the person's own mail the first person
 * it went to with an arrow before the name, the same person the reader's header shows. Mail with
 * nobody else in it shows the person.
 */
export function rowPerson(
  m: HeadMessage,
  own: ReadonlySet<string>,
): { readonly name: string; readonly mark: PersonMark } {
  if (own.has(m.from.address.toLowerCase()) && isReallyOwn(m)) {
    for (const p of [...m.to, ...m.cc]) {
      if (p.address.trim() !== "" && !own.has(p.address.toLowerCase())) {
        return { name: `→ ${displayName(p)}`, mark: personMark(p.address, p.name) };
      }
    }
  }
  return { name: displayName(m.from), mark: personMark(m.from.address, m.from.name) };
}
