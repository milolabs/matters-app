import { describe, expect, it } from "vitest";
import type {
  Message,
  MessageBody,
  MessageBodyPort,
  MessageDocument,
  MessageStorePort,
  SearchIndexPort,
  UnitOfWorkPort,
} from "../src/index.ts";
import { ingestDocuments } from "../src/index.ts";

const message = (key: number, providerId: string, threadId = "t1"): Message => ({
  key,
  accountId: "a",
  providerId,
  threadId,
  messageIdHeader: `<${providerId}@x>`,
  dateMs: key,
  from: { address: "a@x" },
  to: [],
  cc: [],
  subject: "s",
  snippet: "",
  flags: { seen: false, flagged: false, answered: false, draft: false },
  labelIds: [],
  hasAttachments: false,
  senderAuth: "unknown",
});

/** Records call order; the store keeps the first key of each provider id, like the real one. */
function fakes() {
  const calls: string[] = [];
  const keyOf = new Map<string, number>();
  const indexed: MessageDocument[] = [];
  const bodies: MessageBody[] = [];
  const store = {
    async upsertMessages(batch: readonly Message[]) {
      calls.push("store");
      const keys = batch.map((m) => {
        const key = keyOf.get(m.providerId) ?? m.key;
        keyOf.set(m.providerId, key);
        return key;
      });
      return { changeSeq: 1, keys };
    },
  } as unknown as MessageStorePort;
  const index = {
    async indexMessages(batch) {
      calls.push("index");
      indexed.push(...batch);
    },
  } as SearchIndexPort;
  const port: MessageBodyPort = {
    async putBodies(batch) {
      calls.push("bodies");
      bodies.push(...batch);
    },
    async getBodies() {
      return new Map();
    },
    async getHtmlKinds() {
      return new Map();
    },
    async getHtml() {
      return undefined;
    },
    async removeBodies() {},
  };
  const uow: UnitOfWorkPort = {
    async run(work) {
      calls.push("uow");
      return work();
    },
  };
  return { deps: { store, index, bodies: port, uow }, calls, indexed, bodies };
}

describe("ingestDocuments", () => {
  it("stores, then indexes, then saves bodies, in input order", async () => {
    const f = fakes();
    const docs = [
      { message: message(10, "p1"), bodyText: "pierwsza" },
      { message: message(20, "p2", "t2"), bodyText: "druga" },
    ];
    const result = await ingestDocuments(f.deps, docs);

    expect(f.calls).toEqual(["uow", "store", "index", "bodies"]);
    expect(result.keys).toEqual([10, 20]);
    expect(f.indexed.map((d) => [d.message.key, d.bodyText])).toEqual([
      [10, "pierwsza"],
      [20, "druga"],
    ]);
    expect(f.bodies).toEqual([
      { key: 10, threadId: "t1", sender: "a@x", text: "pierwsza" },
      { key: 20, threadId: "t2", sender: "a@x", text: "druga" },
    ]);
  });

  it("uses the effective key when a re-ingested message keeps its old one", async () => {
    const f = fakes();
    await ingestDocuments(f.deps, [{ message: message(10, "p1"), bodyText: "old" }]);
    f.indexed.length = 0;
    f.bodies.length = 0;

    // The date changed, so the input key differs; the store keeps key 10.
    await ingestDocuments(f.deps, [{ message: message(99, "p1"), bodyText: "new" }]);
    expect(f.indexed.map((d) => d.message.key)).toEqual([10]);
    expect(f.bodies).toEqual([{ key: 10, threadId: "t1", sender: "a@x", text: "new" }]);
  });

  it("does nothing beyond the store for an empty batch", async () => {
    const f = fakes();
    await ingestDocuments(f.deps, []);
    expect(f.calls).toEqual(["uow", "store"]);
  });

  it("does not touch the index or bodies when the store rejects the batch", async () => {
    const f = fakes();
    const failing = {
      ...f.deps,
      store: {
        upsertMessages: async () => {
          throw new Error("collision");
        },
      } as unknown as MessageStorePort,
    };
    await expect(
      ingestDocuments(failing, [{ message: message(1, "p"), bodyText: "x" }]),
    ).rejects.toThrow("collision");
    expect(f.calls).toEqual(["uow"]);
  });
});
