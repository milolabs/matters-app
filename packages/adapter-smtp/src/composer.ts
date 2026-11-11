import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import type {
  ComposedMessage,
  ComposeInput,
  MessageComposerPort,
  Participant,
} from "@matters/core";
import { domainOfAddress } from "@matters/core";
import MailComposer from "nodemailer/lib/mail-composer";
import { SmtpComposeError } from "./errors.ts";

const address = (p: Participant) =>
  p.name && p.name !== "" && p.name !== p.address
    ? { name: p.name, address: p.address }
    : p.address;

/** A file to put in the message; nodemailer reads it from `path` while the message streams. */
export interface FilePart {
  readonly path: string;
  readonly filename: string;
}

/**
 * Builds the MIME message with nodemailer's MailComposer: `multipart/alternative` with the
 * Markdown source as text and the rendered HTML (ADR 0020, rule 12), a `Message-ID` we choose
 * (`<uuid@sender-domain>`), threading headers, no Bcc header (the envelope carries Bcc).
 */
export class NodemailerComposer implements MessageComposerPort {
  private mailFor(input: ComposeInput, attachments: readonly FilePart[]) {
    const domain = domainOfAddress(input.from.address);
    if (!domain) throw new SmtpComposeError("The sender address has no domain");
    const messageId = `<${randomUUID()}@${domain}>`;
    const mail = new MailComposer({
      from: address(input.from),
      to: input.to.map(address),
      cc: input.cc.map(address),
      subject: input.subject,
      text: input.text,
      html: input.html,
      date: new Date(input.dateMs),
      messageId,
      ...(input.inReplyTo === "" ? {} : { inReplyTo: input.inReplyTo }),
      ...(input.references.length === 0 ? {} : { references: [...input.references] }),
      ...(attachments.length === 0
        ? {}
        : { attachments: attachments.map((a) => ({ path: a.path, filename: a.filename })) }),
    });
    return { mail, messageId };
  }

  async compose(input: ComposeInput): Promise<ComposedMessage> {
    const { mail, messageId } = this.mailFor(input, []);
    const raw = await new Promise<Buffer>((resolve, reject) => {
      mail.compile().build((error, message) => (error ? reject(error) : resolve(message)));
    });
    return { raw: new Uint8Array(raw), messageId };
  }

  /**
   * The same message as a stream, with files read from disk as it goes, so no part of it is held
   * whole (ADR 0041, rule 9). Headers, `Message-ID` and the absence of Bcc are as in `compose`.
   * A file that cannot be read makes the stream emit an error.
   */
  composeToStream(
    input: ComposeInput,
    attachments: readonly FilePart[],
  ): { readonly stream: Readable; readonly messageId: string } {
    const { mail, messageId } = this.mailFor(input, attachments);
    return { stream: mail.compile().createReadStream(), messageId };
  }
}
