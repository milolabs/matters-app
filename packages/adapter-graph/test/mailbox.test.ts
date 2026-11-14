import type { MessageLocation } from "@matters/core";
import { describe, expect, it } from "vitest";
import { ACCOUNT, downloads, harness, mail, target } from "./support.ts";

async function locationOf(
  h: Awaited<ReturnType<typeof harness>>,
  itemId: string,
): Promise<MessageLocation> {
  const key = await h.keyOf(itemId);
  const [location] = await h.storage.store.getLocations(key as number);
  if (!location) throw new Error("no location");
  return location;
}

describe("read state, moves and deleting over Graph (ADR 0136, rule 7)", () => {
  it("sets read with one PATCH per copy; 404 is stale, 403 rejected", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"));
    const b = h.server.addMessage("inbox", mail("b"));
    const c = h.server.addMessage("inbox", mail("c"));
    await h.sync();
    const [la, lb, lc] = [await locationOf(h, a), await locationOf(h, b), await locationOf(h, c)];
    h.server.remove(b);
    h.server.refusals.push({
      status: 403,
      code: "ErrorAccessDenied",
      match: (r) => r.path.includes(c),
    });
    const connection = await h.connector.connect(target());
    const results = await connection.flags.setSeen([la, lb, lc], true);
    expect(results.map((r) => r.outcome)).toEqual(["done", "stale", "rejected"]);
    expect(h.server.messages.get(a)?.isRead).toBe(true);
    expect(h.server.requestsTo(`/me/messages/${a}`).map((r) => r.method)).toContain("PATCH");
  });

  it("moves to the well-known folders and to a folder by id; a moved copy keeps its id", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"));
    const b = h.server.addMessage("inbox", mail("b"));
    const projects = h.server.addFolder("Projects");
    await h.sync();
    const connection = await h.connector.connect(target());
    const [la, lb] = [await locationOf(h, a), await locationOf(h, b)];
    expect((await connection.moves.move([la], "archive", { role: "archive" }))[0]?.outcome).toEqual(
      { kind: "moved" },
    );
    expect(h.server.messages.get(a)?.folderId).toBe(h.server.wellKnown.archive);
    await connection.moves.move([lb], "move", { folderId: projects });
    expect(h.server.messages.get(b)?.folderId).toBe(projects);
    await connection.moves.move([la], "delete", { role: "trash" });
    expect(h.server.messages.get(a)?.folderId).toBe(h.server.wellKnown.deleteditems);
    await connection.moves.move([la], "spam", { role: "spam" });
    expect(h.server.messages.get(a)?.folderId).toBe(h.server.wellKnown.junkemail);
    // Gone already: stale.
    h.server.remove(b);
    expect((await connection.moves.move([lb], "archive", { role: "archive" }))[0]?.outcome).toEqual(
      { kind: "stale" },
    );
    // The next sync finds the moves as known messages: no download.
    const before = downloads(h.server);
    await h.sync();
    expect(downloads(h.server)).toBe(before);
    expect((await locationOf(h, a)).folderId).toBe(h.server.wellKnown.junkemail);
  });

  it("deletes for good only in Deleted Items; anywhere else rejected without a request", async () => {
    const h = await harness();
    const a = h.server.addMessage("inbox", mail("a"));
    const t = h.server.addMessage("deleteditems", mail("t"));
    await h.sync();
    const connection = await h.connector.connect(target());
    const sent = h.server.requests.length;
    const results = await connection.moves.expunge([
      await locationOf(h, a),
      await locationOf(h, t),
    ]);
    expect(results.map((r) => r.outcome)).toEqual(["rejected", "done"]);
    expect(h.server.messages.has(a)).toBe(true);
    expect(h.server.messages.has(t)).toBe(false);
    const deletes = h.server.requests.slice(sent).filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.path)).toEqual([`/me/messages/${t}`]);
  });

  it("does not delete a message restored from Deleted Items since the last sync: stale", async () => {
    const h = await harness();
    const t = h.server.addMessage("deleteditems", mail("restored"));
    await h.sync();
    const stored = await locationOf(h, t);
    // Another app puts it back; its immutable id stays the same.
    h.server.move(t, "inbox");
    const connection = await h.connector.connect(target());
    const results = await connection.moves.expunge([stored]);
    expect(results.map((r) => r.outcome)).toEqual(["stale"]);
    expect(h.server.messages.has(t)).toBe(true);
    expect(h.server.requests.filter((r) => r.method === "DELETE")).toEqual([]);
  });

  it("finds the Sent copy by Message-ID, quotes escaped; never appends", async () => {
    const h = await harness();
    const id = h.server.addMessage("sentitems", mail("it's-sent"));
    const connection = await h.connector.connect(target());
    expect(await connection.sent.findByMessageId(ACCOUNT, "<it's-sent@example.org>")).toEqual({
      providerId: id,
    });
    expect(await connection.sent.findByMessageId(ACCOUNT, "<nothing@example.org>")).toBeNull();
    expect(h.server.requestsTo("internetMessageId eq '<it''s-sent@example.org>'").length).toBe(1);
    await expect(connection.sent.append(ACCOUNT, new Uint8Array())).rejects.toThrow();
    expect(connection.sync.capabilities.has("savesSent")).toBe(true);
  });
});

describe("files over Graph (ADR 0136, rule 8)", () => {
  it("lists a message's files with IMAP part ids and downloads the one part from its MIME", async () => {
    const h = await harness();
    const bytes = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
    const id = h.server.addMessage(
      "inbox",
      mail("with-file", { attachment: { name: "report.pdf", bytes } }),
    );
    await h.sync();
    const key = (await h.keyOf(id)) as number;
    const [message] = await h.storage.store.getByKeys([key]);
    expect(message?.hasAttachments).toBe(true);
    const file = await h.storage.store.getAttachment(key, "2");
    expect(file).toMatchObject({ partId: "2", name: "report.pdf", mimeType: "application/pdf" });
    expect(Math.abs((file?.size ?? 0) - bytes.length)).toBeLessThan(4);

    const connection = await h.connector.connect(target());
    const location = await locationOf(h, id);
    const found = await connection.attachments.download(location, "2");
    if (found.kind !== "found") throw new Error("not found");
    const chunks: Buffer[] = [];
    for await (const chunk of found.content) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    expect(await connection.attachments.download(location, "9")).toEqual({ kind: "gone" });
    h.server.remove(id);
    expect(await connection.attachments.download(location, "2")).toEqual({ kind: "gone" });
  });
});
