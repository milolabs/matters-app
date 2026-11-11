// A large synthetic mailbox as RFC 822 text, for tools/smoke-desktop-sync.ts: the seed's Polish
// threads with quoted replies, turned into messages a mail server can hold.

import { generateMailbox, ME } from "../apps/desktop/src/backend/seed.ts";
import type { MessageDocument } from "../packages/core/src/index.ts";

export interface CorpusMessage {
  readonly folder: "INBOX" | "Sent";
  readonly raw: string;
  readonly flags: string[];
}

const b64 = (text: string) => `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
const address = (p: { name?: string; address: string }) =>
  p.name ? `${b64(p.name)} <${p.address}>` : p.address;

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// What a newsletter or a corporate mail carries around its few sentences.
const HTML_STYLE = `<style>body{margin:0;padding:0;font-family:Arial,Helvetica,sans-serif;color:#222}
table{border-collapse:collapse}td{padding:0;vertical-align:top}.wrap{width:600px;background:#fff}
.hdr{background:#0b5cad;color:#fff;font-size:18px;padding:16px 24px}.ftr{font-size:11px;color:#888;padding:16px 24px}
a{color:#0b5cad;text-decoration:none}blockquote{border-left:3px solid #ccc;margin:8px 0;padding-left:12px;color:#666}
${".row{margin:0;padding:4px 0}\n".repeat(60)}</style>`;

/** The text body as a typical HTML-only message: layout tables, inline styles, a footer. */
function htmlBody(text: string): string {
  const paragraphs = text
    .split("\n\n")
    .map((p) =>
      p.startsWith(">")
        ? `<blockquote>${escapeHtml(p.replace(/^> ?/gm, "")).replace(/\n/g, "<br>")}</blockquote>`
        : `<p style="margin:0 0 12px;font-size:14px;line-height:20px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`,
    )
    .join("\n");
  const footer =
    "Wiadomość wysłana automatycznie. Aby zrezygnować z powiadomień, zmień ustawienia konta. ".repeat(
      6,
    );
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${HTML_STYLE}</head><body>
<table class="wrap" width="600" cellpadding="0" cellspacing="0"><tr><td class="hdr">Matters</td></tr>
<tr><td style="padding:24px">${paragraphs}</td></tr><tr><td class="ftr">${footer}</td></tr></table></body></html>`;
}

export function toRaw(
  doc: MessageDocument,
  inReplyTo?: string,
  references?: string,
  html = false,
): string {
  const m = doc.message;
  const headers = [
    `From: ${address(m.from)}`,
    `To: ${m.to.map(address).join(", ")}`,
    `Subject: ${b64(m.subject)}`,
    `Date: ${new Date(m.dateMs).toUTCString()}`,
    `Message-ID: ${m.messageIdHeader}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references ? [`References: ${references}`] : []),
    "MIME-Version: 1.0",
    `Content-Type: ${html ? "text/html" : "text/plain"}; charset=utf-8`,
    "Content-Transfer-Encoding: 8bit",
  ];
  const body = html ? htmlBody(doc.bodyText) : doc.bodyText;
  return `${headers.join("\r\n")}\r\n\r\n${body.replace(/\r?\n/g, "\r\n")}\r\n`;
}

/** `count` messages, oldest first so that the newest get the highest UIDs. */
export function buildCorpus(count: number): CorpusMessage[] {
  const docs = generateMailbox({ messages: count, threads: Math.round(count / 4) });
  const rawOf = new Map<MessageDocument, string>();
  const roots = new Map<string, string>();
  docs.forEach((doc, i) => {
    const m = doc.message;
    const previous = docs[i - 1];
    const reply = previous !== undefined && previous.message.threadId === m.threadId;
    if (!reply) roots.set(m.threadId, m.messageIdHeader);
    rawOf.set(
      doc,
      toRaw(
        doc,
        reply ? previous.message.messageIdHeader : undefined,
        reply ? roots.get(m.threadId) : undefined,
      ),
    );
  });
  return [...docs]
    .sort((a, b) => a.message.dateMs - b.message.dateMs)
    .map((doc) => ({
      folder: doc.message.from.address === ME.address ? ("Sent" as const) : ("INBOX" as const),
      raw: rawOf.get(doc) as string,
      flags: [
        ...(doc.message.flags.seen ? ["\\Seen"] : []),
        ...(doc.message.flags.flagged ? ["\\Flagged"] : []),
      ],
    }));
}

/** Mail that "arrives" while the app runs. */
export function liveMessage(n: number): string {
  const now = Date.now();
  const doc: MessageDocument = {
    message: {
      key: 0,
      accountId: "x",
      providerId: `live-${n}`,
      threadId: `live-${n}`,
      messageIdHeader: `<live-${n}-${now}@smoke.example>`,
      dateMs: now + n,
      from: { name: "Zażółć Gęślą", address: "zyczliwy@example.pl" },
      to: [ME],
      cc: [],
      subject: `Na żywo ${n}`,
      snippet: "",
      flags: { seen: false, flagged: false, answered: false, draft: false },
      labelIds: [],
      hasAttachments: false,
      senderAuth: "unknown",
    },
    bodyText: "Wiadomość dostarczona, gdy aplikacja już działa.",
  };
  return toRaw(doc);
}
