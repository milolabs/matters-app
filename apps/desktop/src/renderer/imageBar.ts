import type { ImageChoice, StoppableSource } from "@matters/core";

/**
 * Every word of the bar, in one place for when the app has other languages. Whole sentences with
 * the name inside, never joined pieces: word order and length change with the language, so the
 * layout must not depend on them either.
 */
export const imageCopy = {
  off: "Images are off, so the sender can't tell you've read this.",
  unverified: "This sender couldn't be verified, so images stay off.",
  denied: (who: string) => `You turned off images from ${who}.`,
  onFor: (who: string) => `Images from ${who} are on.`,
  onForEveryone: "Images are on for every sender.",
  show: "Show images",
  always: "Always show…",
  alwaysMenu: "Always show images",
  fromAddress: (address: string) => `From ${address}`,
  fromDomain: (domain: string) => `From anyone at ${domain}`,
  turnOff: "Turn off",
  turnOffForSender: "Turn off for this sender",
} as const;

/**
 * Which words the bar above a message uses while its images are off (ADR 0037, point 9). A deny
 * is the reader's own word and comes first; a sender that failed verification comes next.
 */
export type BarKind = "ask" | "unverified" | "denied";

export function barKind(choice: ImageChoice): BarKind {
  if (choice.source === "address-deny" || choice.source === "domain-deny") return "denied";
  return choice.verdict === "fail" ? "unverified" : "ask";
}

/** The rule or setting that let the images in, when one did: what `Stop showing images` ends. */
export function allowingSource(choice: ImageChoice | null): StoppableSource | null {
  if (!choice?.show) return null;
  return choice.source === "address-allow" ||
    choice.source === "domain-allow" ||
    choice.source === "always"
    ? choice.source
    : null;
}
