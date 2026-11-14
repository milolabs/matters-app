// A smoke run's key store (ADR 0138, rule 7): it never starts `/usr/bin/security` and knows only
// two made-up services, which it pretends to hold until they are deleted. What it was asked goes
// to a log file the smoke driver reads.
import { appendFileSync } from "node:fs";
import type { KeychainPort } from "./erase.ts";

export const SMOKE_KEY_SERVICE = "matters-smoke-key (not a real Keychain item)";
export const SMOKE_EARLIER_KEY_SERVICE = "matters-smoke-earlier-key (not a real Keychain item)";

export function smokeKeychain(log: string | undefined): KeychainPort {
  const held = new Set([SMOKE_KEY_SERVICE, SMOKE_EARLIER_KEY_SERVICE]);
  const note = (line: string) => {
    if (log) appendFileSync(log, `${line}\n`);
  };
  return {
    async remove(service) {
      note(`remove ${service}`);
      if (!held.has(service)) return "absent";
      held.delete(service);
      return "deleted";
    },
    async exists(service) {
      note(`exists ${service}`);
      return held.has(service);
    },
  };
}
