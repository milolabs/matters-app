// The thread on paper (ADR 0144, rule 2), as pure functions: what each letter says, and the nodes
// of the print page. Everything here but the HTML of a message is text, and the page puts it in as
// text; the HTML is sanitized again in the page and goes into a sandboxed frame like the reader's,
// never among these nodes.
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

/** What the HTML of one letter brings: its HTML and what the reader decided. */
export interface LetterHtml {
  /** `sanitizeMail` output in the mail window; the print page sanitizes it again (rule 4). */
  readonly html: string;
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
  // Whether the letter asks for images at all is known once the page has sanitized it: the words
  // go with every letter whose images are not shown, and the page prints them only then.
  const blocked = html !== null && !html.images;
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
        : { kind: "html", html: html.html, images: html.images },
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

/** The page of our own that a frame of letter `index` loads, as the reader's frame does (ADR 0024). */
export const framePage = (images: boolean) => (images ? "./mail-images.html" : "./mail.html");

/** The frames' sandbox: the reader's (`MAIL_FRAME_SANDBOX`), no `allow-scripts`. */
export const PRINT_FRAME_SANDBOX = "allow-same-origin";

/** The elements of the print page; nothing else is ever made. */
export type PrintTag = "h1" | "article" | "dl" | "div" | "dt" | "dd" | "p" | "ul" | "li";

/**
 * A node of the print page as data. The page makes each with `createElement`, sets its class and
 * its label, and puts `text` in as text; a frame's attributes are the page's own constants.
 */
export type PrintNode =
  | {
      readonly tag: PrintTag;
      readonly className?: string;
      readonly label?: string;
      readonly text?: string;
      readonly children?: readonly PrintNode[];
    }
  /** The sandboxed frame of letter `frame`, of `mail.html` or `mail-images.html` (`framePage`). */
  | { readonly tag: "iframe"; readonly frame: number; readonly images: boolean };

const row = (label: string, value: string): PrintNode[] =>
  value === ""
    ? []
    : [
        {
          tag: "div",
          children: [
            { tag: "dt", text: label },
            { tag: "dd", text: value },
          ],
        },
      ];

/**
 * The print page: a title, then each letter's header, its body, and its files. Only text and our
 * own elements; a letter with HTML gets an empty sandboxed frame that the page fills, as the reader
 * does. No style attribute, no script: the page's policy allows neither. `asksForImages(index)`
 * says whether letter `index`, sanitized in the page, asks for images from the network: only then
 * is its line about blocked images printed.
 */
export function printNodes(
  doc: PrintDocument,
  asksForImages: (index: number) => boolean,
): PrintNode[] {
  const letters = doc.letters.map((l, index): PrintNode => {
    const head: PrintNode = {
      tag: "dl",
      className: "head",
      children: [
        ...row("From", l.from),
        ...row("To", l.to),
        ...row("Cc", l.cc),
        ...row("Date", l.date),
        ...row("Subject", l.subject),
      ],
    };
    const badge: PrintNode[] =
      l.badge === "" ? [] : [{ tag: "p", className: "badge", text: l.badge }];
    const held = l.note !== "" && l.body.kind === "html" && asksForImages(index);
    const note: PrintNode[] = held ? [{ tag: "p", className: "note", text: l.note }] : [];
    const body: PrintNode =
      l.body.kind === "html"
        ? {
            tag: "div",
            className: "mail",
            children: [{ tag: "iframe", frame: index, images: l.body.images }],
          }
        : {
            tag: "div",
            className: "words",
            children:
              l.body.parts.length === 0
                ? [{ tag: "p", className: "folded", text: "No text." }]
                : l.body.parts.map(
                    (p): PrintNode => ({ tag: "p", className: p.kind, text: p.text }),
                  ),
          };
    const files: PrintNode[] =
      l.attachments.length === 0
        ? []
        : [
            {
              tag: "ul",
              className: "files",
              label: "Attachments",
              children: l.attachments.map((a): PrintNode => ({ tag: "li", text: a })),
            },
          ];
    return {
      tag: "article",
      className: "letter",
      children: [head, ...badge, ...note, body, ...files],
    };
  });
  return [{ tag: "h1", text: doc.title }, ...letters];
}
