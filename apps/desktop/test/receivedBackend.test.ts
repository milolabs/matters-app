import { makeDocument, makeLocation } from "@matters/testkit";
import { createInMemoryStorage, FakeComposeRenderer } from "@matters/testkit/fakes";
import { describe, expect, it } from "vitest";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const noAccounts: BackendDeps["accounts"] = {
  discover: async () => null,
  list: async () => [],
  add: async () => {
    throw new Error("not used");
  },
  remove: async () => false,
  syncNow: async () => false,
  changePassword: async () => null,
};

function baseDeps(received?: BackendDeps["received"]) {
  const storage = createInMemoryStorage();
  return {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    accounts: noAccounts,
    ...(received ? { received } : {}),
  };
}

const pdf = (partId: string, name: string, over = {}) => ({
  partId,
  name,
  mimeType: "application/pdf",
  size: 1000,
  inline: false,
  ...over,
});

describe("opening a thread brings its files (ADR 0043, rule 1)", () => {
  it("carries each message's files and whether they are known, read with the thread", async () => {
    const d = baseDeps();
    const a = makeDocument({ providerId: "a", threadId: "t", hasAttachments: true }, "z plikami");
    const b = makeDocument({ providerId: "b", threadId: "t" }, "bez plików");
    const c = makeDocument({ providerId: "c", threadId: "t", hasAttachments: true }, "nieznane");
    await d.store.upsertMessages([a, b, c].map((x) => x.message));
    await d.bodies.putBodies(
      [a, b, c].map((x) => ({ key: x.message.key, threadId: "t", text: x.bodyText })),
    );
    await d.store.addLocations([{ key: a.message.key, location: makeLocation(1) }]);
    await d.store.setAttachments([
      {
        location: makeLocation(1),
        attachments: [pdf("2", "Faktura.pdf"), pdf("1.2", "logo.png", { inline: true })],
      },
    ]);

    const r = await handle(d, { type: "openThread", requestId: "r", threadId: "t" });
    if (r.type !== "openThread") throw new Error("unexpected");
    const [withFiles, without, unknown] = r.messages;
    expect(withFiles?.attachmentsKnown).toBe(true);
    expect(withFiles?.attachments).toEqual([pdf("2", "Faktura.pdf")]);
    expect(without).toMatchObject({ attachmentsKnown: true, attachments: [] });
    expect(unknown).toMatchObject({
      attachmentsKnown: false,
      attachments: [],
      hasAttachments: true,
    });
  });

  it("never lets a path or a hash reach the page", async () => {
    const d = baseDeps();
    const a = makeDocument({ providerId: "a", threadId: "t", hasAttachments: true });
    await d.store.upsertMessages([a.message]);
    await d.store.addLocations([{ key: a.message.key, location: makeLocation(1) }]);
    await d.store.setAttachments([
      { location: makeLocation(1), attachments: [pdf("2", "Faktura.pdf")] },
    ]);
    const r = await handle(d, { type: "openThread", requestId: "r", threadId: "t" });
    const json = JSON.stringify(r);
    expect(json).not.toMatch(/path|sha|received\//i);
    if (r.type !== "openThread") throw new Error("unexpected");
    expect(Object.keys(r.messages[0]?.attachments[0] ?? {}).sort()).toEqual([
      "inline",
      "mimeType",
      "name",
      "partId",
      "size",
    ]);
  });
});

describe("fetchReceived (ADR 0043, rule 6)", () => {
  it("makes the copy exist and answers how it ended, without the reason", async () => {
    const asked: [number, string][] = [];
    const d = baseDeps({
      fetch: async (key, part) => {
        asked.push([key, part]);
        return { kind: "offline", message: "ECONNREFUSED 10.0.0.7:993 secret-host" };
      },
    });
    const r = await handle(d, {
      type: "fetchReceived",
      requestId: "x",
      messageKey: 7,
      partId: "2.1",
    });
    expect(r).toEqual({
      type: "fetchReceived",
      requestId: "x",
      ok: true,
      outcome: { kind: "offline" },
    });
    expect(asked).toEqual([[7, "2.1"]]);
  });

  it("passes done and gone on as they are", async () => {
    for (const kind of ["done", "gone"] as const) {
      const d = baseDeps({ fetch: async () => ({ kind }) });
      const r = await handle(d, {
        type: "fetchReceived",
        requestId: "x",
        messageKey: 7,
        partId: "2",
      });
      expect(r).toMatchObject({ ok: true, outcome: { kind } });
    }
  });

  it("refuses a key or part that names no directory of the cache, and asks nothing", async () => {
    let asked = 0;
    const d = baseDeps({
      fetch: async () => {
        asked++;
        return { kind: "done" };
      },
    });
    for (const bad of [
      { messageKey: 0, partId: "2" },
      { messageKey: -4, partId: "2" },
      { messageKey: 1.5, partId: "2" },
      { messageKey: "7", partId: "2" },
      { messageKey: 7, partId: "../2" },
      { messageKey: 7, partId: "2/../3" },
      { messageKey: 7, partId: "" },
      { messageKey: 7, partId: 2 },
      { messageKey: 7 },
      { partId: "2" },
    ]) {
      const r = await handle(d, { type: "fetchReceived", requestId: "x", ...bad } as never);
      expect(r).toMatchObject({ type: "error", ok: false, code: "invalidRequest" });
    }
    expect(asked).toBe(0);
  });

  it("answers failed when the app has no cache to download into", async () => {
    const r = await handle(baseDeps(), {
      type: "fetchReceived",
      requestId: "x",
      messageKey: 7,
      partId: "2",
    });
    expect(r).toMatchObject({ ok: true, outcome: { kind: "failed" } });
  });

  it("turns an error of the worker into an error response, not a thrown one", async () => {
    const d = baseDeps({
      fetch: async () => {
        throw new Error("The sync process is restarting");
      },
    });
    const r = await handle(d, {
      type: "fetchReceived",
      requestId: "x",
      messageKey: 7,
      partId: "2",
    });
    expect(r).toMatchObject({ type: "error", ok: false });
  });
});
