import { parse } from "tldts";

/**
 * The registrable domain of a host (ADR 0037): the public suffix plus one label, found with the
 * Public Suffix List that ships inside tldts. `undefined` for a public suffix alone (`co.uk`),
 * an IP address, or anything that is not a host, so no rule can name them. A TLD the list does
 * not know counts as a suffix of one label, as the list's own algorithm says.
 */
export function registrableDomain(host: string): string | undefined {
  const parsed = parse(host.trim().toLowerCase(), { allowPrivateDomains: false });
  if (parsed.isIp) return undefined;
  return parsed.domain ?? undefined;
}
