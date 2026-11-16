// Window tests of a dev build only (ADR 0130): what stands in for Microsoft Graph and for DNS when
// the app runs against stand-ins on this machine. Main passes the variables to the backend only
// in a dev build (main/index.ts); a release never has them, and the Graph adapter takes nothing
// but a loopback address (ADR 0136, rule 12).
import { AutoconfigDiscovery } from "@matters/adapter-autoconfig";
import type { ServerDiscoveryPort } from "@matters/core";

/** The variable with the stand-in Graph service's address, `http://127.0.0.1:<port>/v1.0`. */
export const GRAPH_BASE_VARIABLE = "MATTERS_TEST_GRAPH_BASE";
/** The variable with a stand-in Anthropic API's address, `http://127.0.0.1:<port>` (ADR 0141). */
export const ANTHROPIC_BASE_VARIABLE = "MATTERS_TEST_ANTHROPIC_BASE";
/** The variable with the DNS answers of a window test, as JSON (see `testDiscovery`). */
export const DNS_VARIABLE = "MATTERS_TEST_DNS";

/** What DNS answers for one domain in a window test. */
interface TestDomain {
  readonly mx?: readonly string[];
  readonly autodiscover?: readonly string[];
  readonly txt?: readonly string[];
  /** How long the lookup of this domain takes, so a test can act while it runs. */
  readonly delayMs?: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const names = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((n): n is string => typeof n === "string") : [];

function notFound(): never {
  throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
}

/**
 * The lookup of ADR 0023 and 0135 with DNS answered from a table, `{ "<domain>": { mx, autodiscover,
 * txt, delayMs } }`, and nothing asked of the network: no settings database, no probe. A domain not
 * in the table has no records. Null when the variable is unset or is not such a table.
 */
export function testDiscovery(raw: string | undefined): ServerDiscoveryPort | null {
  if (raw === undefined || raw === "") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return null;
  const table = new Map<string, TestDomain>();
  for (const [domain, value] of Object.entries(parsed)) {
    if (!isRecord(value)) continue;
    table.set(domain.toLowerCase(), {
      mx: names(value.mx),
      autodiscover: names(value.autodiscover),
      txt: names(value.txt),
      ...(typeof value.delayMs === "number" && value.delayMs > 0
        ? { delayMs: Math.min(value.delayMs, 30_000) }
        : {}),
    });
  }
  const of = (name: string) => table.get(name.toLowerCase());
  const discovery = new AutoconfigDiscovery({
    timeoutMs: 500,
    fetch: async (url) => ({
      ok: false,
      url,
      headers: { get: () => null },
      text: async () => "",
    }),
    resolveSrv: async () => notFound(),
    resolveMx: async (name) => {
      const mx = of(name)?.mx ?? [];
      return mx.length === 0 ? notFound() : mx.map((exchange, i) => ({ exchange, priority: i }));
    },
    resolveTxt: async (name) => {
      const txt = of(name)?.txt ?? [];
      return txt.length === 0 ? notFound() : txt.map((record) => [record]);
    },
    resolveCname: async (name) => {
      const domain = name.replace(/^autodiscover\./, "");
      const targets = name.startsWith("autodiscover.") ? (of(domain)?.autodiscover ?? []) : [];
      return targets.length === 0 ? notFound() : targets;
    },
    probe: async () => false,
  });
  return {
    discover: async (domain) => {
      const delayMs = of(domain)?.delayMs;
      if (delayMs !== undefined) await new Promise((done) => setTimeout(done, delayMs));
      return discovery.discover(domain);
    },
  };
}
