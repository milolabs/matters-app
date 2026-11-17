// What crosses between main and a page about `mailto:` links and the default mail app (ADR 0143).
// The preload reads main's answers through these before a page sees them, as every bridge does;
// kept apart from mailtoLinks.ts so the preload does not carry the rules of core.
import type { DefaultMailInfo, MailtoPrefill } from "@matters/contracts";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
// Core's limits written out (`parseMailto` keeps 50 recipients and a subject of 998; a body of
// 20 000 may double when escaped): the preload checks the shape of what crosses, not the rules.
const MAX_RECIPIENTS = 50;
const MAX_SUBJECT = 998;
const MAX_BODY = 40_000;
const isAddresses = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= MAX_RECIPIENTS &&
  v.every((a) => typeof a === "string" && a.length <= 254);

/** A link as it crosses to the page; null for anything else. The preload reads main's answer. */
export function readMailtoPrefill(v: unknown): MailtoPrefill | null {
  if (!isRecord(v)) return null;
  const { to, cc, bcc, subject, body } = v;
  if (!isAddresses(to) || !isAddresses(cc) || !isAddresses(bcc)) return null;
  if (to.length + cc.length + bcc.length > MAX_RECIPIENTS) return null;
  if (typeof subject !== "string" || subject.length > MAX_SUBJECT) return null;
  if (typeof body !== "string" || body.length > MAX_BODY) return null;
  return { to: [...to], cc: [...cc], bcc: [...bcc], subject, body };
}

/** What main says about the default mail app, as it crosses to the page; null for anything else. */
export function readDefaultMailInfo(v: unknown): DefaultMailInfo | null {
  if (!isRecord(v) || typeof v.offered !== "boolean" || typeof v.isDefault !== "boolean") {
    return null;
  }
  return { offered: v.offered, isDefault: v.offered && v.isDefault };
}

/** The id main gives a waiting link: its shape only; main alone knows which ids it gave. */
export function readLinkId(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= 100 ? v : null;
}

/** The first link that waits, with its id, as it crosses to the page; null for anything else. */
export function readWaitingLink(v: unknown): { id: string; link: MailtoPrefill } | null {
  if (!isRecord(v)) return null;
  const id = readLinkId(v.id);
  const link = readMailtoPrefill(v.link);
  return id === null || link === null ? null : { id, link };
}

/** How many links main says still wait; 0 for anything else. */
export function readWaitingCount(v: unknown): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 100 ? v : 0;
}
