import { Resolver } from "node:dns/promises";
import { domainToASCII } from "node:url";
import type {
  DiscoveredServers,
  DiscoverySource,
  ServerDiscoveryPort,
  ServerEndpoint,
  TransportSecurity,
} from "@matters/core";
import { isHostname, parseConfig } from "./config.ts";
import { type Prober, probeServer } from "./probe.ts";

export * from "./config.ts";
export * from "./probe.ts";
export { XmlError } from "./xml.ts";

export interface SrvRecord {
  readonly name: string;
  readonly port: number;
  readonly priority: number;
  readonly weight: number;
}

/** What `fetch` gives the adapter; narrow so tests can fake it. */
export interface FetchedResponse {
  readonly ok: boolean;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { signal: AbortSignal; redirect: "follow"; headers: Record<string, string> },
) => Promise<FetchedResponse>;
export type SrvResolver = (name: string) => Promise<readonly SrvRecord[]>;
export type MxResolver = (
  domain: string,
) => Promise<readonly { readonly exchange: string; readonly priority: number }[]>;

export interface AutoconfigOptions {
  readonly fetch?: FetchLike;
  readonly resolveSrv?: SrvResolver;
  readonly resolveMx?: MxResolver;
  readonly probe?: Prober;
  /** Per request; default 3 s. */
  readonly timeoutMs?: number;
}

const MAX_BYTES = 100_000;

/** Lower-case ASCII (punycode) domain, or null when it cannot be a host name. */
export function normalizeDomain(input: string): string | null {
  const trimmed = input.trim().toLowerCase().replace(/\.$/, "");
  // domainToASCII parses like a URL host and would quietly cut "evil.com/x" down to "evil.com".
  if (/[\s/\\?#@:%[\]]/.test(trimmed)) return null;
  const domain = domainToASCII(trimmed);
  return domain.includes(".") && isHostname(domain) ? domain : null;
}

const ISPDB = "https://autoconfig.thunderbird.net/v1.1/";

/** The domains to ask ISPDB about for one mail exchanger, most specific first. */
export function mxDomains(exchange: string): string[] {
  const labels = exchange.trim().toLowerCase().replace(/\.$/, "").split(".");
  const out: string[] = [];
  for (let i = 1; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

/**
 * `ServerDiscoveryPort`: in the order of ADR 0018 the provider's own autoconfig, Mozilla's ISPDB,
 * DNS SRV (RFC 6186), then as in ADR 0023 ISPDB for the host named by the MX records, and probing
 * the usual server names. Only the domain is ever put in a request. Each step has a short
 * timeout and a failure just moves on to the next one; the first usable IMAP server wins.
 * Everything is HTTPS, a redirect to plain HTTP is refused, and plaintext sockets are never
 * offered.
 */
export class AutoconfigDiscovery implements ServerDiscoveryPort {
  private readonly fetchFn: FetchLike;
  private readonly resolveSrv: SrvResolver;
  private readonly resolveMx: MxResolver;
  private readonly probe: Prober;
  private readonly timeoutMs: number;

  constructor(options: AutoconfigOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 3000;
    this.fetchFn = options.fetch ?? (fetch as unknown as FetchLike);
    const resolver = new Resolver({ timeout: this.timeoutMs, tries: 1 });
    this.resolveSrv = options.resolveSrv ?? ((name) => resolver.resolveSrv(name));
    this.resolveMx = options.resolveMx ?? ((name) => resolver.resolveMx(name));
    this.probe = options.probe ?? probeServer;
  }

  async discover(domainInput: string): Promise<DiscoveredServers | null> {
    const domain = normalizeDomain(domainInput);
    if (!domain) return null;
    const urls: readonly [DiscoverySource, string][] = [
      ["provider", `https://autoconfig.${domain}/mail/config-v1.1.xml`],
      ["ispdb", `${ISPDB}${domain}`],
    ];
    for (const [source, url] of urls) {
      const found = await this.fromConfig(source, url, domain);
      if (found) return found;
    }
    const dns = await this.fromDns(domain);
    if (dns) return dns;
    const exchangers = await this.exchangers(domain);
    return (await this.fromMx(domain, exchangers)) ?? this.fromProbing(domain, exchangers);
  }

  private async exchangers(domain: string): Promise<string[]> {
    try {
      const records = await this.resolveMx(domain);
      return [...records]
        .sort((a, b) => a.priority - b.priority)
        .map((r) => r.exchange.replace(/\.$/, "").toLowerCase())
        .filter(isHostname);
    } catch {
      // no records, or DNS did not answer
      return [];
    }
  }

  /** The settings published for whoever runs the domain's mail exchangers. */
  private async fromMx(
    domain: string,
    exchangers: readonly string[],
  ): Promise<DiscoveredServers | null> {
    const asked = new Set([domain]);
    for (const exchange of exchangers) {
      for (const candidate of mxDomains(exchange)) {
        // A few names are enough: a long MX list repeats the same host.
        if (asked.has(candidate) || asked.size > 4) continue;
        asked.add(candidate);
        const found = await this.fromConfig("mx", `${ISPDB}${candidate}`, domain);
        if (found) return found;
      }
    }
    return null;
  }

  /** The usual names at the domain itself; a third party's exchanger is not ours to knock on. */
  private async fromProbing(
    domain: string,
    exchangers: readonly string[],
  ): Promise<DiscoveredServers | null> {
    const own = exchangers.filter((e) => e.endsWith(`.${domain}`)).slice(0, 1);
    const imap = await this.firstAnswering(
      "imap",
      [`imap.${domain}`, `mail.${domain}`, ...own],
      [
        [993, "tls"],
        [143, "starttls"],
      ],
    );
    if (!imap) return null;
    const smtp = await this.firstAnswering(
      "smtp",
      [`smtp.${domain}`, `mail.${domain}`, ...own],
      [
        [465, "tls"],
        [587, "starttls"],
      ],
    );
    return { source: "probe", imap, ...(smtp ? { smtp } : {}) };
  }

  private async firstAnswering(
    protocol: "imap" | "smtp",
    hosts: readonly string[],
    ports: readonly (readonly [number, TransportSecurity])[],
  ): Promise<ServerEndpoint | null> {
    const candidates = [...new Set(hosts)].flatMap((host) =>
      ports.map(([port, security]) => ({ host, port, security })),
    );
    const answers = await Promise.all(
      candidates.map((c) =>
        this.probe(protocol, c.host, c.port, c.security, this.timeoutMs).catch(() => false),
      ),
    );
    const first = candidates.find((_, i) => answers[i]);
    return first ? { ...first, usernameTemplate: "%EMAILADDRESS%", auth: ["password"] } : null;
  }

  private async fromConfig(
    source: DiscoverySource,
    url: string,
    domain: string,
  ): Promise<DiscoveredServers | null> {
    try {
      const response = await this.fetchFn(url, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "follow",
        headers: { accept: "application/xml, text/xml" },
      });
      if (!response.ok || !response.url.startsWith("https://")) return null;
      const length = Number(response.headers.get("content-length") ?? 0);
      if (length > MAX_BYTES) return null;
      const body = await response.text();
      if (body.length > MAX_BYTES) return null;
      const config = parseConfig(body, domain);
      if (!config.imap) return null;
      return {
        source,
        ...(config.displayName ? { displayName: config.displayName } : {}),
        imap: config.imap,
        ...(config.smtp ? { smtp: config.smtp } : {}),
      };
    } catch {
      // unreachable, timed out, not XML: this source has nothing for us
      return null;
    }
  }

  private async fromDns(domain: string): Promise<DiscoveredServers | null> {
    const imap = await this.srv(domain, [
      ["_imaps._tcp", "tls"],
      ["_imap._tcp", "starttls"],
    ]);
    if (!imap) return null;
    const smtp = await this.srv(domain, [
      ["_submissions._tcp", "tls"],
      ["_submission._tcp", "starttls"],
    ]);
    return { source: "dns", imap, ...(smtp ? { smtp } : {}) };
  }

  private async srv(
    domain: string,
    services: readonly (readonly [string, TransportSecurity])[],
  ): Promise<ServerEndpoint | null> {
    for (const [service, security] of services) {
      let records: readonly SrvRecord[];
      try {
        records = await this.resolveSrv(`${service}.${domain}`);
      } catch {
        continue;
      }
      // A target of "." is the provider saying the service does not exist (RFC 6186).
      const usable = records
        .map((r) => ({ ...r, name: r.name.replace(/\.$/, "").toLowerCase() }))
        .filter((r) => r.name !== "" && isHostname(r.name) && r.port > 0 && r.port < 65536)
        .sort((a, b) => a.priority - b.priority || b.weight - a.weight);
      const first = usable[0];
      if (first) {
        return {
          host: first.name,
          port: first.port,
          security,
          usernameTemplate: "%EMAILADDRESS%",
          auth: ["password"],
        };
      }
    }
    return null;
  }
}
