import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expandUsername, takesPassword } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  AutoconfigDiscovery,
  type FetchedResponse,
  type FetchLike,
  mxDomains,
  normalizeDomain,
  type Prober,
  parseConfig,
  probeServer,
  type SrvRecord,
  XmlError,
} from "../src/index.ts";
import { parseXml } from "../src/xml.ts";

const fixture = (name: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", name), "utf8");

describe("parseXml", () => {
  it("reads elements, attributes, entities, CDATA, comments and self-closing tags", () => {
    const root = parseXml(
      `<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='q'><b>t &lt;&#65;&#x42;&gt;</b><c/><![CDATA[<raw>]]></a>`,
    );
    expect(root.attrs).toEqual({ x: "1 & 2", y: "q" });
    expect(root.text).toBe("<raw>");
    expect(root.children.map((c) => [c.name, c.text])).toEqual([
      ["b", "t <AB>"],
      ["c", ""],
    ]);
  });

  it.each([
    ["unclosed element", "<a><b></a>"],
    ["mismatched tags", "<a></b>"],
    ["two roots", "<a/><b/>"],
    ["text outside the root", "x<a/>"],
    ["empty input", "  "],
    ["unterminated comment", "<a><!-- x</a>"],
    ["bad tag", "<a><1/></a>"],
    ["undefined entity", "<a>&host;</a>"],
    ["DOCTYPE", "<!DOCTYPE a [<!ENTITY e 'x'>]><a/>"],
  ])("rejects %s", (_name, xml) => {
    expect(() => parseXml(xml)).toThrow(XmlError);
  });

  it("refuses absurd nesting and size", () => {
    expect(() => parseXml("<a>".repeat(100) + "</a>".repeat(100))).toThrow(/deeply/);
    expect(() => parseXml(`<a>${"<b/>".repeat(6000)}</a>`)).toThrow(/too many/);
  });

  it("reads attributes with white space around `=` and none between them", () => {
    const root = parseXml(`<a\tx = "1"y='2'\n z\t=\t"3" />`);
    expect(root.attrs).toEqual({ x: "1", y: "2", z: "3" });
    expect(() => parseXml(`<a x="1></a>`)).toThrow(XmlError);
    expect(() => parseXml(`<a x></a>`)).toThrow(XmlError);
  });

  it.each([
    ["white space", `<a${"\t".repeat(50_000)}x`],
    ["a long name", `<a ${"A".repeat(50_000)}`],
    ["a long name and white space", `<a ${"A".repeat(25_000)}${"\t".repeat(25_000)}`],
    ["a long closing tag", `<a></${"A".repeat(50_000)}\t`],
  ])("rejects a tag of %s in linear time", (_name, xml) => {
    const start = performance.now();
    expect(() => parseXml(xml)).toThrow(XmlError);
    expect(performance.now() - start).toBeLessThan(250);
  });
});

describe("parseConfig", () => {
  it("reads a Gmail-like file: IMAP over TLS with password and OAuth2, SMTP, display name", () => {
    const config = parseConfig(fixture("gmail-like.xml"), "mail.example.com");
    expect(config).toEqual({
      displayName: "Example Mail",
      imap: {
        host: "imap.mail.example.com",
        port: 993,
        security: "tls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password", "oauth2"],
      },
      smtp: {
        host: "smtp.mail.example.com",
        port: 465,
        security: "tls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password", "oauth2"],
      },
    });
  });

  it("reads a Polish-provider-like file: skips POP3 and plaintext, prefers TLS, expands the domain", () => {
    const config = parseConfig(fixture("polish-provider-like.xml"), "poczta.example.pl");
    expect(config.displayName).toBe("Poczta Przykład & Spółka");
    expect(config.imap).toEqual({
      host: "imap.poczta.example.pl",
      port: 993,
      security: "tls",
      usernameTemplate: "%EMAILLOCALPART%",
      auth: ["password"],
    });
    expect(config.smtp).toMatchObject({ host: "smtp.poczta.example.pl", security: "starttls" });
    expect(
      expandUsername(config.imap?.usernameTemplate ?? "", "jan.kowalski@poczta.example.pl"),
    ).toBe("jan.kowalski");
  });

  it("offers no server when the file has only plaintext IMAP, Exchange, or an address-built host", () => {
    expect(parseConfig(fixture("plaintext-only.xml"), "old.example.com").imap).toBeUndefined();
    expect(parseConfig(fixture("exchange-only.xml"), "corp.example.com").imap).toBeUndefined();
    expect(parseConfig(fixture("address-in-host.xml"), "odd.example.com").imap).toBeUndefined();
    expect(parseConfig("<other/>", "x.example.com")).toEqual({});
  });

  it("throws on broken XML and on a DOCTYPE with entities", () => {
    expect(() => parseConfig(fixture("truncated.xml"), "broken.example.com")).toThrow(XmlError);
    expect(() => parseConfig(fixture("mismatched.xml"), "broken.example.com")).toThrow(XmlError);
    expect(() => parseConfig(fixture("hostile-doctype.xml"), "x.example.com")).toThrow(XmlError);
  });
});

describe("normalizeDomain", () => {
  it("accepts host names, folds case and punycodes, and refuses anything else", () => {
    expect(normalizeDomain(" Example.COM. ")).toBe("example.com");
    expect(normalizeDomain("zażółć.pl")).toBe("xn--za-6ja4f8n1l.pl");
    for (const bad of [
      "",
      "localhost",
      "a b.com",
      "evil.com/x",
      "x@y.com",
      "a.com?q=1",
      "-a.com",
      "a..com",
    ]) {
      expect(normalizeDomain(bad), bad).toBeNull();
    }
  });
});

interface FakeWorld {
  readonly files: Record<
    string,
    string | number | "throw" | "hang" | { redirect: string; body: string }
  >;
  readonly srv: Record<string, SrvRecord[] | "throw">;
  /** Exchangers in order of preference. */
  readonly mx?: Record<string, string[]>;
  /** `imap:host:port` of servers that answer a probe. */
  readonly answering?: readonly string[];
}

function fakeNetwork(world: FakeWorld) {
  const requests: string[] = [];
  const lookups: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    requests.push(url);
    const entry = world.files[url];
    if (entry === undefined) return response(url, 404, "");
    if (entry === "throw") throw new Error("ECONNREFUSED");
    if (entry === "hang") {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    }
    if (typeof entry === "number") return response(url, entry, "");
    if (typeof entry === "object") return response(entry.redirect, 200, entry.body);
    return response(url, 200, entry);
  };
  const resolveSrv = async (name: string) => {
    lookups.push(name);
    const entry = world.srv[name];
    if (entry === "throw" || entry === undefined)
      throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    return entry;
  };
  const resolveMx = async (name: string) => {
    const records = world.mx?.[name];
    if (!records) throw Object.assign(new Error("ENODATA"), { code: "ENODATA" });
    return records.map((exchange, priority) => ({ exchange, priority }));
  };
  const probes: string[] = [];
  const probe: Prober = async (protocol, host, port) => {
    const key = `${protocol}:${host}:${port}`;
    probes.push(key);
    return world.answering?.includes(key) ?? false;
  };
  return { requests, lookups, probes, fetch, resolveSrv, resolveMx, probe };
}

function response(url: string, status: number, body: string): FetchedResponse {
  return {
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (n) => (n.toLowerCase() === "content-length" ? String(body.length) : null) },
    text: async () => body,
  };
}

const PROVIDER = "https://autoconfig.poczta.example.pl/mail/config-v1.1.xml";
const ISPDB = "https://autoconfig.thunderbird.net/v1.1/poczta.example.pl";

describe("AutoconfigDiscovery", () => {
  it("asks the provider first and stops at the first good answer", async () => {
    const net = fakeNetwork({
      files: { [PROVIDER]: fixture("polish-provider-like.xml") },
      srv: {},
    });
    const found = await new AutoconfigDiscovery(net).discover("Poczta.Example.PL");

    expect(found).toMatchObject({
      source: "provider",
      imap: { host: "imap.poczta.example.pl", port: 993, security: "tls" },
    });
    expect(net.requests).toEqual([PROVIDER]);
    expect(net.lookups).toEqual([]);
  });

  it("falls back to ISPDB when the provider has nothing, in that order", async () => {
    const net = fakeNetwork({
      files: {
        [ISPDB]: fixture("gmail-like.xml").replaceAll("mail.example.com", "poczta.example.pl"),
      },
      srv: {},
    });
    const found = await new AutoconfigDiscovery(net).discover("poczta.example.pl");

    expect(found?.source).toBe("ispdb");
    expect(found?.imap.host).toBe("imap.poczta.example.pl");
    expect(net.requests).toEqual([PROVIDER, ISPDB]);
    expect(net.lookups).toEqual([]);
  });

  it("moves on after a network error, a broken file, a timeout, a hostile file and a plaintext-only file", async () => {
    for (const first of [
      "throw",
      500,
      fixture("truncated.xml"),
      fixture("hostile-doctype.xml"),
      fixture("plaintext-only.xml"),
      "hang",
    ] as const) {
      const net = fakeNetwork({
        files: { [PROVIDER]: first, [ISPDB]: fixture("polish-provider-like.xml") },
        srv: {},
      });
      const found = await new AutoconfigDiscovery({ ...net, timeoutMs: 30 }).discover(
        "poczta.example.pl",
      );
      expect(found?.source, String(first).slice(0, 20)).toBe("ispdb");
    }
  });

  it("refuses an answer that arrived over plain HTTP after a redirect, and an oversized one", async () => {
    const net = fakeNetwork({
      files: {
        [PROVIDER]: {
          redirect: "http://evil.example.org/c.xml",
          body: fixture("polish-provider-like.xml"),
        },
        [ISPDB]: `<clientConfig>${" ".repeat(200_000)}</clientConfig>`,
      },
      srv: {},
    });
    expect(await new AutoconfigDiscovery(net).discover("poczta.example.pl")).toBeNull();
  });

  it("uses DNS SRV last: imaps before imap, lowest priority and highest weight first, submission too", async () => {
    const net = fakeNetwork({
      files: {},
      srv: {
        "_imaps._tcp.poczta.example.pl": [
          { name: "slow.poczta.example.pl.", port: 993, priority: 20, weight: 10 },
          { name: "Imap2.poczta.example.pl.", port: 993, priority: 10, weight: 5 },
          { name: "imap1.poczta.example.pl.", port: 1993, priority: 10, weight: 50 },
        ],
        "_imap._tcp.poczta.example.pl": [
          { name: "plain.poczta.example.pl", port: 143, priority: 0, weight: 0 },
        ],
        "_submission._tcp.poczta.example.pl": [
          { name: "smtp.poczta.example.pl", port: 587, priority: 0, weight: 1 },
        ],
      },
    });
    const found = await new AutoconfigDiscovery(net).discover("poczta.example.pl");

    expect(found).toEqual({
      source: "dns",
      imap: {
        host: "imap1.poczta.example.pl",
        port: 1993,
        security: "tls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password"],
      },
      smtp: {
        host: "smtp.poczta.example.pl",
        port: 587,
        security: "starttls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password"],
      },
    });
    expect(net.requests).toEqual([PROVIDER, ISPDB]);
    expect(net.lookups).toEqual([
      "_imaps._tcp.poczta.example.pl",
      "_submissions._tcp.poczta.example.pl",
      "_submission._tcp.poczta.example.pl",
    ]);
  });

  it("falls back from _imaps to _imap (STARTTLS) and treats a '.' target as 'no such service'", async () => {
    const net = fakeNetwork({
      files: {},
      srv: {
        "_imaps._tcp.poczta.example.pl": [{ name: ".", port: 0, priority: 0, weight: 0 }],
        "_imap._tcp.poczta.example.pl": [
          { name: "imap.poczta.example.pl", port: 143, priority: 0, weight: 0 },
        ],
      },
    });
    const found = await new AutoconfigDiscovery(net).discover("poczta.example.pl");
    expect(found?.imap).toMatchObject({
      host: "imap.poczta.example.pl",
      port: 143,
      security: "starttls",
    });
    expect(found?.smtp).toBeUndefined();
  });

  it("answers null (manual setup) when no source knows the domain, or the domain is unusable", async () => {
    const net = fakeNetwork({ files: {}, srv: {} });
    const discovery = new AutoconfigDiscovery(net);
    expect(await discovery.discover("poczta.example.pl")).toBeNull();
    expect(net.lookups).toEqual(["_imaps._tcp.poczta.example.pl", "_imap._tcp.poczta.example.pl"]);

    const before = net.requests.length;
    expect(await discovery.discover("evil.com/../x")).toBeNull();
    expect(await discovery.discover("me@poczta.example.pl")).toBeNull();
    expect(net.requests.length).toBe(before);
  });

  it("puts nothing but the domain into requests and lookups", async () => {
    const net = fakeNetwork({ files: {}, srv: {} });
    await new AutoconfigDiscovery(net).discover("poczta.example.pl");
    for (const text of [...net.requests, ...net.lookups]) {
      expect(text).not.toMatch(/@|%40|password/i);
      expect(text).toContain("poczta.example.pl");
    }
  });
});

describe("lookup through MX (ADR 0023)", () => {
  const DOMAIN = "firma.example.pl";
  const ispdb = (d: string) => `https://autoconfig.thunderbird.net/v1.1/${d}`;

  it("names the domains of an exchanger, most specific first", () => {
    expect(mxDomains("mx1.mail.ovh.net.")).toEqual(["mail.ovh.net", "ovh.net"]);
    expect(mxDomains("mx.zoho.eu")).toEqual(["zoho.eu"]);
    expect(mxDomains("localhost")).toEqual([]);
  });

  it("asks ISPDB about the host running the domain's mail, down to the name it knows", async () => {
    const net = fakeNetwork({
      files: { [ispdb("ovh.net")]: fixture("gmail-like.xml") },
      srv: {},
      mx: { [DOMAIN]: ["mx1.mail.ovh.net", "mx2.mail.ovh.net"] },
    });
    const found = await new AutoconfigDiscovery(net).discover(DOMAIN);
    expect(found?.source).toBe("mx");
    expect(found?.imap.host).toBe("imap.mail.example.com");
    expect(net.requests).toContain(ispdb("mail.ovh.net"));
    expect(net.probes).toEqual([]);
    // Everything about the user's own domain was asked first.
    expect(net.requests.indexOf(ispdb(DOMAIN))).toBeLessThan(
      net.requests.indexOf(ispdb("ovh.net")),
    );
    expect(net.requests.filter((r) => r === ispdb("mail.ovh.net"))).toHaveLength(1);
  });

  it("leads a custom domain on Microsoft's mail to its servers, which take no password (ADR 0114)", async () => {
    const net = fakeNetwork({
      files: { [ispdb("outlook.com")]: fixture("microsoft-like.xml") },
      srv: {},
      mx: { [DOMAIN]: ["firma-example-pl.mail.protection.outlook.com"] },
    });
    const found = await new AutoconfigDiscovery(net).discover(DOMAIN);
    expect(found?.source).toBe("mx");
    expect(found?.imap).toMatchObject({
      host: "outlook.office365.com",
      auth: ["password", "oauth2"],
    });
    // Password sign-in is listed, and still not offered.
    expect(found && takesPassword(found)).toBe(false);
  });

  it("probes the usual names at the domain when nothing is published", async () => {
    const net = fakeNetwork({
      files: {},
      srv: {},
      mx: { [DOMAIN]: [`mx.${DOMAIN}`] },
      answering: [`imap:mail.${DOMAIN}:993`, `smtp:mail.${DOMAIN}:587`],
    });
    expect(await new AutoconfigDiscovery(net).discover(DOMAIN)).toEqual({
      source: "probe",
      imap: {
        host: `mail.${DOMAIN}`,
        port: 993,
        security: "tls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password"],
      },
      smtp: {
        host: `mail.${DOMAIN}`,
        port: 587,
        security: "starttls",
        usernameTemplate: "%EMAILADDRESS%",
        auth: ["password"],
      },
    });
    expect(net.probes).toContain(`imap:mx.${DOMAIN}:993`);
  });

  it("does not knock on a third party's exchanger", async () => {
    const net = fakeNetwork({ files: {}, srv: {}, mx: { [DOMAIN]: ["mx.example.net"] } });
    expect(await new AutoconfigDiscovery(net).discover(DOMAIN)).toBeNull();
    expect(net.probes.some((p) => p.includes("example.net"))).toBe(false);
  });
});

describe("probeServer", () => {
  const servers: Server[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });
  const server = (greeting: string, replies: Record<string, string> = {}) =>
    new Promise<number>((resolve) => {
      const s = createServer((socket) => {
        socket.on("error", () => {});
        socket.write(greeting);
        socket.on("data", (d) => {
          const reply = replies[d.toString().trim()];
          if (reply) socket.write(reply);
        });
      });
      servers.push(s);
      s.listen(0, "127.0.0.1", () => {
        const a = s.address();
        resolve(typeof a === "object" && a ? a.port : 0);
      });
    });

  it("accepts an IMAP server offering STARTTLS, not one without it", async () => {
    const yes = await server("* OK ready\r\n", {
      "a CAPABILITY": "* CAPABILITY IMAP4rev1 STARTTLS\r\na OK done\r\n",
    });
    const no = await server("* OK ready\r\n", {
      "a CAPABILITY": "* CAPABILITY IMAP4rev1\r\na OK done\r\n",
    });
    expect(await probeServer("imap", "127.0.0.1", yes, "starttls", 1000)).toBe(true);
    expect(await probeServer("imap", "127.0.0.1", no, "starttls", 1000)).toBe(false);
  });

  it("reads a multi-line SMTP answer to the end", async () => {
    const port = await server("220 mail ready\r\n", {
      "EHLO matters.local": "250-mail\r\n250-SIZE 1000\r\n250 STARTTLS\r\n",
    });
    expect(await probeServer("smtp", "127.0.0.1", port, "starttls", 1000)).toBe(true);
  });

  it("says no to the wrong protocol, a closed port, silence and a server with no valid TLS", async () => {
    const web = await server("HTTP/1.1 400 Bad Request\r\n");
    expect(await probeServer("imap", "127.0.0.1", web, "starttls", 1000)).toBe(false);
    expect(await probeServer("imap", "127.0.0.1", 1, "starttls", 1000)).toBe(false);
    const silent = await server("");
    expect(await probeServer("smtp", "127.0.0.1", silent, "starttls", 50)).toBe(false);
    expect(await probeServer("imap", "127.0.0.1", silent, "tls", 50)).toBe(false);
  });
});
