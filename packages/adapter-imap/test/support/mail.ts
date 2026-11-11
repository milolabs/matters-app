export interface MailSpec {
  readonly id: string;
  readonly subject: string;
  readonly body?: string;
  readonly date?: Date;
  readonly from?: { readonly name: string; readonly address: string };
  readonly inReplyTo?: string;
  readonly references?: readonly string[];
  /** The value of a `Reply-To` header, as written; none when absent. */
  readonly replyTo?: string;
  /** Further header lines, as written. */
  readonly headers?: readonly string[];
  /** Leave the Message-ID header out. */
  readonly noMessageId?: boolean;
}

const encodeWord = (s: string): string =>
  /^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, "utf8").toString("base64")}?=`;

/** A small RFC 5322 message; the body is base64 UTF-8 so Polish letters survive any server. */
export function mail(spec: MailSpec): string {
  const body = Buffer.from(spec.body ?? `Treść wiadomości ${spec.id}`, "utf8")
    .toString("base64")
    .replace(/(.{76})/g, "$1\r\n");
  const lines = [
    `From: ${encodeWord(spec.from?.name ?? "Łukasz Żółkiewski")} <${spec.from?.address ?? "lukasz@example.pl"}>`,
    "To: milosz@example.com",
    `Subject: ${encodeWord(spec.subject)}`,
    ...(spec.replyTo === undefined ? [] : [`Reply-To: ${spec.replyTo}`]),
    `Date: ${(spec.date ?? new Date(Date.UTC(2026, 10, 3, 9, 0))).toUTCString()}`,
    ...(spec.noMessageId ? [] : [`Message-ID: <${spec.id}@example.pl>`]),
    ...(spec.inReplyTo ? [`In-Reply-To: <${spec.inReplyTo}@example.pl>`] : []),
    ...(spec.references && spec.references.length > 0
      ? [`References: ${spec.references.map((r) => `<${r}@example.pl>`).join(" ")}`]
      : []),
    ...(spec.headers ?? []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    body,
  ];
  return `${lines.join("\r\n")}\r\n`;
}
