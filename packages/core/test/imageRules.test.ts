import { describe, expect, it } from "vitest";
import type {
  GeneralImages,
  ImageRule,
  ImageRuleDecision,
  ImageRuleScope,
  ImageRuleStorePort,
  SenderAuth,
  UnitOfWorkPort,
} from "../src/index.ts";
import {
  addressHost,
  chooseImages,
  decideImages,
  importImageAddresses,
  offerImageRules,
  PUBLIC_MAIL_PROVIDERS,
  planStop,
  removeImageRule,
  setGeneralImages,
  setImageRule,
  stopImages,
} from "../src/index.ts";

const rule = (scope: ImageRuleScope, value: string, decision: ImageRuleDecision): ImageRule => ({
  scope,
  value,
  decision,
  createdMs: 1,
});

const ADDRESS = "news@mail.shop.example";
const DOMAIN = "shop.example";
const VERDICTS: readonly SenderAuth[] = ["pass", "unknown", "fail"];

/** A stand-in for the Public Suffix List that knows `co.uk` and plain two-label domains. */
function registrableDomain(host: string): string | undefined {
  const labels = host.split(".");
  const suffix = labels.slice(-2).join(".") === "co.uk" ? 2 : 1;
  return labels.length > suffix ? labels.slice(-(suffix + 1)).join(".") : undefined;
}

function decide(
  verdict: SenderAuth,
  rules: readonly ImageRule[] = [],
  general: GeneralImages = "ask",
) {
  return decideImages({ address: ADDRESS, domain: DOMAIN, verdict, rules, general });
}

describe("decideImages (ADR 0037)", () => {
  it("shows nothing when nothing has an answer", () => {
    for (const v of VERDICTS) expect(decide(v)).toEqual({ show: false, source: "none" });
  });

  describe("address allow", () => {
    const rules = [rule("address", ADDRESS, "allow")];
    it("applies unless the verdict is fail", () => {
      expect(decide("pass", rules)).toEqual({ show: true, source: "address-allow" });
      expect(decide("unknown", rules)).toEqual({ show: true, source: "address-allow" });
      expect(decide("fail", rules)).toEqual({ show: false, source: "none" });
    });
  });

  describe("domain allow", () => {
    const rules = [rule("domain", DOMAIN, "allow")];
    it("applies only on pass", () => {
      expect(decide("pass", rules)).toEqual({ show: true, source: "domain-allow" });
      expect(decide("unknown", rules)).toEqual({ show: false, source: "none" });
      expect(decide("fail", rules)).toEqual({ show: false, source: "none" });
    });
  });

  describe("general always", () => {
    it("applies unless the verdict is fail", () => {
      expect(decide("pass", [], "always")).toEqual({ show: true, source: "always" });
      expect(decide("unknown", [], "always")).toEqual({ show: true, source: "always" });
      expect(decide("fail", [], "always")).toEqual({ show: false, source: "none" });
    });
  });

  describe("deny", () => {
    it("always applies, whatever the verdict and the broader levels", () => {
      for (const v of VERDICTS) {
        expect(decide(v, [rule("address", ADDRESS, "deny")], "always")).toEqual({
          show: false,
          source: "address-deny",
        });
        expect(decide(v, [rule("domain", DOMAIN, "deny")], "always")).toEqual({
          show: false,
          source: "domain-deny",
        });
      }
    });

    it("lets an address deny win over a domain allow, and an address allow over a domain deny", () => {
      expect(
        decide("pass", [rule("address", ADDRESS, "deny"), rule("domain", DOMAIN, "allow")]),
      ).toEqual({ show: false, source: "address-deny" });
      expect(
        decide("pass", [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "deny")]),
      ).toEqual({ show: true, source: "address-allow" });
    });
  });

  describe("a rule that does not apply is skipped and the walk goes on", () => {
    it("falls from an address allow on fail to a domain deny", () => {
      expect(
        decide("fail", [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "deny")]),
      ).toEqual({ show: false, source: "domain-deny" });
    });

    it("falls from a domain allow on unknown to always", () => {
      expect(decide("unknown", [rule("domain", DOMAIN, "allow")], "always")).toEqual({
        show: true,
        source: "always",
      });
    });

    it("falls from an address allow on fail past a domain allow and always to none", () => {
      expect(
        decide(
          "fail",
          [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "allow")],
          "always",
        ),
      ).toEqual({ show: false, source: "none" });
    });

    it("takes the address allow before the domain allow", () => {
      expect(
        decide("pass", [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "allow")]),
      ).toEqual({ show: true, source: "address-allow" });
    });
  });

  it("compares addresses in lower case and ignores rules for other senders and scopes", () => {
    const decided = decideImages({
      address: "  News@Mail.Shop.Example ",
      domain: DOMAIN,
      verdict: "pass",
      rules: [
        rule("address", "other@mail.shop.example", "deny"),
        rule("domain", ADDRESS, "deny"),
        rule("address", ADDRESS, "allow"),
      ],
      general: "ask",
    });
    expect(decided).toEqual({ show: true, source: "address-allow" });
  });

  it("has no domain level for a sender without a registrable domain", () => {
    const rules = [rule("domain", "co.uk", "allow")];
    expect(
      decideImages({
        address: "a@co.uk",
        domain: undefined,
        verdict: "pass",
        rules,
        general: "ask",
      }),
    ).toEqual({ show: false, source: "none" });
  });
});

describe("offerImageRules", () => {
  it("offers the address unless the verdict is fail", () => {
    expect(offerImageRules("pass", DOMAIN).offerAddress).toBe(true);
    expect(offerImageRules("unknown", DOMAIN).offerAddress).toBe(true);
    expect(offerImageRules("fail", DOMAIN).offerAddress).toBe(false);
  });

  it("offers the domain only on pass, off the provider list, with a registrable domain", () => {
    expect(offerImageRules("pass", DOMAIN).offerDomain).toBe(DOMAIN);
    expect(offerImageRules("unknown", DOMAIN).offerDomain).toBeNull();
    expect(offerImageRules("fail", DOMAIN).offerDomain).toBeNull();
    expect(offerImageRules("pass", undefined).offerDomain).toBeNull();
  });

  it("never offers a domain rule for a public mail provider", () => {
    expect(PUBLIC_MAIL_PROVIDERS.size).toBe(30);
    for (const provider of PUBLIC_MAIL_PROVIDERS) {
      expect(offerImageRules("pass", provider)).toEqual({ offerAddress: true, offerDomain: null });
    }
    expect(PUBLIC_MAIL_PROVIDERS.has("wp.pl")).toBe(true);
    expect(PUBLIC_MAIL_PROVIDERS.has("gmail.com")).toBe(true);
  });
});

describe("planStop", () => {
  const stop = (
    source: "address-allow" | "domain-allow" | "always",
    rules: readonly ImageRule[],
    general: GeneralImages = "ask",
    domain: string | null = DOMAIN,
  ) => planStop({ source, address: ADDRESS, domain: domain ?? undefined, rules, general });

  it("removes an address allow and writes nothing else when nothing broader allows", () => {
    expect(stop("address-allow", [rule("address", ADDRESS, "allow")])).toEqual({
      remove: { scope: "address", value: ADDRESS },
      denyAddress: false,
    });
  });

  it("denies the address when a domain allow would still allow it, whatever the verdict", () => {
    expect(
      stop("address-allow", [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "allow")]),
    ).toEqual({ remove: { scope: "address", value: ADDRESS }, denyAddress: true });
  });

  it("denies the address when always would still allow it", () => {
    expect(stop("address-allow", [rule("address", ADDRESS, "allow")], "always").denyAddress).toBe(
      true,
    );
  });

  it("removes a domain allow and does not deny without a broader allow", () => {
    expect(stop("domain-allow", [rule("domain", DOMAIN, "allow")])).toEqual({
      remove: { scope: "domain", value: DOMAIN },
      denyAddress: false,
    });
  });

  it("removes a domain allow and denies the address when always would still allow it", () => {
    expect(stop("domain-allow", [rule("domain", DOMAIN, "allow")], "always")).toEqual({
      remove: { scope: "domain", value: DOMAIN },
      denyAddress: true,
    });
  });

  it("keeps an address allow when the domain allow is stopped, then denies the address", () => {
    // Not reachable from the bar (the address rule would have decided), but the rules decide.
    expect(
      stop("domain-allow", [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "allow")]),
    ).toEqual({ remove: { scope: "domain", value: DOMAIN }, denyAddress: true });
  });

  it("removes nothing for always and denies the address", () => {
    expect(stop("always", [], "always")).toEqual({ remove: null, denyAddress: true });
  });

  it("does not deny when a domain deny already blocks the sender", () => {
    expect(
      stop(
        "address-allow",
        [rule("address", ADDRESS, "allow"), rule("domain", DOMAIN, "deny")],
        "always",
      ).denyAddress,
    ).toBe(false);
  });

  it("has no domain to remove for a sender without one", () => {
    expect(stop("domain-allow", [], "ask", null)).toEqual({ remove: null, denyAddress: false });
  });
});

describe("addressHost", () => {
  it("is the part after the last @, lower case, without a trailing dot", () => {
    expect(addressHost("A@Mail.Example.COM.")).toBe("mail.example.com");
    expect(addressHost('"a@b"@x.example')).toBe("x.example");
    expect(addressHost("nobody")).toBe("");
  });
});

/** The write side over a Map, with a unit of work that runs the work as is. */
function rig() {
  const rules = new Map<string, ImageRule>();
  let general: GeneralImages = "ask";
  const key = (scope: string, value: string) => `${scope}|${value}`;
  const store: ImageRuleStorePort = {
    async get(scope, value) {
      return rules.get(key(scope, value)) ?? null;
    },
    async list() {
      return [...rules.values()];
    },
    async put(r) {
      rules.set(key(r.scope, r.value), r);
    },
    async putIfAbsent(list) {
      let added = 0;
      for (const r of list) {
        if (rules.has(key(r.scope, r.value))) continue;
        rules.set(key(r.scope, r.value), r);
        added++;
      }
      return added;
    },
    async remove(scope, value) {
      return rules.delete(key(scope, value));
    },
    async getGeneral() {
      return general;
    },
    async setGeneral(value) {
      general = value;
    },
  };
  const uow: UnitOfWorkPort = { run: (work) => work() };
  return {
    rules,
    deps: { rules: store, registrableDomain, uow, now: () => 42 },
    has: (scope: string, value: string) => rules.get(key(scope, value))?.decision,
  };
}

describe("chooseImages", () => {
  it("looks up by key and reports decision, verdict, address, domain and offers together", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "domain", value: DOMAIN, decision: "allow" });
    const choice = await chooseImages(r.deps, "News@Mail.Shop.Example", "pass");
    expect(choice).toEqual({
      show: true,
      source: "domain-allow",
      verdict: "pass",
      address: ADDRESS,
      domain: DOMAIN,
      offerAddress: true,
      offerDomain: DOMAIN,
    });
    expect(await chooseImages(r.deps, ADDRESS, "fail")).toMatchObject({
      show: false,
      source: "none",
      offerAddress: false,
      offerDomain: null,
    });
  });

  it("has no domain for a public suffix alone", async () => {
    const r = rig();
    expect(await chooseImages(r.deps, "a@co.uk", "pass")).toMatchObject({
      domain: null,
      offerDomain: null,
    });
  });
});

describe("setImageRule", () => {
  it("lower-cases, stamps the time, and replaces a deny with an allow", async () => {
    const r = rig();
    await setImageRule(r.deps, {
      scope: "address",
      value: " News@Shop.Example ",
      decision: "deny",
    });
    expect(r.has("address", "news@shop.example")).toBe("deny");
    const again = await setImageRule(r.deps, {
      scope: "address",
      value: "news@shop.example",
      decision: "allow",
    });
    expect(again.createdMs).toBe(42);
    expect(r.has("address", "news@shop.example")).toBe("allow");
    expect(r.rules.size).toBe(1);
  });

  it("refuses what is not an address, and a domain that is not registrable", async () => {
    const r = rig();
    for (const value of [
      "",
      "nobody",
      "@x.example",
      "a@",
      "a b@x.example",
      `${"a".repeat(400)}@x.example`,
    ]) {
      await expect(
        setImageRule(r.deps, { scope: "address", value, decision: "allow" }),
      ).rejects.toMatchObject({ name: "InvalidImageRuleError" });
    }
    for (const value of ["co.uk", "mail.shop.example", "localhost", ""]) {
      await expect(
        setImageRule(r.deps, { scope: "domain", value, decision: "allow" }),
      ).rejects.toMatchObject({ name: "InvalidImageRuleError" });
    }
    await setImageRule(r.deps, { scope: "domain", value: "Shop.co.uk", decision: "allow" });
    expect(r.has("domain", "shop.co.uk")).toBe("allow");
    expect(r.rules.size).toBe(1);
  });
});

describe("stopImages", () => {
  it("removes an address allow and leaves the list empty", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "address", value: ADDRESS, decision: "allow" });
    await stopImages(r.deps, { address: ADDRESS, source: "address-allow" });
    expect(r.rules.size).toBe(0);
  });

  it("removes the address allow and writes a deny when the domain rule would still allow", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "address", value: ADDRESS, decision: "allow" });
    await setImageRule(r.deps, { scope: "domain", value: DOMAIN, decision: "allow" });
    await stopImages(r.deps, { address: ADDRESS, source: "address-allow" });
    expect(r.has("address", ADDRESS)).toBe("deny");
    expect(r.has("domain", DOMAIN)).toBe("allow");
  });

  it("denies the address for always, and the same stop twice changes nothing more", async () => {
    const r = rig();
    await setGeneralImages(r.deps, "always");
    await stopImages(r.deps, { address: ADDRESS, source: "always" });
    expect(r.has("address", ADDRESS)).toBe("deny");
    await stopImages(r.deps, { address: ADDRESS, source: "always" });
    expect(r.rules.size).toBe(1);
  });

  it("removes a domain allow", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "domain", value: DOMAIN, decision: "allow" });
    await stopImages(r.deps, { address: ADDRESS, source: "domain-allow" });
    expect(r.rules.size).toBe(0);
  });

  it("refuses something that is not an address", async () => {
    await expect(
      stopImages(rig().deps, { address: "nope", source: "always" }),
    ).rejects.toMatchObject({ name: "InvalidImageRuleError" });
  });
});

describe("removeImageRule", () => {
  it("removes by lower-cased value and says whether it was there", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "address", value: ADDRESS, decision: "allow" });
    expect(await removeImageRule(r.deps, "address", ADDRESS.toUpperCase())).toBe(true);
    expect(await removeImageRule(r.deps, "address", ADDRESS)).toBe(false);
  });
});

describe("importImageAddresses", () => {
  it("adds allow rules in lower case, skips junk and duplicates, and counts what went in", async () => {
    const r = rig();
    const added = await importImageAddresses(r.deps, [
      "A@x.example",
      "a@X.example",
      "not an address",
      "",
      "b@x.example",
    ]);
    expect(added).toBe(2);
    expect(r.has("address", "a@x.example")).toBe("allow");
    expect(r.has("address", "b@x.example")).toBe("allow");
  });

  it("leaves an existing rule alone, so a repeat or a later deny is not undone", async () => {
    const r = rig();
    await setImageRule(r.deps, { scope: "address", value: "a@x.example", decision: "deny" });
    expect(await importImageAddresses(r.deps, ["a@x.example", "c@x.example"])).toBe(1);
    expect(r.has("address", "a@x.example")).toBe("deny");
    expect(await importImageAddresses(r.deps, ["c@x.example"])).toBe(0);
  });

  it("refuses an absurdly long list", async () => {
    await expect(
      importImageAddresses(rig().deps, new Array(50_001).fill("a@x.example")),
    ).rejects.toMatchObject({ name: "InvalidImageRuleError" });
  });
});
