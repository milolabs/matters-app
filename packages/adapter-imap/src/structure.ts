import type { ReceivedAttachment } from "@matters/core";
import { nameFromType, safeFileName } from "@matters/core";
import type { MessageStructureObject } from "imapflow";

/**
 * The files of a message, from the `BODYSTRUCTURE` the server sent (ADR 0043, rules 1 to 3). Pure:
 * no network and no source, which is why it works for mail stored long ago.
 *
 * A leaf is a file unless it is the message's text or HTML body. Such a leaf is inline, and not
 * listed, when it has a Content-ID inside `multipart/related` (a logo the HTML points at).
 * `message/rfc822` is one file and is not walked into. A file with no name is named from its type.
 * Order is the order in the message, and every file is returned, inline ones too.
 */
export function attachmentsOf(root: MessageStructureObject): ReceivedAttachment[] {
  const out: ReceivedAttachment[] = [];
  walk(root, false, out);
  return out;
}

function walk(node: MessageStructureObject, related: boolean, out: ReceivedAttachment[]): void {
  const type = node.type.toLowerCase();
  if (node.childNodes && type !== "message/rfc822") {
    const inRelated = related || type === "multipart/related";
    for (const child of node.childNodes) walk(child, inRelated, out);
    return;
  }
  if (isBody(node)) return;
  out.push(describe(node, related));
}

/** Text a person reads as the letter: plain or HTML, not offered as a file and without a name. */
function isBody(node: MessageStructureObject): boolean {
  if (node.disposition?.toLowerCase() === "attachment") return false;
  if (fileNameOf(node) !== undefined) return false;
  const type = node.type.toLowerCase();
  return type === "text/plain" || type === "text/html" || type === "text/x-amp-html";
}

function fileNameOf(node: MessageStructureObject): string | undefined {
  const name = node.dispositionParameters?.filename ?? node.parameters?.name;
  return name === undefined || name.trim() === "" ? undefined : name;
}

function describe(node: MessageStructureObject, related: boolean): ReceivedAttachment {
  const mimeType = node.type.toLowerCase();
  const contentId = node.id?.trim().replace(/^<|>$/g, "");
  return {
    // A message that is one part has none: IMAP calls it 1.
    partId: node.part ?? "1",
    name: safeFileName(fileNameOf(node) ?? "", nameFromType(mimeType)),
    mimeType,
    size: decodedSize(node.size ?? 0, node.encoding),
    inline: related && contentId !== undefined && contentId !== "",
    ...(contentId === undefined || contentId === "" ? {} : { contentId }),
  };
}

/**
 * Base64 carries 57 bytes in each 78 of a line (76 characters and a line break), so the part
 * decodes to about three quarters of what the server counted. Other encodings are close enough to
 * their size: the figure is an estimate, and a person sees it rounded.
 */
export function decodedSize(encoded: number, encoding: string | undefined): number {
  if (encoding?.toLowerCase() === "base64") return Math.floor((encoded * 57) / 78);
  return encoded;
}
