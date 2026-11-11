// Corpus messages too large to commit (ADR 0047). Each is deterministic and made from nothing.
const CRLF = "\r\n";

function head(id: string, extra: string[] = [], ct = "text/plain; charset=utf-8"): string {
  return [
    "From: Sender <sender@example.org>",
    "To: Reader <reader@example.com>",
    "Subject: Corpus message",
    "Date: Wed, 04 Nov 2026 10:00:00 +0000",
    `Message-ID: <${id}@corpus.test>`,
    "MIME-Version: 1.0",
    ...extra,
    `Content-Type: ${ct}`,
  ].join(CRLF);
}

export function generateCase(name: string, id: string): Buffer {
  switch (name) {
    case "huge-header": {
      // One header of a megabyte, folded every 900 characters.
      const value = Array.from({ length: 1200 }, () => "x".repeat(900)).join(`${CRLF} `);
      return Buffer.from(`${head(id, [`X-Huge: ${value}`])}${CRLF}${CRLF}Body.${CRLF}`);
    }
    case "many-headers": {
      const lines = Array.from({ length: 50_000 }, (_, i) => `X-N${i}: v`);
      return Buffer.from(`${head(id, lines)}${CRLF}${CRLF}Body.${CRLF}`);
    }
    case "compressible-body": {
      const line = `${"a".repeat(76)}${CRLF}`;
      return Buffer.from(
        `${head(id)}${CRLF}${CRLF}${line.repeat(Math.ceil(8_000_000 / line.length))}`,
      );
    }
    case "many-parts": {
      const parts = Array.from(
        { length: 5000 },
        (_, i) =>
          `--M${CRLF}Content-Type: application/octet-stream${CRLF}Content-Disposition: attachment; filename="f${i}.bin"${CRLF}${CRLF}x${CRLF}`,
      ).join("");
      return Buffer.from(
        `${head(id, [], 'multipart/mixed; boundary="M"')}${CRLF}${CRLF}${parts}--M--${CRLF}`,
      );
    }
    case "huge-html": {
      const row = `<tr><td style="padding:2px"><table><tr><td><b>cell</b> <i>text</i> <a href="https://example.org/x">link</a></td></tr></table></td></tr>`;
      const body = `<html><body><table>${row.repeat(Math.ceil(1_500_000 / row.length))}</table></body></html>`;
      return Buffer.from(`${head(id, [], "text/html; charset=utf-8")}${CRLF}${CRLF}${body}${CRLF}`);
    }
    default:
      throw new Error(`unknown corpus generator ${name}`);
  }
}
