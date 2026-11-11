import { createHash } from "node:crypto";

export interface IdentityInput {
  readonly folderId: string;
  readonly uidValidity: string;
  readonly uid: number;
  /** X-GM-MSGID or RFC 8474 EMAILID, as imapflow reports it. */
  readonly emailId: string | undefined;
  /** Which extension `emailId` comes from. */
  readonly emailIdKind: "gmail" | "objectId" | "none";
  readonly messageId: string | undefined;
  readonly dateMs: number | undefined;
  readonly size: number | undefined;
}

/**
 * Provider id of a message (ADR 0016), strongest first: Gmail message id, OBJECTID email id,
 * content fingerprint, and for mail without a `Message-ID` its own location, which never matches
 * a copy in another folder.
 */
export function providerIdOf(input: IdentityInput): string {
  if (input.emailId) {
    if (input.emailIdKind === "gmail") return `gm:${input.emailId}`;
    if (input.emailIdKind === "objectId") return `eid:${input.emailId}`;
  }
  const messageId = input.messageId?.trim();
  if (messageId) {
    const hash = createHash("sha256")
      .update(`${messageId}|${input.dateMs ?? ""}|${input.size ?? ""}`)
      .digest("hex");
    return `fp:${hash}`;
  }
  return `loc:${input.folderId}:${input.uidValidity}:${input.uid}`;
}
