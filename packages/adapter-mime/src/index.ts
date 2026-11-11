import type {
  MimeParserPort,
  ParseContext,
  ParsedAttachment,
  ParsedMessage,
  Participant,
} from "@matters/core";
import { isAutomatedByBody, isAutomatedByHeaders, normalizeReplyTo } from "@matters/core";
import PostalMime, { type Address, type Attachment, addressParser } from "postal-mime";
import { classifyHtml } from "./classifyHtml.ts";
import { htmlToText } from "./htmlToText.ts";
import { firstTrustedHeader, type RegistrableDomain, readSenderAuth } from "./senderAuth.ts";

export { classifyHtml } from "./classifyHtml.ts";
export { htmlToText, visibleText } from "./htmlToText.ts";
export {
  authservId,
  firstTrustedHeader,
  type RegistrableDomain,
  readSenderAuth,
} from "./senderAuth.ts";

function participants(list: readonly Address[] | Address | undefined): Participant[] {
  if (!list) return [];
  const flat = (Array.isArray(list) ? list : [list]).flatMap((a) =>
    a.group ? a.group : a.address ? [a] : [],
  );
  return flat
    .filter((a) => a.address)
    .map((a) => (a.name ? { name: a.name, address: a.address } : { address: a.address }));
}

const MESSAGE_ID = /<[^<>\s]+>/g;

function firstId(value: string | undefined): string {
  const raw = (value ?? "").trim();
  return raw.match(MESSAGE_ID)?.[0] ?? raw;
}

function byteLength(content: ArrayBuffer | Uint8Array | string): number {
  return typeof content === "string" ? Buffer.byteLength(content) : content.byteLength;
}

function attachment(a: Attachment): ParsedAttachment {
  return {
    ...(a.filename ? { filename: a.filename } : {}),
    mimeType: a.mimeType,
    size: byteLength(a.content),
    ...(a.contentId ? { contentId: a.contentId } : {}),
    inline: a.related === true,
  };
}

/** Inline images travel with the message, so showing them tells the sender nothing. */
const EMBEDDABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MAX_EMBEDDED_BYTES = 512 * 1024;

function embedInlineImages(html: string, attachments: readonly Attachment[]): string {
  let out = html;
  for (const a of attachments) {
    const id = a.contentId?.replace(/^<|>$/g, "");
    if (!id || typeof a.content === "string" || !EMBEDDABLE.has(a.mimeType.toLowerCase())) continue;
    if (a.content.byteLength > MAX_EMBEDDED_BYTES) continue;
    const base64 = Buffer.from(new Uint8Array(a.content as ArrayBuffer)).toString("base64");
    out = out.replaceAll(`cid:${id}`, `data:${a.mimeType.toLowerCase()};base64,${base64}`);
  }
  return out;
}

/** The one address of the `From` header; none when there are several headers or addresses. */
function onlyFromAddress(headers: readonly { key: string; value: string }[]): string | undefined {
  const values = headers.filter((h) => h.key.toLowerCase() === "from");
  const [only] = values;
  if (!only || values.length !== 1) return undefined;
  const listed = addressParser(only.value);
  const [one] = listed;
  return listed.length === 1 && one && !one.group && one.address ? one.address : undefined;
}

/** Without a public suffix list only the very same host counts as aligned. */
const SAME_HOST: RegistrableDomain = (host) => host;

export interface PostalMimeParserOptions {
  /** How DKIM alignment compares domains; the composition root passes one backed by the Public Suffix List. */
  readonly registrableDomain?: RegistrableDomain;
}

export { isAutomatedByHeaders };

/** Some senders put their HTML in the text part. */
const LOOKS_LIKE_HTML = /^\s*(?:<!doctype\s+html|<html[\s>])/i;

/** What the reader sees in place of a message the parser could not read. */
export const UNREADABLE_NOTICE =
  "Matters could not read this message: it is larger or more complicated than the parser accepts. It is still on your server.";

/** No header was read, so the sync falls back to what the server's ENVELOPE says. */
function unreadable(): ParsedMessage {
  return {
    subject: "",
    to: [],
    cc: [],
    replyTo: [],
    messageId: "",
    inReplyTo: "",
    references: [],
    text: UNREADABLE_NOTICE,
    attachments: [],
    senderAuth: "unknown",
  };
}

export class PostalMimeParser implements MimeParserPort {
  private readonly registrable: RegistrableDomain;

  constructor(options: PostalMimeParserOptions = {}) {
    this.registrable = options.registrableDomain ?? SAME_HOST;
  }

  /**
   * Never throws because of the message's bytes (see `MimeParserPort`). Every failure is turned
   * into the notice, including a programming error in this function: telling the two apart
   * cheaply is not possible, and the adapter does no logging. Tests of the parser catch the
   * second kind.
   */
  async parse(raw: Uint8Array, context: ParseContext = {}): Promise<ParsedMessage> {
    try {
      return await this.read(raw, context);
    } catch {
      return unreadable();
    }
  }

  private async read(raw: Uint8Array, context: ParseContext): Promise<ParsedMessage> {
    const email = await PostalMime.parse(raw);
    const [from] = participants(email.from);
    const dateMs = email.date ? Date.parse(email.date) : Number.NaN;
    const rawText = email.text?.replace(/\r\n?/g, "\n").trim() ?? "";
    const textIsHtml = LOOKS_LIKE_HTML.test(rawText);
    const plain = textIsHtml ? "" : rawText;
    const sourceHtml = email.html?.trim() ? email.html : textIsHtml ? rawText : undefined;
    const html = sourceHtml && embedInlineImages(sourceHtml, email.attachments);
    const headerNames = new Set(email.headers.map((h) => h.key.toLowerCase()));
    // Only a header whose authserv-id the account trusts, the topmost of those (ADR 0048).
    const authResults = firstTrustedHeader(
      email.headers
        .filter((h) => h.key.toLowerCase() === "authentication-results")
        .map((h) => h.value),
      context.isTrustedAuthServ,
    );
    const subject = email.subject ?? "";
    const text = plain !== "" ? plain : sourceHtml ? htmlToText(sourceHtml) : "";
    return {
      subject,
      ...(from ? { from } : {}),
      to: participants(email.to),
      cc: participants(email.cc),
      replyTo: normalizeReplyTo(participants(email.replyTo), from),
      ...(Number.isNaN(dateMs) ? {} : { dateMs }),
      messageId: (email.messageId ?? "").trim(),
      inReplyTo: firstId(email.inReplyTo),
      references: (email.references ?? "").match(MESSAGE_ID) ?? [],
      text,
      ...(html ? { html, htmlKind: classifyHtml(html, headerNames) } : {}),
      attachments: email.attachments.map(attachment),
      senderAuth: readSenderAuth(authResults, onlyFromAddress(email.headers), this.registrable),
      // ADR 0111: bulk mail without the list headers still says so at its foot.
      automated: isAutomatedByHeaders(email.headers) || isAutomatedByBody(text, subject),
    };
  }
}
