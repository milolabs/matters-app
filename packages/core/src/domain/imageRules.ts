import type { SenderAuth } from "./entities.ts";

// Remembering image choices (ADR 0037): one list of rules, four levels. The first level that
// has an answer decides. Level 1, the choice for one message, lives in the renderer only.

export type ImageRuleScope = "address" | "domain";
export type ImageRuleDecision = "allow" | "deny";
/** `ask` shows nothing until the reader says so; `always` shows images from senders not failing verification. */
export type GeneralImages = "ask" | "always";

export interface ImageRule {
  readonly scope: ImageRuleScope;
  /** Lower case. For `domain`, the registrable domain. */
  readonly value: string;
  readonly decision: ImageRuleDecision;
  readonly createdMs: number;
}

/** What decided: the rule or setting that applied, or `none` when nothing did. */
export type ImageSource =
  | "address-allow"
  | "domain-allow"
  | "always"
  | "address-deny"
  | "domain-deny"
  | "none";

export interface ImageDecision {
  readonly show: boolean;
  readonly source: ImageSource;
}

export const DEFAULT_GENERAL_IMAGES: GeneralImages = "ask";

/** Mail addresses are at most 254 characters; this is the same bound the rest of the boundary uses. */
export const MAX_IMAGE_RULE_VALUE = 320;

/** Addresses and domains are compared in lower case, without spaces around. */
export function normalizeRuleValue(value: string): string {
  return value.trim().toLowerCase();
}

/** The part after the last `@`, lower case and without a trailing dot; empty when there is none. */
export function addressHost(address: string): string {
  const at = address.lastIndexOf("@");
  if (at < 0) return "";
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

export interface DecideImagesInput {
  readonly address: string;
  /** The registrable domain of the sender, if there is one. */
  readonly domain: string | undefined;
  readonly verdict: SenderAuth;
  /** At least the address rule and the domain rule; others are ignored. */
  readonly rules: readonly ImageRule[];
  readonly general: GeneralImages;
}

/**
 * Walks address rule, domain rule, general setting. A rule that does not apply is skipped and
 * the walk goes on: `deny` always applies; an address `allow` applies unless the verdict is
 * `fail`; a domain `allow` only on `pass`; `always` unless `fail`.
 */
export function decideImages(input: DecideImagesInput): ImageDecision {
  const { verdict } = input;
  const ruleFor = (scope: ImageRuleScope, value: string | undefined) =>
    value === undefined || value === ""
      ? undefined
      : input.rules.find((r) => r.scope === scope && r.value === value)?.decision;

  const byAddress = ruleFor("address", normalizeRuleValue(input.address));
  if (byAddress === "deny") return { show: false, source: "address-deny" };
  if (byAddress === "allow" && verdict !== "fail") return { show: true, source: "address-allow" };

  const byDomain = ruleFor("domain", input.domain);
  if (byDomain === "deny") return { show: false, source: "domain-deny" };
  if (byDomain === "allow" && verdict === "pass") return { show: true, source: "domain-allow" };

  if (input.general === "always" && verdict !== "fail") return { show: true, source: "always" };
  return { show: false, source: "none" };
}

/**
 * Providers where a domain rule would allow millions of strangers (ADR 0037). Compared with the
 * registrable domain of the sender.
 */
export const PUBLIC_MAIL_PROVIDERS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "mail.ru",
  "yandex.com",
  "yandex.ru",
  "fastmail.com",
  "zoho.com",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "op.pl",
  "interia.pl",
  "poczta.fm",
  "tlen.pl",
  "gazeta.pl",
]);

export interface ImageOffer {
  /** `Always from <address>` would hold for this message. */
  readonly offerAddress: boolean;
  /** The registrable domain to offer, or null. */
  readonly offerDomain: string | null;
}

/** Which "always" rules the message may offer: only where the rule would apply to this very message. */
export function offerImageRules(verdict: SenderAuth, domain: string | undefined): ImageOffer {
  return {
    offerAddress: verdict !== "fail",
    offerDomain:
      verdict === "pass" && domain !== undefined && !PUBLIC_MAIL_PROVIDERS.has(domain)
        ? domain
        : null,
  };
}

/** What `Stop showing images` was shown for: the rule that allowed them, or `always`. */
export type StoppableSource = Extract<ImageSource, "address-allow" | "domain-allow" | "always">;

export interface StopInput {
  readonly source: StoppableSource;
  readonly address: string;
  readonly domain: string | undefined;
  /** Rules as stored now, before the stop. */
  readonly rules: readonly ImageRule[];
  readonly general: GeneralImages;
}

export interface StopPlan {
  /** The allowing rule to delete, if there is one. */
  readonly remove: { readonly scope: ImageRuleScope; readonly value: string } | null;
  /** Write an address `deny`: something broader would still allow this address. */
  readonly denyAddress: boolean;
}

/**
 * The allowing rule goes (nothing goes for `always`). Then, if the address would still be
 * allowed by another rule or by `always`, an address `deny` is written. That is judged by which
 * rules exist, whatever the verdict of this message, so the outcome is the same for every
 * message from the sender.
 */
export function planStop(input: StopInput): StopPlan {
  const address = normalizeRuleValue(input.address);
  const remove =
    input.source === "address-allow"
      ? { scope: "address" as const, value: address }
      : input.source === "domain-allow" && input.domain !== undefined
        ? { scope: "domain" as const, value: input.domain }
        : null;
  const remaining = remove
    ? input.rules.filter((r) => !(r.scope === remove.scope && r.value === remove.value))
    : input.rules;
  const after = decideImages({
    address,
    domain: input.domain,
    verdict: "pass",
    rules: remaining,
    general: input.general,
  });
  return { remove, denyAddress: after.show };
}
