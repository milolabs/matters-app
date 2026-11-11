// Grants (ADR 0041, rule 3): paths exist only between main and the router; the page holds
// one-use ids. Covers the router's book, main's mint, the preload's drop handling and the
// requests that carry the ids.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PickedFile } from "@matters/contracts";
import { describe, expect, it } from "vitest";
import { GrantBook, UnknownGrantError } from "../src/backend/grantBook.ts";
import { handle } from "../src/backend/handler.ts";
import { RemoteAttachments } from "../src/backend/remoteAttachments.ts";
import type { SyncHost } from "../src/backend/syncHost.ts";
import { type GrantMessage, GrantMint, MAX_PASTE_BYTES } from "../src/main/grants.ts";
import { createFileBridge, type DropEventLike } from "../src/preload/fileBridge.ts";
import { imageDeps } from "./support/noSend.ts";

const grant = (grantId: string, path = `/home/me/${grantId}.pdf`) => ({
  grantId,
  path,
  name: `${grantId}.pdf`,
  size: 100,
});

describe("GrantBook in the router", () => {
  it("hands a grant out once: reused and unknown ids are refused", async () => {
    const book = new GrantBook({ waitMs: 20 });
    book.put(grant("g1"));
    const taken = await book.takeAll(["g1"]);
    expect(taken?.[0]).toMatchObject({ grantId: "g1", path: "/home/me/g1.pdf" });
    expect(await book.takeAll(["g1"])).toBeNull();
    expect(await book.takeAll(["never-minted"])).toBeNull();
    expect(book.size).toBe(0);
  });

  it("refuses a reuse at once, without waiting for a late grant", async () => {
    const book = new GrantBook({ waitMs: 5000 });
    book.put(grant("g1"));
    await book.takeAll(["g1"]);
    const started = Date.now();
    expect(await book.takeAll(["g1"])).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
    // A grant minted again under a spent id does not come back to life.
    book.put(grant("g1", "/etc/passwd"));
    expect(book.size).toBe(0);
  });

  it("is all or none: a request with one bad id spends nothing", async () => {
    const book = new GrantBook({ waitMs: 20 });
    book.put(grant("g1"));
    book.put(grant("g2"));
    expect(await book.takeAll(["g1", "nope", "g2"])).toBeNull();
    expect(book.size).toBe(2);
    // The same id twice in one request is one grant used twice.
    expect(await book.takeAll(["g1", "g1"])).toBeNull();
    expect(book.size).toBe(2);
    expect((await book.takeAll(["g2", "g1"]))?.map((g) => g.grantId)).toEqual(["g2", "g1"]);
  });

  it("waits a moment for a grant that is late, because it comes over another channel", async () => {
    const book = new GrantBook({ waitMs: 1000 });
    const waiting = book.takeAll(["late"]);
    setTimeout(() => book.put(grant("late")), 30);
    expect((await waiting)?.[0]?.grantId).toBe("late");
  });

  it("drops a grant nobody used, and says so, so a temporary file can go", async () => {
    let now = 1000;
    const ended: string[] = [];
    const book = new GrantBook({
      waitMs: 1,
      ttlMs: 500,
      now: () => now,
      onEnd: (id) => ended.push(id),
    });
    book.put(grant("old"));
    now += 600;
    book.put(grant("new"));
    expect(ended).toEqual(["old"]);
    expect(await book.takeAll(["old"])).toBeNull();
    expect((await book.takeAll(["new"]))?.length).toBe(1);
    // A used grant ends when its copy does, not before.
    expect(ended).toEqual(["old"]);
    book.end("new");
    expect(ended).toEqual(["old", "new"]);
  });

  it("keeps a bounded number of unused grants", () => {
    const ended: string[] = [];
    const book = new GrantBook({ max: 2, onEnd: (id) => ended.push(id) });
    for (const id of ["a", "b", "c"]) book.put(grant(id));
    expect(book.size).toBe(2);
    expect(ended).toEqual(["a"]);
  });

  it("ignores a grant without an id or a path", () => {
    const book = new GrantBook();
    book.put({ ...grant("x"), path: "" });
    book.put({ ...grant(""), grantId: "" });
    expect(book.size).toBe(0);
  });
});

describe("RemoteAttachments", () => {
  function rig() {
    const commands: unknown[] = [];
    const ended: string[] = [];
    const book = new GrantBook({ waitMs: 20, onEnd: (id) => ended.push(id) });
    let fail: Error | null = null;
    const host = {
      command: async (command: unknown) => {
        commands.push(command);
        if (fail) throw fail;
        return [];
      },
    } as unknown as SyncHost;
    return {
      book,
      commands,
      ended,
      remote: new RemoteAttachments(host, book),
      failWith: (e: Error) => (fail = e),
    };
  }

  it("turns grants into paths for the worker, once, with the name and size main saw", async () => {
    const { book, remote, commands } = rig();
    book.put({ grantId: "g1", path: "/Users/me/a.pdf", name: "a.pdf", size: 7 });
    await remote.add("d1", [{ id: "att-1", grantId: "g1" }]);
    expect(commands).toEqual([
      {
        name: "addAttachments",
        draftId: "d1",
        files: [{ id: "att-1", name: "a.pdf", size: 7, sourcePath: "/Users/me/a.pdf" }],
      },
    ]);
    const again = await remote.add("d1", [{ id: "att-2", grantId: "g1" }]).catch((e) => e);
    expect(again).toBeInstanceOf(UnknownGrantError);
    expect(commands).toHaveLength(1);
  });

  it("ends the grant when the copy ends, and when the worker refuses the request", async () => {
    const { book, remote, ended, failWith } = rig();
    book.put(grant("g1"));
    await remote.add("d1", [{ id: "att-1", grantId: "g1" }]);
    expect(ended).toEqual([]);
    remote.captured(["att-1"]);
    expect(ended).toEqual(["g1"]);
    remote.captured(["att-1"]);
    expect(ended).toEqual(["g1"]);

    book.put(grant("g2"));
    failWith(new Error("no such draft"));
    await expect(remote.add("nope", [{ id: "att-2", grantId: "g2" }])).rejects.toThrow();
    expect(ended).toEqual(["g1", "g2"]);
  });
});

describe("requests that carry grants", () => {
  function ask(request: object, add: (files: unknown) => Promise<unknown[]> = async () => []) {
    const deps = {
      ...imageDeps,
      attachmentWrites: {
        add: async (_draft: string, files: unknown) => add(files),
        check: async () => [],
        recapture: async () => null,
      },
      attachmentRows: {
        forDraft: async () => [
          {
            id: "att-1",
            draftId: "d1",
            accountId: "a",
            name: "a.pdf",
            size: 7,
            state: "ready",
            reason: null,
            sha256: "abc",
            sourcePath: "/Users/me/secret/a.pdf",
            sourceMtimeMs: 1,
            origin: null,
            createdAtMs: 1,
          },
        ],
      },
    } as unknown as Parameters<typeof handle>[0];
    return handle(deps, { requestId: "r", ...request });
  }

  it("passes on the ids and drops anything else a page adds, a path above all", async () => {
    let seen: unknown;
    const reply = await ask(
      {
        type: "addAttachments",
        draftId: "d1",
        files: [{ id: "att-1", grantId: "g1", path: "/etc/passwd", sourcePath: "/etc/passwd" }],
      },
      async (files) => {
        seen = files;
        return [];
      },
    );
    expect(reply).toMatchObject({ type: "addAttachments", ok: true });
    expect(seen).toEqual([{ id: "att-1", grantId: "g1" }]);
  });

  it("refuses ids that could name a path, and requests without a grant", async () => {
    for (const files of [
      [{ id: "../../etc/passwd", grantId: "g1" }],
      [{ id: "att-1" }],
      [{ id: "att-1", grantId: "" }],
      [],
    ]) {
      expect(await ask({ type: "addAttachments", draftId: "d1", files })).toMatchObject({
        ok: false,
        code: "invalidRequest",
      });
    }
  });

  it("answers an unknown or used grant as an invalid request", async () => {
    const reply = await ask(
      { type: "addAttachments", draftId: "d1", files: [{ id: "att-1", grantId: "g9" }] },
      async () => {
        throw new UnknownGrantError();
      },
    );
    expect(reply).toMatchObject({ type: "error", code: "invalidRequest" });
  });

  it("never answers with a path or a hash", async () => {
    const reply = await ask({ type: "listAttachments", draftId: "d1" });
    expect(reply).toEqual({
      type: "listAttachments",
      requestId: "r",
      ok: true,
      attachments: [
        {
          id: "att-1",
          name: "a.pdf",
          size: 7,
          state: "ready",
          reason: null,
          canRetry: false,
          forwarded: false,
        },
      ],
    });
    expect(JSON.stringify(reply)).not.toMatch(/secret|sourcePath|sha256|abc/);
  });
});

describe("GrantMint in main", () => {
  function rig(files: Record<string, { isFile: boolean; isDirectory: boolean; size: number }>) {
    const sent: GrantMessage[] = [];
    const temps = new Map<string, Uint8Array>();
    let n = 0;
    const mint = new GrantMint({
      stat: async (path) => files[path] ?? null,
      writeTemp: async (extension, bytes) => {
        const path = `/private/paste/${++n}.${extension}`;
        temps.set(path, bytes);
        return path;
      },
      removeTemp: async (path) => {
        temps.delete(path);
      },
      send: (message) => sent.push(message),
      newId: () => `grant-${sent.length + 1}`,
    });
    return { mint, sent, temps };
  }

  it("sends id, path, name and size to the router and answers the page without the path", async () => {
    const { mint, sent } = rig({
      "/Users/me/Taxes 2026.pdf": { isFile: true, isDirectory: false, size: 4096 },
      "/Users/me/Folder": { isFile: false, isDirectory: true, size: 0 },
    });
    const answer = await mint.fromPaths([
      "/Users/me/Taxes 2026.pdf",
      "/Users/me/Folder",
      "/Users/me/gone.txt",
      "",
      "relative/path.txt",
      42,
    ]);
    expect(answer).toEqual([
      { grantId: "grant-1", name: "Taxes 2026.pdf", size: 4096, kind: "file" },
      { grantId: "", name: "Folder", size: 0, kind: "directory" },
      { grantId: "", name: "gone.txt", size: 0, kind: "missing" },
      { grantId: "", name: "", size: 0, kind: "missing" },
      { grantId: "", name: "", size: 0, kind: "missing" },
      { grantId: "", name: "", size: 0, kind: "missing" },
    ]);
    expect(sent).toEqual([
      {
        type: "grant",
        grantId: "grant-1",
        path: "/Users/me/Taxes 2026.pdf",
        name: "Taxes 2026.pdf",
        size: 4096,
      },
    ]);
    expect(JSON.stringify(answer)).not.toContain("/Users");
  });

  it("mints a new id for every grant", async () => {
    const { mint } = rig({ "/a": { isFile: true, isDirectory: false, size: 1 } });
    const [first] = await mint.fromPaths(["/a"]);
    const [second] = await mint.fromPaths(["/a"]);
    expect(first?.grantId).not.toBe(second?.grantId);
  });

  it("refuses what is not a list of paths", async () => {
    const { mint, sent } = rig({});
    expect(await mint.fromPaths("/etc/passwd")).toEqual([]);
    expect(await mint.fromPaths({ length: 1, 0: "/etc/passwd" })).toEqual([]);
    expect(await mint.fromPaths(new Array(1001).fill("/a"))).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("writes a pasted image to a private file, grants that, and removes it after the copy", async () => {
    const { mint, sent, temps } = rig({});
    const bytes = new Uint8Array([1, 2, 3]);
    const file = await mint.fromPaste("image/png", bytes);
    expect(file).toEqual({ grantId: "grant-1", name: "Pasted image.png", size: 3, kind: "file" });
    expect(sent[0]?.path).toBe("/private/paste/1.png");
    expect(temps.get("/private/paste/1.png")).toEqual(bytes);
    const second = await mint.fromPaste("image/jpeg", new Uint8Array([9]).buffer);
    expect(second.name).toBe("Pasted image 2.jpg");

    await mint.release("grant-1");
    expect(temps.has("/private/paste/1.png")).toBe(false);
    expect(temps.has("/private/paste/2.jpg")).toBe(true);
    // Quitting removes what is left.
    await mint.releaseAll();
    expect(temps.size).toBe(0);
    // A grant that was never a paste has no file to remove.
    await mint.release("grant-404");
  });

  it("refuses a pasted image over 50 MB, other types and nothing", async () => {
    const { mint, sent, temps } = rig({});
    expect(await mint.fromPaste("image/png", new Uint8Array(MAX_PASTE_BYTES + 1))).toMatchObject({
      grantId: "",
      kind: "tooLarge",
    });
    expect(await mint.fromPaste("application/x-sh", new Uint8Array(10))).toMatchObject({
      kind: "missing",
    });
    expect(await mint.fromPaste("image/png", new Uint8Array(0))).toMatchObject({ kind: "missing" });
    expect(await mint.fromPaste("image/png", "not bytes")).toMatchObject({ kind: "missing" });
    expect(sent).toEqual([]);
    expect(temps.size).toBe(0);
    expect(await mint.fromPaste("image/png", new Uint8Array(MAX_PASTE_BYTES))).toMatchObject({
      kind: "file",
      size: MAX_PASTE_BYTES,
    });
  });
});

describe("the preload's file bridge", () => {
  const fileOf = (name: string) => ({ name }) as File;
  function rig() {
    const posted: unknown[] = [];
    const invoked: { channel: string; args: unknown[] }[] = [];
    const paths: string[] = [];
    const page = {};
    const answers = new Map<string, (value: unknown) => void>();
    const bridge = createFileBridge(
      {
        getPath: (file) => {
          paths.push(file.name);
          return `/Users/me/${file.name}`;
        },
        invoke: (channel, ...args) => {
          invoked.push({ channel, args });
          return new Promise((resolve) => answers.set(`${channel}#${invoked.length}`, resolve));
        },
        post: (message) => posted.push(message),
      },
      page,
    );
    const drop = (files: string[], isTrusted: boolean) => {
      let prevented = false;
      const event: DropEventLike = {
        isTrusted,
        dataTransfer: { files: files.map(fileOf) },
        preventDefault: () => {
          prevented = true;
        },
      };
      bridge.drop(event);
      return () => prevented;
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { bridge, posted, invoked, paths, page, answers, drop, flush };
  }

  it("reads paths only from a trusted drop", async () => {
    const t = rig();
    t.drop(["forged.txt"], false);
    expect(t.paths).toEqual([]);
    expect(t.invoked).toEqual([]);
    const prevented = t.drop(["real.txt"], true);
    expect(t.paths).toEqual(["real.txt"]);
    expect(t.invoked).toEqual([{ channel: "matters:grant-paths", args: [["/Users/me/real.txt"]] }]);
    // A dropped file never navigates the window.
    expect(prevented()).toBe(true);
  });

  it("ignores drops that carry no files", () => {
    const t = rig();
    t.bridge.drop({ isTrusted: true, dataTransfer: null, preventDefault: () => {} });
    t.drop([], true);
    expect(t.invoked).toEqual([]);
  });

  it("answers drops in the order they were made, whichever answer main gives first", async () => {
    const t = rig();
    t.drop(["a.txt"], true);
    t.drop(["b.txt"], true);
    const file = (name: string): PickedFile => ({ grantId: name, name, size: 1, kind: "file" });
    // Main answers the second drop first.
    t.answers.get("matters:grant-paths#2")?.([file("b")]);
    await t.flush();
    expect(t.posted).toEqual([]);
    t.answers.get("matters:grant-paths#1")?.([file("a")]);
    await t.flush();
    expect(t.posted).toEqual([
      { mattersDropped: { dropId: 1, files: [file("a")] } },
      { mattersDropped: { dropId: 2, files: [file("b")] } },
    ]);
  });

  it("answers an empty list when main fails, so the page does not wait for ever", async () => {
    const t = rig();
    t.drop(["a.txt"], true);
    t.invoked.length = 0;
    const failing = createFileBridge(
      {
        getPath: () => "/a",
        invoke: () => Promise.reject(new Error("closed")),
        post: (m) => t.posted.push(m),
      },
      t.page,
    );
    failing.drop({ isTrusted: true, dataTransfer: { files: [fileOf("x")] }, preventDefault() {} });
    await t.flush();
    expect(t.posted).toEqual([{ mattersDropped: { dropId: 1, files: [] } }]);
  });

  it("opens the dialog on a pick, and a pick takes no path from the page", async () => {
    const t = rig();
    t.bridge.message({
      source: t.page,
      data: { mattersPickFiles: { requestId: "f1", path: "/etc/passwd" } },
    });
    expect(t.invoked).toEqual([{ channel: "matters:pick-files", args: [] }]);
    const picked: PickedFile[] = [{ grantId: "g", name: "a", size: 1, kind: "file" }];
    t.answers.get("matters:pick-files#1")?.(picked);
    await t.flush();
    expect(t.posted).toEqual([{ mattersPicked: { requestId: "f1", files: picked } }]);
  });

  it("passes pasted bytes and a type to main, and refuses anything else", async () => {
    const t = rig();
    const bytes = new Uint8Array([1, 2]).buffer;
    t.bridge.message({
      source: t.page,
      data: { mattersPasteImage: { requestId: "f2", mime: "image/png", data: bytes } },
    });
    expect(t.invoked).toEqual([{ channel: "matters:paste-image", args: ["image/png", bytes] }]);
    // A path in place of bytes goes nowhere.
    t.bridge.message({
      source: t.page,
      data: { mattersPasteImage: { requestId: "f3", mime: "image/png", data: "/etc/passwd" } },
    });
    expect(t.invoked).toHaveLength(1);
    await t.flush();
    expect(t.posted).toEqual([{ mattersPasted: { requestId: "f3", file: null } }]);
  });

  it("ignores messages that do not come from the page itself", () => {
    const t = rig();
    t.bridge.message({ source: {}, data: { mattersPickFiles: { requestId: "f1" } } });
    t.bridge.message({ source: t.page, data: "mattersPickFiles" });
    t.bridge.message({ source: t.page, data: { mattersPickFiles: { requestId: 5 } } });
    expect(t.invoked).toEqual([]);
  });

  it("is the only place that reads a path, and the preload exposes no function that takes one", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "../src/preload");
    // Code only: the comments are allowed to name what they explain.
    const code = (file: string) =>
      readFileSync(join(dir, file), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
    const index = code("index.ts");
    const bridge = code("fileBridge.ts");
    // Nothing is exposed to the page by an API: the page can only post messages.
    expect(index).not.toMatch(/contextBridge|exposeInMainWorld/);
    // `getPathForFile` appears once, as the dependency the bridge calls for trusted drops only.
    expect(index.match(/getPathForFile/g)).toHaveLength(1);
    expect(bridge).not.toMatch(/getPathForFile/);
    expect(bridge.match(/deps\.getPath\(/g)).toHaveLength(1);
    // That one call sits behind the trust check.
    expect(bridge.indexOf("!event.isTrusted")).toBeGreaterThan(-1);
    expect(bridge.indexOf("!event.isTrusted")).toBeLessThan(bridge.indexOf("deps.getPath("));
    // A drop is listened to in the capture phase, so no page handler can hide it.
    expect(index).toMatch(/addEventListener\("drop",[^;]*, true\);/);
  });
});
