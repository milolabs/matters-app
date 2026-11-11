import type { AuthMethod, ServerEndpoint, TransportSecurity } from "@matters/core";
import { childrenNamed, childText, parseXml, type XmlNode } from "./xml.ts";

export interface ParsedConfig {
  readonly displayName?: string;
  readonly imap?: ServerEndpoint;
  readonly smtp?: ServerEndpoint;
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

export const isHostname = (host: string): boolean => HOSTNAME.test(host);

const SECURITY: Readonly<Record<string, TransportSecurity>> = {
  ssl: "tls",
  tls: "tls",
  starttls: "starttls",
};

// Thunderbird's vocabulary; NTLM, GSSAPI, client certificates and the like are not supported.
const PASSWORD_AUTH = new Set(["password-cleartext", "password-encrypted", "plain", "secure"]);

function authOf(server: XmlNode): AuthMethod[] {
  const values = childrenNamed(server, "authentication").map((n) => n.text.trim().toLowerCase());
  if (values.length === 0) return ["password"];
  const out: AuthMethod[] = [];
  if (values.some((v) => PASSWORD_AUTH.has(v))) out.push("password");
  if (values.includes("oauth2")) out.push("oauth2");
  return out;
}

function endpointOf(server: XmlNode, domain: string): ServerEndpoint | null {
  const hostText = childText(server, "hostname")?.replaceAll("%EMAILDOMAIN%", domain);
  const security = SECURITY[(childText(server, "socketType") ?? "").toLowerCase()];
  const port = Number(childText(server, "port"));
  const auth = authOf(server);
  // Plaintext sockets are not offered; a host built from the address would need the address.
  if (!hostText || hostText.includes("%") || !isHostname(hostText)) return null;
  if (!security || !Number.isInteger(port) || port < 1 || port > 65535 || auth.length === 0) {
    return null;
  }
  return {
    host: hostText.toLowerCase(),
    port,
    security,
    usernameTemplate: childText(server, "username") || "%EMAILADDRESS%",
    auth,
  };
}

/** Password support first, then direct TLS before STARTTLS. */
function rank(e: ServerEndpoint): number {
  return (e.auth.includes("password") ? 0 : 2) + (e.security === "tls" ? 0 : 1);
}

function best(servers: XmlNode[], domain: string): ServerEndpoint | undefined {
  return servers
    .map((s) => endpointOf(s, domain))
    .filter((e): e is ServerEndpoint => e !== null)
    .sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Reads a Mozilla autoconfig document (`config-v1.1.xml`). Throws `XmlError` for a broken file;
 * returns no servers when it names none we can use.
 */
export function parseConfig(xml: string, domain: string): ParsedConfig {
  const root = parseXml(xml);
  if (root.name !== "clientConfig") return {};
  const provider = childrenNamed(root, "emailProvider")[0];
  if (!provider) return {};
  const imap = best(
    childrenNamed(provider, "incomingServer").filter((s) => s.attrs.type === "imap"),
    domain,
  );
  const smtp = best(
    childrenNamed(provider, "outgoingServer").filter((s) => s.attrs.type === "smtp"),
    domain,
  );
  const displayName = childText(provider, "displayName");
  return {
    ...(displayName ? { displayName } : {}),
    ...(imap ? { imap } : {}),
    ...(smtp ? { smtp } : {}),
  };
}
