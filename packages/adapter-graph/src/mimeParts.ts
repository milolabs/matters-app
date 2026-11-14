import type { ReceivedAttachment } from "@matters/core";
import { nameFromType, safeFileName } from "@matters/core";

/**
 * The parts of a raw message, numbered as IMAP numbers them (RFC 3501, section 6.4.5), so that a
 * Graph message names its files with the part ids every other account uses (ADR 0136, rule 8).
 * Only the structure is read: headers, boundaries, and the transfer encoding of the one part a
 * download asks for. Text, charsets and HTML are the parser's.
 */
export interface MimePart {
  /** `1`, `2.1`; a message of one part is `1`, the top of a multipart message is empty. */
  readonly partId: string;
  /** Lower case, `text/plain` when the header is missing. */
  readonly type: string;
  readonly params: ReadonlyMap<string, string>;
  readonly disposition?: string;
  readonly dispositionParams: ReadonlyMap<string, string>;
  readonly contentId?: string;
  readonly encoding?: string;
  /** Where the body is in the raw message. */
  readonly start: number;
  readonly end: number;
  readonly children: readonly MimePart[];
}

const latin1 = (bytes: Uint8Array, start = 0, end = bytes.length) =>
  Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1", start, end);

/** Where the header block ends (after its blank line) and the body starts. */
function bodyStart(raw: Uint8Array, from: number, to: number): { headerEnd: number; body: number } {
  const text = latin1(raw, from, to);
  const crlf = text.indexOf("\r\n\r\n");
  const lf = text.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return { headerEnd: from + crlf, body: from + crlf + 4 };
  if (lf >= 0) return { headerEnd: from + lf, body: from + lf + 2 };
  // A blank first line: no headers at all.
  if (text.startsWith("\r\n")) return { headerEnd: from, body: from + 2 };
  if (text.startsWith("\n")) return { headerEnd: from, body: from + 1 };
  return { headerEnd: to, body: to };
}

/** `Name: value` pairs of a header block, folded lines joined; names in lower case. */
export function headersOf(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of block.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    // The first header of a name counts, as it does for the parser.
    if (!out.has(name)) out.set(name, line.slice(colon + 1).trim());
  }
  return out;
}

/** A header value and its parameters, RFC 2231 continuations and charsets joined and decoded. */
export function valueAndParams(raw: string): { value: string; params: Map<string, string> } {
  const parts = splitParams(raw);
  const value = (parts.shift() ?? "").trim().toLowerCase();
  const plain = new Map<string, string>();
  const extended = new Map<string, { index: number; encoded: boolean; text: string }[]>();
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let text = part.slice(eq + 1).trim();
    if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
      text = text.slice(1, -1).replace(/\\(.)/g, "$1");
    }
    const match = /^([^*]+)\*(?:(\d+)\*?)?$/.exec(key);
    const encoded = key.endsWith("*");
    if (match?.[1] !== undefined) {
      const name = match[1];
      const list = extended.get(name) ?? [];
      list.push({ index: match[2] === undefined ? 0 : Number(match[2]), encoded, text });
      extended.set(name, list);
    } else {
      plain.set(key, decodeWords(text));
    }
  }
  for (const [name, list] of extended) {
    list.sort((a, b) => a.index - b.index);
    let charset = "utf-8";
    const bytes: number[] = [];
    for (const [i, piece] of list.entries()) {
      let text = piece.text;
      if (piece.encoded && i === 0) {
        const quote = /^([^']*)'[^']*'(.*)$/.exec(text);
        if (quote) {
          charset = quote[1] || "utf-8";
          text = quote[2] ?? "";
        }
      }
      if (piece.encoded) {
        for (let j = 0; j < text.length; j++) {
          const hex = /^%([0-9A-Fa-f]{2})/.exec(text.slice(j, j + 3));
          if (hex?.[1] !== undefined) {
            bytes.push(Number.parseInt(hex[1], 16));
            j += 2;
          } else {
            bytes.push(...Buffer.from(text[j] ?? "", "utf8"));
          }
        }
      } else {
        bytes.push(...Buffer.from(text, "utf8"));
      }
    }
    plain.set(name, decodeBytes(Uint8Array.from(bytes), charset));
  }
  return { value, params: plain };
}

/** Splits at `;` outside quotes. */
function splitParams(raw: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i] as string;
    if (c === "\\" && quoted) {
      current += c + (raw[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      out.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  out.push(current);
  return out;
}

function decodeBytes(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset.trim().toLowerCase() || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/** RFC 2047 encoded words (`=?utf-8?B?...?=`, `?Q?`); the space between two of them goes. */
export function decodeWords(text: string): string {
  return text
    .replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?)/g, "$1")
    .replace(
      /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g,
      (_, charset: string, kind: string, data: string) => {
        const name = charset.split("*")[0] ?? "utf-8";
        if (kind.toUpperCase() === "B") return decodeBytes(Buffer.from(data, "base64"), name);
        const bytes: number[] = [];
        for (let i = 0; i < data.length; i++) {
          const c = data[i] as string;
          const hex = /^=([0-9A-Fa-f]{2})/.exec(data.slice(i, i + 3));
          if (hex?.[1] !== undefined) {
            bytes.push(Number.parseInt(hex[1], 16));
            i += 2;
          } else bytes.push(c === "_" ? 0x20 : c.charCodeAt(0) & 0xff);
        }
        return decodeBytes(Uint8Array.from(bytes), name);
      },
    );
}

/** The tree of the message's parts. Never throws: what cannot be read is one opaque part. */
export function mimeTree(raw: Uint8Array): MimePart {
  return readPart(raw, 0, raw.length, "", 0);
}

function readPart(
  raw: Uint8Array,
  from: number,
  to: number,
  partId: string,
  depth: number,
  // A part without a Content-Type is `text/plain`, but in `multipart/digest` it is
  // `message/rfc822` (RFC 2046, 5.1.5), as IMAP's BODYSTRUCTURE has it.
  defaultType = "text/plain",
): MimePart {
  const { headerEnd, body } = bodyStart(raw, from, to);
  const headers = headersOf(latin1(raw, from, headerEnd));
  const contentType = valueAndParams(headers.get("content-type") ?? defaultType);
  const type = contentType.value.includes("/") ? contentType.value : defaultType;
  const disposition = headers.has("content-disposition")
    ? valueAndParams(headers.get("content-disposition") ?? "")
    : undefined;
  const contentId = headers.get("content-id")?.trim().replace(/^<|>$/g, "");
  const encoding = headers.get("content-transfer-encoding")?.trim().toLowerCase();
  const boundary = contentType.params.get("boundary");
  const children: MimePart[] = [];
  if (type.startsWith("multipart/") && boundary !== undefined && boundary !== "" && depth < 32) {
    const childType = type === "multipart/digest" ? "message/rfc822" : "text/plain";
    for (const [i, [start, end]] of bodiesBetween(raw, body, to, boundary).entries()) {
      const id = partId === "" ? String(i + 1) : `${partId}.${i + 1}`;
      children.push(readPart(raw, start, end, id, depth + 1, childType));
    }
  }
  return {
    // The top of a message of one part is part 1 (RFC 3501); a multipart top has no number.
    partId: partId === "" && children.length === 0 ? "1" : partId,
    type,
    params: contentType.params,
    ...(disposition?.value ? { disposition: disposition.value } : {}),
    dispositionParams: disposition?.params ?? new Map(),
    ...(contentId ? { contentId } : {}),
    ...(encoding ? { encoding } : {}),
    start: body,
    end: to,
    children,
  };
}

/** The byte ranges between the boundary lines of a multipart body. */
function bodiesBetween(
  raw: Uint8Array,
  from: number,
  to: number,
  boundary: string,
): [number, number][] {
  const text = latin1(raw, from, to);
  const marker = `--${boundary}`;
  const out: [number, number][] = [];
  let partStart: number | null = null;
  let at = 0;
  for (;;) {
    const found = text.indexOf(marker, at);
    if (found < 0) break;
    const lineStart = found === 0 || text[found - 1] === "\n";
    if (!lineStart) {
      at = found + marker.length;
      continue;
    }
    // The line break before the boundary belongs to it, not to the part.
    let end = found;
    if (text[end - 1] === "\n") end--;
    if (text[end - 1] === "\r") end--;
    if (partStart !== null) out.push([from + partStart, from + Math.max(partStart, end)]);
    const closing = text.startsWith("--", found + marker.length);
    const eol = text.indexOf("\n", found + marker.length);
    if (closing) return out;
    if (eol < 0) return out;
    partStart = eol + 1;
    at = eol + 1;
  }
  // A body without its closing boundary still has its last part.
  if (partStart !== null && partStart < text.length) out.push([from + partStart, to]);
  return out;
}

/** Text a person reads as the letter: plain or HTML, not offered as a file and without a name. */
function isBody(part: MimePart): boolean {
  if (part.disposition === "attachment") return false;
  if (fileNameOf(part) !== undefined) return false;
  return part.type === "text/plain" || part.type === "text/html" || part.type === "text/x-amp-html";
}

function fileNameOf(part: MimePart): string | undefined {
  const name = part.dispositionParams.get("filename") ?? part.params.get("name");
  return name === undefined || name.trim() === "" ? undefined : name;
}

/**
 * The files of a message, by the rules the IMAP adapter applies to `BODYSTRUCTURE` (ADR 0043,
 * rules 1 to 3): every leaf that is not the letter's text, `message/rfc822` as one file, inline
 * when it has a Content-ID inside `multipart/related`. Sizes are of the decoded bytes.
 */
export function attachmentsOfMime(raw: Uint8Array): ReceivedAttachment[] {
  const out: ReceivedAttachment[] = [];
  const walk = (part: MimePart, related: boolean) => {
    if (part.children.length > 0 && part.type !== "message/rfc822") {
      const inRelated = related || part.type === "multipart/related";
      for (const child of part.children) walk(child, inRelated);
      return;
    }
    if (part.type.startsWith("multipart/")) return;
    if (isBody(part)) return;
    out.push({
      partId: part.partId,
      name: safeFileName(fileNameOf(part) ?? "", nameFromType(part.type)),
      mimeType: part.type,
      size: decodedSize(raw, part),
      inline: related && part.contentId !== undefined && part.contentId !== "",
      ...(part.contentId ? { contentId: part.contentId } : {}),
    });
  };
  walk(mimeTree(raw), false);
  return out;
}

function decodedSize(raw: Uint8Array, part: MimePart): number {
  if (part.encoding !== "base64") return part.end - part.start;
  let chars = 0;
  for (let i = part.start; i < part.end; i++) {
    const c = raw[i] as number;
    if (
      (c >= 65 && c <= 90) ||
      (c >= 97 && c <= 122) ||
      (c >= 48 && c <= 57) ||
      c === 43 ||
      c === 47
    ) {
      chars++;
    }
  }
  return Math.floor((chars * 3) / 4);
}

/** The part with this id; undefined when there is none. */
export function findPart(raw: Uint8Array, partId: string): MimePart | undefined {
  const search = (part: MimePart): MimePart | undefined => {
    if (part.partId === partId) return part;
    for (const child of part.children) {
      const found = search(child);
      if (found) return found;
    }
    return undefined;
  };
  return search(mimeTree(raw));
}

/** The part's bytes with its transfer encoding removed: what a file download saves. */
export function decodePart(raw: Uint8Array, part: MimePart): Uint8Array {
  const body = Buffer.from(raw.buffer, raw.byteOffset + part.start, part.end - part.start);
  if (part.encoding === "base64")
    return new Uint8Array(Buffer.from(body.toString("latin1"), "base64"));
  if (part.encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return new Uint8Array(body);
}

function decodeQuotedPrintable(body: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < body.length; i++) {
    const c = body[i] as number;
    if (c !== 0x3d) {
      out.push(c);
      continue;
    }
    const a = body[i + 1];
    const b = body[i + 2];
    // A soft line break.
    if (a === 0x0d && b === 0x0a) {
      i += 2;
      continue;
    }
    if (a === 0x0a) {
      i += 1;
      continue;
    }
    const hex = a !== undefined && b !== undefined ? String.fromCharCode(a, b) : "";
    if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
      out.push(Number.parseInt(hex, 16));
      i += 2;
    } else out.push(c);
  }
  return Uint8Array.from(out);
}
