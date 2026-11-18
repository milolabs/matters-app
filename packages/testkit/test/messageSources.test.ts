import { type MessageLocation, MessageSources, type SourceFilesPort } from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  describeMessageSourceContract,
  FakeMailAttachments,
  InMemoryMessageStore,
  makeLocation,
} from "../src/index.ts";

const text = (s: string) => new TextEncoder().encode(s);

/** The place files are written, in memory, with the port's promises: nothing on failure. */
class MemorySources implements SourceFilesPort {
  readonly files = new Map<string, string>();
  async write(
    target: string,
    overwrite: boolean,
    content: AsyncIterable<Uint8Array>,
    onBytes: (n: number) => void,
    signal?: AbortSignal,
  ): Promise<number> {
    if (!overwrite && this.files.has(target))
      throw Object.assign(new Error("there"), { code: "EEXIST" });
    let out = "";
    let n = 0;
    for await (const chunk of content) {
      signal?.throwIfAborted();
      out += new TextDecoder().decode(chunk);
      n += chunk.byteLength;
      onBytes(n);
    }
    this.files.set(target, out);
    return n;
  }
}

async function setup(locations: readonly MessageLocation[]) {
  const store = new InMemoryMessageStore();
  const server = new FakeMailAttachments();
  const files = new MemorySources();
  const closed: number[] = [];
  const store2 = { getLocations: async () => locations };
  const sources = new MessageSources({
    store: store2,
    files,
    open: async () => ({ attachments: server, close: async () => void closed.push(1) }),
  });
  return { store, server, files, sources, closed };
}

describe("saving a message as the server has it (ADR 0145, rules 2, 3 and 5)", () => {
  it("writes the server's bytes and closes its connection", async () => {
    const at = makeLocation(7);
    const t = await setup([at]);
    t.server.putSource(at, text("From: a\r\n"), text("\r\nhello"));
    const seen: [number, number][] = [];
    const outcome = await t.sources.save(1, "/x/Lunch.eml", true, {
      onBytes: (b, total) => seen.push([b, total]),
    });
    expect(outcome).toEqual({ kind: "saved", bytes: 16 });
    expect(t.files.files.get("/x/Lunch.eml")).toBe("From: a\r\n\r\nhello");
    expect(seen.at(-1)).toEqual([16, 16]);
    expect(t.closed).toEqual([1]);
  });

  it("takes the first folder that still has it", async () => {
    const gone = makeLocation(1);
    const there = { ...makeLocation(2), folderId: "Archive" };
    const t = await setup([gone, there]);
    t.server.putSource(there, text("x"));
    expect(await t.sources.save(1, "/x/a.eml", true)).toEqual({ kind: "saved", bytes: 1 });
    expect(t.server.sourceRequests).toEqual([gone, there]);
  });

  it("is gone when no folder has it, or it never was on a server", async () => {
    const t = await setup([makeLocation(1)]);
    expect(await t.sources.save(1, "/x/a.eml", true)).toEqual({ kind: "gone" });
    const none = await setup([]);
    expect(await none.sources.save(1, "/x/a.eml", true)).toEqual({ kind: "gone" });
    expect(none.files.files.size).toBe(0);
  });

  it("says offline for a server that cannot be reached, and signIn for a refused or missing sign-in", async () => {
    const at = makeLocation(1);
    const t = await setup([at]);
    t.server.errors.push(Object.assign(new Error("down"), { kind: "unreachable" }));
    expect(await t.sources.save(1, "/x/a.eml", true)).toMatchObject({ kind: "offline" });
    t.server.errors.push(Object.assign(new Error("no"), { kind: "auth" }));
    expect(await t.sources.save(1, "/x/a.eml", true)).toMatchObject({ kind: "signIn" });
    t.server.errors.push(new Error("odd"));
    expect(await t.sources.save(1, "/x/a.eml", true)).toMatchObject({ kind: "failed" });
  });

  it("is cancelled when stopped, and writes nothing", async () => {
    const at = makeLocation(1);
    const t = await setup([at]);
    let open!: () => void;
    t.server.gate = new Promise((resolve) => {
      open = resolve;
    });
    t.server.putSource(at, text("a"), text("b"));
    const controller = new AbortController();
    const running = t.sources.save(1, "/x/a.eml", true, { signal: controller.signal });
    controller.abort();
    open();
    expect(await running).toEqual({ kind: "cancelled" });
    expect(t.files.files.size).toBe(0);
  });

  it("says exists when a name was taken where nothing may be replaced", async () => {
    const at = makeLocation(1);
    const t = await setup([at]);
    t.server.putSource(at, text("a"));
    t.files.files.set("/x/a.eml", "mine");
    expect(await t.sources.save(1, "/x/a.eml", false)).toEqual({ kind: "exists" });
    expect(t.files.files.get("/x/a.eml")).toBe("mine");
  });
});

describeMessageSourceContract("the fake server", async () => {
  const server = new FakeMailAttachments();
  let uid = 0;
  return {
    async put(raw) {
      const at = makeLocation(++uid);
      server.putSource(at, raw.subarray(0, 1000), raw.subarray(1000));
      return at;
    },
    port: async () => server,
    seen: async () => false,
    missing: (location) => ({ ...location, uid: location.uid + 1000 }),
    close: async () => {},
  };
});
