// Hand-built MIME messages for the tests that need a real structure on a real server: nested
// multiparts, encoded file names, a binary file of several megabytes.
import { createHash } from "node:crypto";

export interface PartSpec {
  /** Header lines, without the transfer encoding. */
  readonly headers: readonly string[];
  /** The bytes of the part before its transfer encoding. */
  readonly content: Uint8Array | string;
  readonly encoding?: "base64" | "7bit";
}

const wrap76 = (base64: string) => base64.replace(/(.{76})/g, "$1\r\n");

/** One part: its headers, a blank line and its body. No trailing line break. */
export function part(spec: PartSpec): string {
  const encoding = spec.encoding ?? "7bit";
  const raw = typeof spec.content === "string" ? Buffer.from(spec.content, "utf8") : spec.content;
  const body =
    encoding === "base64"
      ? wrap76(Buffer.from(raw).toString("base64"))
      : Buffer.from(raw).toString("latin1");
  return `${[...spec.headers, `Content-Transfer-Encoding: ${encoding}`].join("\r\n")}\r\n\r\n${body}`;
}

/** `multipart/<subtype>` of rendered parts. It can be a part of another, or the whole message. */
export function multipart(subtype: string, boundary: string, parts: readonly string[]): string {
  const body = parts.map((p) => `--${boundary}\r\n${p}\r\n`).join("");
  return `Content-Type: multipart/${subtype}; boundary="${boundary}"\r\n\r\n${body}--${boundary}--`;
}

/** A whole message for APPEND; `entity` is the rendered top-level part or multipart. */
export function rawMessage(spec: {
  readonly id: string;
  readonly subject: string;
  readonly date: Date;
  readonly entity: string;
}): string {
  const headers = [
    "From: =?UTF-8?B?xYF1a2FzeiDFu8OzxYJraWV3c2tp?= <lukasz@example.pl>",
    "To: milosz@example.com",
    `Subject: ${spec.subject}`,
    `Date: ${spec.date.toUTCString()}`,
    `Message-ID: <${spec.id}@example.pl>`,
    "MIME-Version: 1.0",
  ];
  return `${headers.join("\r\n")}\r\n${spec.entity}\r\n`;
}

/** Bytes that look like nothing in particular, the same every time for a size and a seed. */
export function binary(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let x = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    // xorshift32
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    out[i] = x & 0xff;
  }
  return out;
}

export const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
