import type { SenderAuth } from "../domain/entities.ts";
import { InvalidImageRuleError } from "../domain/errors.ts";
import {
  addressHost,
  decideImages,
  type GeneralImages,
  type ImageDecision,
  type ImageOffer,
  type ImageRule,
  type ImageRuleDecision,
  type ImageRuleScope,
  MAX_IMAGE_RULE_VALUE,
  normalizeRuleValue,
  offerImageRules,
  planStop,
  type StoppableSource,
} from "../domain/imageRules.ts";
import type { ImageRuleStorePort, UnitOfWorkPort } from "../ports/index.ts";

/** Maps a host to its registrable domain (Public Suffix List); `undefined` for a public suffix alone. */
export type RegistrableDomainFn = (host: string) => string | undefined;

/** What the reader is told about the images of one message. */
export interface ImageChoice extends ImageDecision, ImageOffer {
  readonly verdict: SenderAuth;
  /** The sender's address as rules know it: lower case. */
  readonly address: string;
  /** The registrable domain of the sender, null when it has none. */
  readonly domain: string | null;
}

export interface ImageReadDeps {
  readonly rules: Pick<ImageRuleStorePort, "get" | "getGeneral">;
  readonly registrableDomain: RegistrableDomainFn;
}

export interface ImageWriteDeps {
  readonly rules: ImageRuleStorePort;
  readonly registrableDomain: RegistrableDomainFn;
  readonly uow: UnitOfWorkPort;
  now(): number;
}

/** Two keyed lookups and the setting, never a scan of the rules. */
export async function chooseImages(
  deps: ImageReadDeps,
  sender: string,
  verdict: SenderAuth,
): Promise<ImageChoice> {
  const address = normalizeRuleValue(sender);
  const host = addressHost(address);
  const domain = host === "" ? undefined : deps.registrableDomain(host);
  const [byAddress, byDomain, general] = await Promise.all([
    address === "" ? null : deps.rules.get("address", address),
    domain === undefined ? null : deps.rules.get("domain", domain),
    deps.rules.getGeneral(),
  ]);
  const rules = [byAddress, byDomain].filter((r): r is ImageRule => r !== null);
  return {
    ...decideImages({ address, domain, verdict, rules, general }),
    ...offerImageRules(verdict, domain),
    verdict,
    address,
    domain: domain ?? null,
  };
}

function checkAddress(raw: string): string {
  const address = normalizeRuleValue(raw);
  const at = address.lastIndexOf("@");
  if (
    address.length > MAX_IMAGE_RULE_VALUE ||
    at < 1 ||
    at === address.length - 1 ||
    /\s/.test(address)
  ) {
    throw new InvalidImageRuleError("That is not an email address.");
  }
  return address;
}

function checkRule(deps: ImageWriteDeps, scope: ImageRuleScope, raw: string): string {
  if (scope === "address") return checkAddress(raw);
  const domain = normalizeRuleValue(raw);
  // A rule for a public suffix (`co.uk`) or a subdomain of the registrable one cannot exist.
  if (domain.length > MAX_IMAGE_RULE_VALUE || deps.registrableDomain(domain) !== domain) {
    throw new InvalidImageRuleError("That is not a registrable domain.");
  }
  return domain;
}

/** Inserts or replaces by scope and value, so `Always from` replaces an earlier `deny`. */
export async function setImageRule(
  deps: ImageWriteDeps,
  input: { scope: ImageRuleScope; value: string; decision: ImageRuleDecision },
): Promise<ImageRule> {
  const rule: ImageRule = {
    scope: input.scope,
    value: checkRule(deps, input.scope, input.value),
    decision: input.decision,
    createdMs: deps.now(),
  };
  await deps.rules.put(rule);
  return rule;
}

/** Returns whether the rule existed. */
export function removeImageRule(
  deps: ImageWriteDeps,
  scope: ImageRuleScope,
  value: string,
): Promise<boolean> {
  return deps.rules.remove(scope, normalizeRuleValue(value));
}

export function setGeneralImages(deps: ImageWriteDeps, general: GeneralImages): Promise<void> {
  return deps.rules.setGeneral(general);
}

/** `Stop showing images from …` (ADR 0037, point 3). One unit: the rule and the deny go together. */
export async function stopImages(
  deps: ImageWriteDeps,
  input: { address: string; source: StoppableSource },
): Promise<void> {
  const address = checkAddress(input.address);
  const host = addressHost(address);
  const domain = host === "" ? undefined : deps.registrableDomain(host);
  await deps.uow.run(async () => {
    const [byAddress, byDomain, general] = await Promise.all([
      deps.rules.get("address", address),
      domain === undefined ? null : deps.rules.get("domain", domain),
      deps.rules.getGeneral(),
    ]);
    const rules = [byAddress, byDomain].filter((r): r is ImageRule => r !== null);
    const plan = planStop({ source: input.source, address, domain, rules, general });
    if (plan.remove) await deps.rules.remove(plan.remove.scope, plan.remove.value);
    if (plan.denyAddress) {
      await deps.rules.put({
        scope: "address",
        value: address,
        decision: "deny",
        createdMs: deps.now(),
      });
    }
  });
}

/** Far more than anyone's list; keeps junk from the boundary out. */
export const MAX_IMPORTED_ADDRESSES = 50_000;

/**
 * The old per-sender list becomes `allow` rules, once. Addresses that already have a rule are
 * left alone, so running it twice, or after the reader changed a rule, loses nothing. Entries
 * that are not addresses are skipped. Returns how many rules were added.
 */
export async function importImageAddresses(
  deps: ImageWriteDeps,
  addresses: readonly string[],
): Promise<number> {
  if (addresses.length > MAX_IMPORTED_ADDRESSES) {
    throw new InvalidImageRuleError("That list is too long to import.");
  }
  const now = deps.now();
  const rules: ImageRule[] = [];
  for (const raw of addresses) {
    try {
      rules.push({ scope: "address", value: checkAddress(raw), decision: "allow", createdMs: now });
    } catch {
      // not an address: nothing to remember
    }
  }
  return deps.rules.putIfAbsent(rules);
}
