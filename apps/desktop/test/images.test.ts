import { makeMessage } from "@matters/testkit";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it } from "vitest";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { ImageRuleService } from "../src/backend/imageRuleService.ts";
import type { WorkerCommand } from "../src/backend/protocol.ts";
import { RemoteImageRules } from "../src/backend/remoteImageRules.ts";
import type { SyncHost } from "../src/backend/syncHost.ts";
import { imageDeps, noCounts, noSend, noViewWrites, registrableDomain } from "./support/noSend.ts";

/** The router's side over in-memory ports; writes go to the service the worker would run. */
function rig() {
  const storage = createInMemoryStorage();
  const changed: string[] = [];
  const service = new ImageRuleService({
    rules: storage.imageRules,
    registrableDomain,
    uow: storage.uow,
    now: () => 1000,
  });
  // A host that runs each command on the service, as the worker thread would.
  const host = {
    command: async (c: WorkerCommand) => {
      switch (c.name) {
        case "setImageRule":
          return service.setRule(c);
        case "removeImageRule":
          return service.removeRule(c.scope, c.value);
        case "stopImages":
          await service.stop(c);
          return null;
        case "setGeneralImages":
          await service.setGeneral(c.general);
          return null;
        case "importImageAddresses":
          return service.importAddresses(c.addresses);
        default:
          throw new Error(`unexpected ${c.name}`);
      }
    },
  } as unknown as SyncHost;
  const deps: BackendDeps = {
    ...storage,
    ...imageDeps,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    accounts: {
      discover: async () => null,
      list: async () => [],
      add: async () => {
        throw new Error("not used");
      },
      remove: async () => false,
      syncNow: async () => false,
      changePassword: async () => null,
    },
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    images: new RemoteImageRules(host, () => changed.push("changed")),
  };
  const call = (request: object) => handle(deps, { requestId: "r", ...request });
  async function mail(address: string, senderAuth: "pass" | "fail" | "unknown", html = "<p>x</p>") {
    const m = makeMessage({ from: { address }, senderAuth });
    await storage.store.upsertMessages([m]);
    await storage.bodies.putBodies([{ key: m.key, threadId: m.threadId, text: "x", html }]);
    return m.key;
  }
  return { storage, call, mail, changed };
}

const SENDER = "News@Mail.Shop.Example";

describe("getMessageHtml carries the decision (ADR 0037)", () => {
  it("answers none for an unknown sender, with the offers its verdict allows", async () => {
    const r = rig();
    const key = await r.mail(SENDER, "pass");
    expect(await r.call({ type: "getMessageHtml", key })).toEqual({
      type: "getMessageHtml",
      requestId: "r",
      ok: true,
      html: "<p>x</p>",
      images: {
        show: false,
        source: "none",
        verdict: "pass",
        address: "news@mail.shop.example",
        domain: "shop.example",
        offerAddress: true,
        offerDomain: "shop.example",
      },
    });
  });

  it("offers no allow for a failed sender, and no domain for a public provider", async () => {
    const r = rig();
    const failed = await r.mail(SENDER, "fail");
    expect(await r.call({ type: "getMessageHtml", key: failed })).toMatchObject({
      images: { verdict: "fail", offerAddress: false, offerDomain: null },
    });
    const gmail = await r.mail("someone@gmail.com", "pass");
    expect(await r.call({ type: "getImageChoice", key: gmail })).toMatchObject({
      images: { domain: "gmail.com", offerAddress: true, offerDomain: null },
    });
  });

  it("applies the rules by their keys, and the general setting", async () => {
    const r = rig();
    const key = await r.mail(SENDER, "pass");
    const choice = async () =>
      (
        (await r.call({ type: "getImageChoice", key })) as {
          images: { show: boolean; source: string };
        }
      ).images;

    await r.call({
      type: "setImageRule",
      scope: "domain",
      value: "Shop.Example",
      decision: "allow",
    });
    expect(await choice()).toMatchObject({ show: true, source: "domain-allow" });
    await r.call({ type: "setImageRule", scope: "address", value: SENDER, decision: "deny" });
    expect(await choice()).toMatchObject({ show: false, source: "address-deny" });
    await r.call({ type: "setImageRule", scope: "address", value: SENDER, decision: "allow" });
    expect(await choice()).toMatchObject({ show: true, source: "address-allow" });
    await r.call({ type: "removeImageRule", scope: "address", value: SENDER });
    await r.call({ type: "removeImageRule", scope: "domain", value: "shop.example" });
    expect(await choice()).toMatchObject({ show: false, source: "none" });
    await r.call({ type: "setGeneralImages", general: "always" });
    expect(await choice()).toMatchObject({ show: true, source: "always" });
  });

  it("never lets a failed sender through an allow or always, but honours a deny", async () => {
    const r = rig();
    const key = await r.mail(SENDER, "fail");
    await r.call({ type: "setGeneralImages", general: "always" });
    await r.call({ type: "setImageRule", scope: "address", value: SENDER, decision: "allow" });
    expect(await r.call({ type: "getImageChoice", key })).toMatchObject({
      images: { show: false, source: "none" },
    });
    await r.call({ type: "setImageRule", scope: "address", value: SENDER, decision: "deny" });
    expect(await r.call({ type: "getImageChoice", key })).toMatchObject({
      images: { show: false, source: "address-deny" },
    });
  });

  it("has no choice for a message that is gone", async () => {
    const r = rig();
    expect(await r.call({ type: "getImageChoice", key: 123 })).toMatchObject({ images: null });
    expect(await r.call({ type: "getMessageHtml", key: 123 })).toMatchObject({
      html: null,
      images: null,
    });
  });
});

describe("image rule requests", () => {
  it("lists rules with the general setting", async () => {
    const r = rig();
    await r.call({
      type: "setImageRule",
      scope: "address",
      value: "a@x.example",
      decision: "allow",
    });
    await r.call({ type: "setGeneralImages", general: "always" });
    expect(await r.call({ type: "listImageRules" })).toMatchObject({
      ok: true,
      rules: [{ scope: "address", value: "a@x.example", decision: "allow" }],
      general: "always",
    });
  });

  it("lower-cases the value and checks scope and decision at the boundary", async () => {
    const r = rig();
    const bad = (request: object) =>
      expect(r.call(request)).resolves.toMatchObject({ type: "error", code: "invalidRequest" });
    await bad({ type: "setImageRule", scope: "sender", value: "a@x.example", decision: "allow" });
    await bad({ type: "setImageRule", scope: "address", value: "a@x.example", decision: "maybe" });
    await bad({ type: "setImageRule", scope: "address", value: 5, decision: "allow" });
    await bad({
      type: "setImageRule",
      scope: "address",
      value: "a".repeat(400),
      decision: "allow",
    });
    await bad({ type: "removeImageRule", scope: "x", value: "a@x.example" });
    await bad({ type: "stopImages", address: "a@x.example", source: "address-deny" });
    await bad({ type: "setGeneralImages", general: "sometimes" });
    await bad({ type: "importImageAddresses", addresses: ["a@x.example", 3] });
    await bad({ type: "importImageAddresses", addresses: "a@x.example" });
    expect(r.changed).toEqual([]);
    expect(await r.storage.imageRules.list()).toEqual([]);

    const ok = await r.call({
      type: "setImageRule",
      scope: "address",
      value: " A@X.Example ",
      decision: "allow",
    });
    expect(ok).toMatchObject({ ok: true, rule: { value: "a@x.example" } });
  });

  it("explains a rule the use case refuses", async () => {
    const r = rig();
    expect(
      await r.call({ type: "setImageRule", scope: "domain", value: "co.uk", decision: "allow" }),
    ).toMatchObject({
      type: "error",
      code: "invalidRequest",
      message: expect.stringMatching(/domain/),
    });
    expect(
      await r.call({ type: "setImageRule", scope: "address", value: "nobody", decision: "allow" }),
    ).toMatchObject({ type: "error", code: "invalidRequest" });
  });

  it("stops images: removes the allow, and denies when something broader would allow", async () => {
    const r = rig();
    await r.call({ type: "setImageRule", scope: "address", value: SENDER, decision: "allow" });
    await r.call({
      type: "setImageRule",
      scope: "domain",
      value: "shop.example",
      decision: "allow",
    });
    await r.call({ type: "stopImages", address: SENDER, source: "address-allow" });
    expect(
      (await r.storage.imageRules.list()).map((x) => `${x.scope}:${x.value}:${x.decision}`).sort(),
    ).toEqual(["address:news@mail.shop.example:deny", "domain:shop.example:allow"]);
  });

  it("imports addresses once and says how many it added", async () => {
    const r = rig();
    expect(
      await r.call({
        type: "importImageAddresses",
        addresses: ["A@x.example", "b@x.example", "junk"],
      }),
    ).toMatchObject({ ok: true, added: 2 });
    expect(
      await r.call({ type: "importImageAddresses", addresses: ["a@x.example"] }),
    ).toMatchObject({
      added: 0,
    });
  });

  it("tells every window after a write that changed something, and not after one that did not", async () => {
    const r = rig();
    await r.call({
      type: "setImageRule",
      scope: "address",
      value: "a@x.example",
      decision: "allow",
    });
    await r.call({ type: "setGeneralImages", general: "always" });
    await r.call({ type: "stopImages", address: "a@x.example", source: "always" });
    await r.call({ type: "removeImageRule", scope: "address", value: "a@x.example" });
    expect(r.changed).toHaveLength(4);
    await r.call({ type: "removeImageRule", scope: "address", value: "a@x.example" });
    await r.call({ type: "importImageAddresses", addresses: [] });
    expect(r.changed).toHaveLength(4);
  });
});
