/**
 * Mail from a public office (ADR 0068, rule 4). A starting list, Polish first: it names the hosts and
 * labels of public bodies that the owner's mail has shown, and is meant to grow. It decides nothing alone:
 * an address that is on it is let past the program filter, and the model's own `official` category is
 * what makes a reading important. The address and the quote are all the code can check.
 */

/** Public bodies' host endings. */
const OFFICIAL_SUFFIXES = [".gov.pl", ".gov", ".gov.uk", "europa.eu"];
/** Hosts that are official as a whole. */
const OFFICIAL_HOSTS = new Set(["zus.pl", "europa.eu"]);
/** A registrable label that starts like the name of a local authority. */
const OFFICIAL_LABEL = /^(?:powiat|gmina|starostwo|urzad)/;
/** A town hall or a municipal office under .pl: `um.krakow.pl`, `ug.wieliczka.pl`. */
const OFFICIAL_PL_HOST = /^(?:um|ug)\.[^.]+(?:\.[^.]+)*\.pl$/;
/** What a public body sends to many: not mail about the person's own case. */
const BULLETIN_LOCAL =
  /^(?:newsletters?|news|biuletyn\w*|bulletin\w*|mailing\w*|info-list)(?:[-_.+].*)?$/;

/** Whether the address is at a public office, and is not a bulletin. */
export function isOfficialAddress(address: string): boolean {
  const at = address.lastIndexOf("@");
  if (at < 0) return false;
  const local = address.slice(0, at).trim().toLowerCase();
  if (BULLETIN_LOCAL.test(local)) return false;
  const host = address
    .slice(at + 1)
    .trim()
    .toLowerCase();
  if (host === "") return false;
  if (OFFICIAL_HOSTS.has(host) || OFFICIAL_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (host.endsWith(".zus.pl")) return true;
  if (OFFICIAL_PL_HOST.test(host)) return true;
  // The label before the top level, folded of Polish letters: `urzad-miasta.pl`, `gmina-x.pl`.
  const labels = host.split(".");
  const registrable = labels.length >= 2 ? (labels[labels.length - 2] as string) : "";
  return OFFICIAL_LABEL.test(registrable);
}
