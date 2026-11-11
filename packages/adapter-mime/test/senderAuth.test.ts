import { registrableDomain } from "@matters/adapter-publicsuffix";
import type { ParseContext } from "@matters/core";
import { describe, expect, it } from "vitest";
import { authservId, firstTrustedHeader, PostalMimeParser, readSenderAuth } from "../src/index.ts";

const FROM = "news@mail.shop.example";
const read = (header: string | undefined, from: string | undefined = FROM) =>
  readSenderAuth(header, from, registrableDomain);

describe("readSenderAuth: DMARC decides (ADR 0037)", () => {
  it("passes on dmarc=pass and fails on dmarc=fail", () => {
    expect(read("mx.example; dmarc=pass header.from=shop.example")).toBe("pass");
    expect(read("mx.example; dmarc=fail header.from=shop.example")).toBe("fail");
  });

  it("reads the method and the result without regard to case or spacing", () => {
    expect(read("MX.EXAMPLE; DMARC=PASS HEADER.FROM=SHOP.EXAMPLE")).toBe("pass");
    expect(read("mx.example;\n\tDmArC = Fail")).toBe("fail");
    expect(read("mx.example ; dmarc =pass header.from=shop.example")).toBe("pass");
  });

  it("lets a failing DMARC win over an aligned DKIM pass", () => {
    expect(read("mx.example; dkim=pass header.d=shop.example; dmarc=fail")).toBe("fail");
  });

  it("lets a failure win over a pass when the header holds both", () => {
    expect(read("mx.example; dmarc=pass header.from=shop.example; dmarc=fail")).toBe("fail");
  });

  it("finds the result among other methods and properties", () => {
    expect(
      read(
        "mx.example 1; spf=pass smtp.mailfrom=bounce@shop.example; dkim=fail header.d=x.example; dmarc=pass (p=reject) action=none header.from=shop.example",
      ),
    ).toBe("pass");
  });
});

describe("readSenderAuth: without a DMARC result, an aligned DKIM pass counts", () => {
  it.each(["none", "temperror", "permerror", "policy", "bestguesspass"])(
    "falls back to DKIM on dmarc=%s",
    (result) => {
      expect(read(`mx.example; dmarc=${result}; dkim=pass header.d=shop.example`)).toBe("pass");
      expect(read(`mx.example; dmarc=${result}; dkim=fail header.d=shop.example`)).toBe("unknown");
    },
  );

  it("passes on an aligned dkim=pass from header.d, with a subdomain on either side", () => {
    expect(read("mx.example; dkim=pass header.d=shop.example")).toBe("pass");
    expect(read("mx.example; dkim=pass header.d=mail.shop.example")).toBe("pass");
    expect(read("mx.example; dkim=pass header.d=other.shop.example")).toBe("pass");
  });

  it("takes the signing domain from header.i when header.d is absent", () => {
    expect(read("mx.example; dkim=pass header.i=@shop.example")).toBe("pass");
    expect(read("mx.example; dkim=pass header.i=bounce@mail.shop.example")).toBe("pass");
    expect(read("mx.example; dkim=pass header.i=@other.example")).toBe("unknown");
  });

  it("does not count a signature of another domain", () => {
    expect(read("mx.example; dkim=pass header.d=evil.example")).toBe("unknown");
    expect(read("mx.example; dkim=pass header.d=shop.example.evil.example")).toBe("unknown");
    expect(read("mx.example; dkim=pass header.d=notshop.example")).toBe("unknown");
  });

  it("counts any aligned pass among several DKIM results", () => {
    expect(
      read(
        "mx.example; dkim=pass header.d=esp.example; dkim=fail header.d=shop.example; dkim=pass header.d=shop.example",
      ),
    ).toBe("pass");
    expect(
      read("mx.example; dkim=pass header.d=esp.example; dkim=pass header.d=other.example"),
    ).toBe("unknown");
  });

  it("does not align on a public suffix alone", () => {
    expect(read("mx.example; dkim=pass header.d=co.uk", "a@co.uk")).toBe("unknown");
    expect(read("mx.example; dkim=pass header.d=a.co.uk", "x@b.co.uk")).toBe("unknown");
    expect(read("mx.example; dkim=pass header.d=shop.co.uk", "x@mail.shop.co.uk")).toBe("pass");
  });

  it("does not let a sibling under a shared suffix align", () => {
    expect(read("mx.example; dkim=pass header.d=other.co.uk", "x@shop.co.uk")).toBe("unknown");
  });
});

describe("readSenderAuth: everything else is unknown", () => {
  it("has no verdict without a header, an empty one, one without results, or a bad From", () => {
    expect(read(undefined)).toBe("unknown");
    expect(read("")).toBe("unknown");
    expect(read("mx.example; none")).toBe("unknown");
    expect(read("mx.example")).toBe("unknown");
    expect(readSenderAuth("mx.example; dmarc=pass", undefined, registrableDomain)).toBe("unknown");
    expect(read("mx.example; dmarc=pass", "no-at-sign")).toBe("unknown");
    expect(read("mx.example; dkim=pass header.d=shop.example", "x@")).toBe("unknown");
  });

  it("does not read the authserv-id as a result", () => {
    expect(read("dmarc=pass; spf=pass")).toBe("unknown");
  });

  it("is unknown for spf alone and for dkim=fail", () => {
    expect(read("mx.example; spf=pass smtp.mailfrom=shop.example")).toBe("unknown");
    expect(read("mx.example; dkim=fail header.d=shop.example")).toBe("unknown");
    expect(read("mx.example; dkim=neutral header.d=shop.example")).toBe("unknown");
  });
});

describe("readSenderAuth: forged text is not a result", () => {
  it("ignores a result inside a comment", () => {
    expect(read("mx.example; dmarc=fail (dkim=pass header.d=shop.example)")).toBe("fail");
    expect(read("mx.example; spf=none (dmarc=pass)")).toBe("unknown");
    expect(read("mx.example (dmarc=pass); dkim=fail")).toBe("unknown");
    expect(read("mx.example; (dmarc=pass) dkim=fail header.d=shop.example")).toBe("unknown");
  });

  it("ignores a result inside nested comments, quoted pairs and an unclosed comment", () => {
    expect(read("mx.example; spf=none (a (b) dmarc=pass)")).toBe("unknown");
    expect(read("mx.example; spf=none (a \\) dmarc=pass)")).toBe("unknown");
    expect(read("mx.example; spf=none (dmarc=pass")).toBe("unknown");
    expect(read("mx.example; spf=none (a (b) c; dmarc=pass")).toBe("unknown");
  });

  it("ignores a result inside a quoted string, however it is spelled", () => {
    expect(read('mx.example; reason="x; dmarc=pass"; spf=none')).toBe("unknown");
    expect(read('mx.example; spf=none reason="dmarc=pass; dmarc=pass"')).toBe("unknown");
    expect(read('mx.example; spf=none smtp.helo="a\\"; dmarc=pass; b"')).toBe("unknown");
    expect(read('mx.example; spf=none "; dmarc=pass')).toBe("unknown");
  });

  it("does not take a quoted word for a method or a result", () => {
    expect(read('mx.example; "dmarc"=pass')).toBe("unknown");
    expect(read('mx.example; dmarc="pass"')).toBe("unknown");
  });

  it("keeps parentheses inside a quoted string out of comment handling", () => {
    expect(read('mx.example; spf=none reason="a ( b"; dmarc=pass header.from=shop.example')).toBe(
      "pass",
    );
    expect(read('mx.example; reason="a ) b"; dmarc=fail')).toBe("fail");
  });

  it("does not let a repeated property override the first", () => {
    expect(read("mx.example; dkim=pass header.d=evil.example header.d=shop.example")).toBe(
      "unknown",
    );
  });

  it("takes a result that only looks like part of a value apart", () => {
    // `dmarc=pass` glued to a property value is part of that value, not a result.
    expect(read("mx.example; spf=pass smtp.mailfrom=a@b.example;dmarc=fail")).toBe("fail");
    expect(read("mx.example; header.from=dmarc=pass")).toBe("unknown");
  });
});

describe("readSenderAuth: a dmarc=pass is about the From the reader sees (ADR 0048)", () => {
  it("counts a pass whose header.from has the registrable domain of the From", () => {
    expect(read("mx.example; dmarc=pass header.from=shop.example")).toBe("pass");
    expect(read("mx.example; dmarc=pass header.from=mail.shop.example")).toBe("pass");
    expect(read("mx.example; dmarc=pass header.from=news@shop.example")).toBe("pass");
    expect(read("mx.example; dmarc=pass header.from=SHOP.example.")).toBe("pass");
  });

  it("does not count a pass for another domain, or one that names none", () => {
    expect(read("mx.example; dmarc=pass header.from=other.example")).toBe("unknown");
    expect(read("mx.example; dmarc=pass header.from=shop.example.evil.example")).toBe("unknown");
    expect(read("mx.example; dmarc=pass")).toBe("unknown");
    expect(read('mx.example; dmarc=pass header.from=""')).toBe("unknown");
  });

  it("does not fall back to DKIM when DMARC passed for something else", () => {
    expect(
      read("mx.example; dmarc=pass header.from=other.example; dkim=pass header.d=shop.example"),
    ).toBe("unknown");
  });

  it("keeps a failure a failure, whatever header.from names", () => {
    expect(read("mx.example; dmarc=fail header.from=other.example")).toBe("fail");
    expect(read("mx.example; dmarc=fail")).toBe("fail");
  });

  it("counts any aligned pass among several", () => {
    expect(
      read("mx.example; dmarc=pass header.from=other.example; dmarc=pass header.from=shop.example"),
    ).toBe("pass");
  });
});

describe("authservId", () => {
  it("is the first word, lower case, without a trailing dot or a version", () => {
    expect(authservId("MX.Example.; dmarc=pass")).toBe("mx.example");
    expect(authservId("mx.example 1; dmarc=pass")).toBe("mx.example");
    expect(authservId("mx.example")).toBe("mx.example");
    expect(authservId("(a comment) mx.example; dmarc=pass")).toBe("mx.example");
  });

  it("is none when the header starts with a result, as Microsoft's commonly does", () => {
    expect(
      authservId("spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=shop.example; dkim=pass"),
    ).toBe(undefined);
    expect(authservId("dmarc=pass")).toBe(undefined);
  });

  it("is none for an empty header, a quoted first segment or a header of separators", () => {
    expect(authservId("")).toBe(undefined);
    expect(authservId('"mx.example"; dmarc=pass')).toBe(undefined);
    expect(authservId("; dmarc=pass")).toBe(undefined);
  });
});

describe("firstTrustedHeader", () => {
  const trusted = (id: string) => id === "mx.example";

  it("is the topmost header with a trusted id, and ignores the others", () => {
    expect(
      firstTrustedHeader(
        ["evil.example; dmarc=pass", "mx.example; dmarc=fail", "mx.example; a"],
        trusted,
      ),
    ).toBe("mx.example; dmarc=fail");
  });

  it("is none when no header has a trusted id, or the list of trusted ids is not given", () => {
    expect(firstTrustedHeader(["evil.example; dmarc=pass"], trusted)).toBe(undefined);
    expect(firstTrustedHeader(["mx.example; dmarc=pass"], undefined)).toBe(undefined);
    expect(firstTrustedHeader([], trusted)).toBe(undefined);
  });

  it("never trusts a header without an id", () => {
    expect(firstTrustedHeader(["dmarc=pass header.from=shop.example"], () => true)).toBe(undefined);
  });
});

describe("PostalMimeParser.senderAuth", () => {
  const parser = new PostalMimeParser({ registrableDomain });
  // The account's server writes `mx.example`; nothing else is trusted (ADR 0048).
  const context = { isTrustedAuthServ: (id: string) => id === "mx.example" };
  const parse = (lines: readonly string[], ctx: ParseContext | null = context) =>
    parser.parse(
      new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\nbody\r\n`),
      ctx ?? undefined,
    );
  const base = [
    "From: News <news@mail.shop.example>",
    "Subject: Hi",
    "Date: Tue, 03 Nov 2026 09:30:00 +0100",
  ];

  it("reads the topmost header with a trusted id, and no other", async () => {
    const top = await parse([
      "Authentication-Results: mx.example; dmarc=pass header.from=shop.example",
      "Authentication-Results: sender.example; dmarc=fail",
      ...base,
    ]);
    expect(top.senderAuth).toBe("pass");
    const forgedBelow = await parse([
      "Authentication-Results: mx.example; dmarc=fail",
      "Authentication-Results: sender.example; dmarc=pass header.from=shop.example",
      ...base,
    ]);
    expect(forgedBelow.senderAuth).toBe("fail");
    // A server that appends its header leaves a forged one above it.
    const forgedAbove = await parse([
      "Authentication-Results: sender.example; dmarc=pass header.from=shop.example",
      "Authentication-Results: mx.example; dmarc=fail",
      ...base,
    ]);
    expect(forgedAbove.senderAuth).toBe("fail");
    const forgedOnly = await parse([
      "Received: from x by mx.example",
      "Authentication-Results: mx.example; spf=none",
      "Authentication-Results: sender.example; dmarc=pass header.from=shop.example",
      ...base,
    ]);
    expect(forgedOnly.senderAuth).toBe("unknown");
  });

  it("is unknown when the caller trusts no id, or gives no context", async () => {
    const lines = [
      "Authentication-Results: mx.example; dmarc=pass header.from=shop.example",
      ...base,
    ];
    expect((await parse(lines, null)).senderAuth).toBe("unknown");
    expect((await parse(lines, {})).senderAuth).toBe("unknown");
    expect((await parse(lines, { isTrustedAuthServ: () => false })).senderAuth).toBe("unknown");
  });

  it("trusts nothing in a header that starts with a result, as Microsoft's commonly does", async () => {
    const parsed = await parse(
      [
        "Authentication-Results: spf=pass smtp.mailfrom=shop.example; dmarc=pass header.from=shop.example",
        ...base,
      ],
      { isTrustedAuthServ: () => true },
    );
    expect(parsed.senderAuth).toBe("unknown");
  });

  it("cannot tell a forged header from the server's when both carry the trusted id", async () => {
    // RFC 8601 section 5: a trusted server removes any header with its own id before adding
    // its own. If it does not, the topmost header wins, and a sender can win by writing the id.
    const parsed = await parse([
      "Authentication-Results: mx.example; dmarc=pass header.from=shop.example",
      "Authentication-Results: mx.example; dmarc=fail header.from=shop.example",
      ...base,
    ]);
    expect(parsed.senderAuth).toBe("pass");
  });

  it("matches the header name in any case and unfolds a folded value", async () => {
    const parsed = await parse([
      "AUTHENTICATION-RESULTS: mx.example;",
      "\tspf=pass smtp.mailfrom=a@shop.example;",
      " dkim=pass",
      "  header.d=shop.example (ok);",
      " dmarc=none",
      ...base,
    ]);
    expect(parsed.senderAuth).toBe("pass");
  });

  it("is unknown without the header", async () => {
    expect((await parse(base)).senderAuth).toBe("unknown");
  });

  it("is unknown when From has several addresses, several headers, a group, or none", async () => {
    const auth = "Authentication-Results: mx.example; dmarc=pass header.from=shop.example";
    const rest = ["Subject: Hi"];
    expect((await parse([auth, "From: a@shop.example, b@evil.example", ...rest])).senderAuth).toBe(
      "unknown",
    );
    expect(
      (await parse([auth, "From: a@shop.example", "From: b@evil.example", ...rest])).senderAuth,
    ).toBe("unknown");
    expect((await parse([auth, "From: Team: a@shop.example;", ...rest])).senderAuth).toBe(
      "unknown",
    );
    expect((await parse([auth, ...rest])).senderAuth).toBe("unknown");
  });

  it("aligns DKIM with the From domain through the injected function", async () => {
    const lines = [
      "Authentication-Results: mx.example; dkim=pass header.d=esp.shop.example",
      ...base,
    ];
    expect((await parse(lines)).senderAuth).toBe("pass");
    // Without the Public Suffix List only the very same host aligns.
    const strict = await new PostalMimeParser().parse(
      new TextEncoder().encode(`${lines.join("\r\n")}\r\n\r\nbody\r\n`),
      context,
    );
    expect(strict.senderAuth).toBe("unknown");
  });
});
