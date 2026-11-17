import type { Holding } from "@matters/core";

/** The vault's file under the data folder (the composition root names it). */
export const VAULT_FILE = "credentials.json";

/**
 * The saved passwords and sign-ins, the agent's API keys (ADR 0141, rule 4: entries of the same
 * vault), and the keys that protect them (ADR 0138, rules 2 and 7). They
 * go first: once the vault is gone the key protects nothing, so a key that cannot be deleted is
 * reported, never a reason to stop.
 */
export const SECRETS_HOLDINGS: readonly Holding[] = [
  {
    id: "secrets.vault",
    group: "signIns",
    place: { kind: "data", name: VAULT_FILE, match: "exact" },
    step: "signIns",
  },
  // A vault written aside and not yet renamed into place, or set aside as unreadable.
  {
    id: "secrets.vaultTemp",
    group: "signIns",
    place: { kind: "data", name: `${VAULT_FILE}.`, match: "prefix" },
    step: "signIns",
  },
  {
    id: "secrets.key",
    group: "signIns",
    place: { kind: "keychain", which: "current" },
    step: "signIns",
  },
  {
    id: "secrets.earlierKey",
    group: "signIns",
    place: { kind: "keychain", which: "earlier" },
    step: "earlier",
  },
];
