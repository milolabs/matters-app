// The thread on paper (ADR 0144, rule 2), as pure functions: what each letter says, and the markup
// of the print page. Everything here but the sanitized HTML of a message is text, and goes into the
// markup escaped; the HTML goes into a sandboxed frame like the reader's, never into this markup.
import type { PrintDocument, PrintLetter, PrintTextPart, ThreadMessage } from "@matters/contracts";
import type { ImageChoice, Participant } from "@matters/core";
import { SHORT_SIGNATURE_LINES, splitBody, splitSignature } from "./body.ts";
import { displayName, fileSize, fullDate, isReallyOwn } from "./format.ts";
import { barKind, imageCopy } from "./imageBar.ts";
import type { CleanMail } from "./mailHtml.ts";
import { mailView } from "./mailTheme.ts";
import { type Counterpart, failedBadge, verifiedBadge } from "./senderHeader.ts";

/** A person as text on paper: the name the reader shows, and always the address. */
export function personText(p: Participant): string {
  const shown = displayName(p);
  if (shown === p.address || shown.includes(`<${p.address}>`)) return shown;
  return `${shown} <${p.address}>`;
}

/**
 * A plain body as the reader shows it before anything is unfolded: the words, a short signature
 * under them, and a named line for each quote and long signature, which are not printed.
 */
export function printTextParts(text: string): PrintTextPart[] {
  const parts: PrintTextPart[] = [];
  for (const segment of splitBody(text)) {
    if (segment.quoted) {
      parts.push({
        kind: "folded",
        text: `Quoted text · ${segment.lines} ${segment.lines === 1 ? "line" : "lines"}, not printed`,
      });
      continue;
    }
    const split = splitSignature(segment.text);
    if (split.body !== "") parts.push({ kind: "text", text: split.body });
    if (split.signature !== undefined) {
      parts.push(
        split.lines <= SHORT_SIGNATURE_LINES
          ? { kind: "signature", text: split.signature }
          : { kind: "folded", text: "Signature, not printed" },
      );
    }
  }
  return parts;
}

/** The light view of a sanitized message: what the reader's frame shows in the light theme. */
export function lightHtml(clean: Pick<CleanMail, "html" | "theme">): string {
  return mailView(clean, false).html;
}

/** What the HTML of one letter brings: its sanitized markup and what the reader decided. */
export interface LetterHtml {
  readonly clean: Pick<CleanMail, "html" | "theme" | "hasRemoteContent">;
  /** The reader shows its images: allowed by a rule, or by Show images while it is open. */
  readonly images: boolean;
  /** What the rules decided, for the words of the blocked state; null when not known. */
  readonly choice: ImageChoice | null;
}

/**
 * One letter: who, to whom, when and what, as text; the body as the reader shows it (`html`, or the
 * text when the message has none or the reader shows its Text view); the files by name and size.
 */
export function printLetter(
  m: ThreadMessage,
  own: ReadonlySet<string>,
  html: LetterHtml | null,
): PrintLetter {
  const fromIsOwn = own.has(m.from.address.toLowerCase()) && isReallyOwn(m);
  const sender: Counterpart = {
    person: m.from,
    role: fromIsOwn ? "self" : "sender",
    verified: m.senderAuth === "pass",
    failed: m.senderAuth === "fail",
  };
  const choice = html?.choice ?? null;
  const blocked = html?.clean.hasRemoteContent === true && !html.images;
  const kind = blocked && choice !== null ? barKind(choice) : "ask";
  const note = !blocked
    ? ""
    : kind === "denied" && choice !== null
      ? imageCopy.denied((choice.source === "domain-deny" ? choice.domain : null) ?? choice.address)
      : kind === "unverified"
        ? imageCopy.unverified
        : imageCopy.off;
  const attachments = m.attachmentsKnown
    ? m.attachments.filter((a) => !a.inline).map((a) => `${a.name} · ${fileSize(a.size)}`)
    : m.hasAttachments
      ? ["Attachment"]
      : [];
  return {
    from: personText(m.from),
    to: m.to.map(personText).join(", "),
    cc: m.cc.map(personText).join(", "),
    date: fullDate(m.dateMs),
    subject: m.subject || "(no subject)",
    badge: failedBadge(sender) ?? verifiedBadge(sender) ?? "",
    note,
    body:
      html === null
        ? { kind: "text", parts: printTextParts(m.bodyText) }
        : { kind: "html", html: lightHtml(html.clean), images: html.images },
    attachments,
  };
}

/** `2026-11-16`: the day of `ms` in the person's time, for the file's name. */
export function printDay(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

/** The whole thread, in order, every letter (ADR 0144, rule 2). */
export function printDocument(
  subject: string,
  messages: readonly ThreadMessage[],
  letters: readonly PrintLetter[],
): PrintDocument {
  const newest = messages.reduce((n, m) => Math.max(n, m.dateMs), 0);
  return { title: subject || "(no subject)", day: newest > 0 ? printDay(newest) : "", letters };
}

const ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Text for markup: every character that could start or end markup, written as a reference. */
export function escapeText(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

const row = (label: string, value: string) =>
  value === "" ? "" : `<div><dt>${label}</dt><dd>${escapeText(value)}</dd></div>`;

/** The page of our own that a frame of letter `index` loads, as the reader's frame does (ADR 0024). */
export const framePage = (images: boolean) => (images ? "./mail-images.html" : "./mail.html");

/** The frames' sandbox: the reader's (`MAIL_FRAME_SANDBOX`), no `allow-scripts`. */
export const PRINT_FRAME_SANDBOX = "allow-same-origin";

/**
 * The print page's markup: a title, then each letter's header as text, its body, and its files.
 * Only escaped text and our own elements; a letter with HTML gets an empty sandboxed frame of
 * `mail.html` (or `mail-images.html`) that the page fills, as the reader does. No style attribute,
 * no script: the page's policy allows neither.
 */
export function printMarkup(doc: PrintDocument): string {
  const letters = doc.letters.map((l, index) => {
    const head = [
      row("From", l.from),
      row("To", l.to),
      row("Cc", l.cc),
      row("Date", l.date),
      row("Subject", l.subject),
    ].join("");
    const badge = l.badge === "" ? "" : `<p class="badge">${escapeText(l.badge)}</p>`;
    const note = l.note === "" ? "" : `<p class="note">${escapeText(l.note)}</p>`;
    const body =
      l.body.kind === "html"
        ? `<div class="mail"><iframe data-print-frame="${index}" title="Message as sent" sandbox="${PRINT_FRAME_SANDBOX}" src="${framePage(l.body.images)}"></iframe></div>`
        : `<div class="words">${
            l.body.parts.length === 0
              ? `<p class="folded">No text.</p>`
              : l.body.parts.map((p) => `<p class="${p.kind}">${escapeText(p.text)}</p>`).join("")
          }</div>`;
    const files =
      l.attachments.length === 0
        ? ""
        : `<ul class="files" aria-label="Attachments">${l.attachments
            .map((a) => `<li>${escapeText(a)}</li>`)
            .join("")}</ul>`;
    return `<article class="letter"><dl class="head">${head}</dl>${badge}${note}${body}${files}</article>`;
  });
  return `<h1>${escapeText(doc.title)}</h1>${letters.join("")}`;
}
