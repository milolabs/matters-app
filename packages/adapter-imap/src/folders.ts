import type { LabelRole } from "@matters/core";
import { foldText } from "@matters/core";

const SPECIAL_USE: Readonly<Record<string, LabelRole>> = {
  "\\inbox": "inbox",
  "\\sent": "sent",
  "\\drafts": "drafts",
  "\\trash": "trash",
  "\\junk": "spam",
  "\\archive": "archive",
  "\\all": "archive",
};

// Folded names (see foldText): lower case, no diacritics.
const BY_NAME: Readonly<Record<string, LabelRole>> = {
  inbox: "inbox",
  sent: "sent",
  "sent items": "sent",
  "sent mail": "sent",
  "sent messages": "sent",
  wyslane: "sent",
  "elementy wyslane": "sent",
  drafts: "drafts",
  draft: "drafts",
  "wersje robocze": "drafts",
  szkice: "drafts",
  trash: "trash",
  "deleted items": "trash",
  "deleted messages": "trash",
  kosz: "trash",
  smieci: "trash",
  "elementy usuniete": "trash",
  spam: "spam",
  junk: "spam",
  "junk email": "spam",
  "junk e-mail": "spam",
  "wiadomosci-smieci": "spam",
  archive: "archive",
  archiwum: "archive",
  "all mail": "archive",
};

/** SPECIAL-USE (RFC 6154) first, then the folder name, Polish names included. */
export function roleOfFolder(
  path: string,
  leafName: string,
  specialUse: string | undefined,
): LabelRole {
  if (path.toUpperCase() === "INBOX") return "inbox";
  const byUse = specialUse ? SPECIAL_USE[specialUse.toLowerCase()] : undefined;
  if (byUse) return byUse;
  return BY_NAME[foldText(leafName).trim()] ?? "other";
}

/** Gmail system labels become plain names (`\Inbox` -> `inbox`); user labels stay as they are. */
export function gmailLabelId(label: string): string {
  return label.startsWith("\\") ? label.slice(1).toLowerCase() : label;
}
