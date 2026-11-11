import type {
  AccountStorePort,
  AgentInsightStorePort,
  AgentSettingsPort,
  AttachmentStorePort,
  CursorPort,
  Draft,
  DraftStorePort,
  FeedbackJournalEntry,
  FilesPort,
  FlagOutboxPort,
  ImageRule,
  ImageRuleStorePort,
  Label,
  LabelRole,
  LedgerEntry,
  Message,
  MessageBodyPort,
  MessageStorePort,
  MoveOperation,
  MoveOutboxPort,
  NewMoveOperation,
  NewSeenIntent,
  OutboxPort,
  Participant,
  PeoplePort,
  PreparedRecord,
  ReceivedAttachment,
  SavedView,
  SavedViewStorePort,
  SearchIndexPort,
  SeenIntent,
  SendOperation,
  StoredAccount,
  StoredAttachment,
  SyncBatch,
  SyncedDocument,
  ThingFeedback,
  ThreadAnalysis,
  UnitOfWorkPort,
} from "@matters/core";
import {
  applySyncBatch,
  approve,
  cancelSend,
  deleteForever,
  finishMoves,
  finishPurge,
  finishSeen,
  finishSend,
  holdSend,
  ingestDocuments,
  MAILBOX_BIT,
  MAX_RECENT_SEARCHES,
  markDataEnded,
  messageKey,
  moveThread,
  newSendOperation,
  parseQuery,
  reapplyPendingMoves,
  reapplyPendingSeen,
  rejectMoves,
  rejectSeen,
  setSeen,
  splitMessageKey,
  startSend,
  undoMove,
  voidSend,
} from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  asStored,
  makeDocument,
  makeLocation,
  makeMessage,
  makeSyncBatch,
  person,
  syncedDoc,
} from "./fixtures.ts";

/** A fresh, empty instance per test, plus optional teardown (close DB, delete temp dir). */
export interface Fixture<T> {
  readonly instance: T;
  readonly cleanup?: () => void | Promise<void>;
}

export type Factory<T> = () => Fixture<T> | Promise<Fixture<T>>;

function useFixture<T>(factory: Factory<T>): () => T {
  let fixture: Fixture<T> | undefined;
  beforeEach(async () => {
    fixture = await factory();
  });
  afterEach(async () => {
    await fixture?.cleanup?.();
    fixture = undefined;
  });
  return () => {
    if (!fixture) throw new Error("fixture not created");
    return fixture.instance;
  };
}

const day = (n: number, hour = 12) => Date.UTC(2024, 2, n, hour);

const flags = (over: Partial<Message["flags"]> = {}): Message["flags"] => ({
  seen: false,
  flagged: false,
  answered: false,
  draft: false,
  ...over,
});

/** `YYYY-MM-DD` of the local day of `ms`, as a user would type it. */
function localDay(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function describeMessageStoreContract(name: string, factory: Factory<MessageStorePort>) {
  describe(`MessageStorePort contract: ${name}`, () => {
    const store = useFixture(factory);

    it("stores messages and returns them by key in the requested order", async () => {
      const a = makeMessage({ dateMs: day(1) });
      const b = makeMessage({ dateMs: day(2) });
      await store().upsertMessages([a, b]);
      expect(await store().getByKeys([b.key, a.key])).toEqual([asStored(b), asStored(a)]);
    });

    it("skips unknown keys", async () => {
      const a = makeMessage({ dateMs: day(1) });
      await store().upsertMessages([a]);
      expect(await store().getByKeys([123, a.key])).toEqual([asStored(a)]);
    });

    it("replaces a message when its key is upserted again", async () => {
      const a = makeMessage({ dateMs: day(1), subject: "old" });
      await store().upsertMessages([a]);
      await store().upsertMessages([{ ...a, subject: "new", flags: { ...a.flags, seen: true } }]);
      const [got] = await store().getByKeys([a.key]);
      expect(got?.subject).toBe("new");
      expect(got?.flags.seen).toBe(true);
    });

    it("returns the effective keys in input order", async () => {
      const a = makeMessage({ dateMs: day(1) });
      const b = makeMessage({ dateMs: day(2) });
      const r = await store().upsertMessages([b, a]);
      expect(r.keys).toEqual([b.key, a.key]);
      expect((await store().upsertMessages([])).keys).toEqual([]);
    });

    it("keeps the first key of an identity when the date changes", async () => {
      const a = makeMessage({ dateMs: day(1), subject: "old" });
      await store().upsertMessages([a]);
      const moved = { ...a, dateMs: day(3), key: messageKey(day(3), 0), subject: "new" };
      const r = await store().upsertMessages([moved]);
      expect(r.keys).toEqual([a.key]);

      expect(await store().getByKeys([moved.key])).toEqual([]);
      const got = await store().listNewest({ limit: 10 });
      expect(got).toHaveLength(1);
      expect(got[0]).toMatchObject({ key: a.key, subject: "new", dateMs: day(3) });
    });

    it("reports effective keys for updates mixed with new messages", async () => {
      const a = makeMessage({ dateMs: day(1) });
      const b = makeMessage({ dateMs: day(2) });
      await store().upsertMessages([a]);
      const moved = { ...a, key: messageKey(day(5), 0) };
      const r = await store().upsertMessages([b, moved]);
      expect(r.keys).toEqual([b.key, a.key]);
      const c = await store().changesSince(0);
      expect([...c.changedKeys].sort()).toEqual([a.key, b.key].sort());
    });

    it("tells accounts apart by identity", async () => {
      const a = makeMessage({ dateMs: day(1), providerId: "same", accountId: "acc1" });
      const b = makeMessage({ dateMs: day(2), providerId: "same", accountId: "acc2" });
      const r = await store().upsertMessages([a, b]);
      expect(r.keys).toEqual([a.key, b.key]);
      expect(await store().getByKeys([a.key, b.key])).toEqual([asStored(a), asStored(b)]);
    });

    it("rejects a key collision between different identities", async () => {
      const a = makeMessage({ dateMs: day(1) });
      await store().upsertMessages([a]);
      const clash = makeMessage({ dateMs: day(1) });
      expect(clash.key).toBe(a.key);
      await expect(store().upsertMessages([clash])).rejects.toThrow(/key collision/i);
      expect(await store().getByKeys([a.key])).toEqual([asStored(a)]);
    });

    it("rejects collisions inside one batch and stores nothing", async () => {
      const ok = makeMessage({ dateMs: day(2) });
      const a = makeMessage({ dateMs: day(1) });
      const clash = makeMessage({ dateMs: day(1) });
      await expect(store().upsertMessages([ok, a, clash])).rejects.toThrow(/key collision/i);
      expect(await store().listNewest({ limit: 10 })).toEqual([]);
      expect((await store().changesSince(0)).changedKeys).toEqual([]);
    });

    it("round-trips every field", async () => {
      const m = makeMessage({
        dateMs: day(5),
        seq: 7,
        subject: "Żółw w Łodzi",
        from: person("Zażółć", "z@example.com"),
        to: [person("A", "a@example.com"), { address: "b@example.com" }],
        cc: [person("C", "c@example.com")],
        snippet: "źródło",
        flags: { seen: true, flagged: true, answered: true, draft: true },
        labelIds: ["inbox", "work"],
        hasAttachments: true,
        senderAuth: "pass",
      });
      await store().upsertMessages([m]);
      expect(await store().getByKeys([m.key])).toEqual([asStored(m)]);
    });

    it("keeps the sender verdict, and takes a new one when the message is stored again", async () => {
      const m = makeMessage({ dateMs: day(5), senderAuth: "fail" });
      await store().upsertMessages([m]);
      expect((await store().getByKeys([m.key]))[0]?.senderAuth).toBe("fail");
      expect((await store().listNewest({ limit: 5 }))[0]?.senderAuth).toBe("fail");
      expect((await store().getThread(m.threadId))?.messages[0]?.senderAuth).toBe("fail");
      await store().upsertMessages([{ ...m, senderAuth: "pass" }]);
      expect((await store().getByKeys([m.key]))[0]?.senderAuth).toBe("pass");
    });

    it("keeps the automated flag, and leaves it alone when a later upsert does not know it", async () => {
      const m = makeMessage({ dateMs: day(5), automated: true });
      const plain = makeMessage({ dateMs: day(6), automated: false });
      const unknown = makeMessage({ dateMs: day(7) });
      await store().upsertMessages([m, plain, unknown]);
      const [a, b, c] = await store().getByKeys([m.key, plain.key, unknown.key]);
      expect(a?.automated).toBe(true);
      expect(b?.automated).toBe(false);
      // Not known stays absent, it is not read as false.
      expect(c !== undefined && "automated" in c).toBe(false);
      await store().upsertMessages([{ ...m, automated: undefined, subject: "again" }]);
      expect((await store().getByKeys([m.key]))[0]).toMatchObject({
        subject: "again",
        automated: true,
      });
      await store().upsertMessages([{ ...m, automated: false }]);
      expect((await store().getByKeys([m.key]))[0]?.automated).toBe(false);
    });

    describe("listWrittenTo (ADR 0057)", () => {
      it("names who Sent mail went to or copied, lowercase, and nobody else", async () => {
        const s1 = makeMessage({
          providerId: "s1",
          threadId: "s",
          labelIds: ["sent"],
          to: [person("B", "Bob@Example.com")],
          cc: [person("C", "cara@example.com")],
        });
        await store().upsertMessages([
          s1,
          makeMessage({
            providerId: "r1",
            threadId: "r",
            labelIds: ["inbox"],
            to: [person("D", "dan@example.com")],
          }),
        ]);
        expect([...(await store().listWrittenTo())].sort()).toEqual([
          ["bob@example.com", { sent: 1, lastMs: s1.dateMs, name: "B" }],
          ["cara@example.com", { sent: 1, lastMs: s1.dateMs, name: "C" }],
        ]);
      });

      it("counts how many messages named an address and when the newest did (ADR 0066)", async () => {
        await store().upsertMessages([
          makeMessage({
            providerId: "s1",
            threadId: "s",
            dateMs: day(2),
            labelIds: ["sent"],
            to: [person("B", "bob@example.com")],
          }),
          makeMessage({
            providerId: "s2",
            threadId: "s",
            dateMs: day(9),
            labelIds: ["sent"],
            to: [person("B", "BOB@example.com")],
            cc: [person("C", "cara@example.com")],
          }),
        ]);
        const got = await store().listWrittenTo();
        // The name the person's mail gave the recipient comes with it (ADR 0068, rule 2).
        expect(got.get("bob@example.com")).toEqual({ sent: 2, lastMs: day(9), name: "B" });
        expect(got.get("cara@example.com")).toEqual({ sent: 1, lastMs: day(9), name: "C" });
      });
    });

    describe("listSentMail (ADR 0070)", () => {
      const sent = (providerId: string, dayN: number, subject: string, to: string, cc = "") =>
        makeMessage({
          providerId,
          threadId: providerId,
          dateMs: day(dayN),
          labelIds: ["sent"],
          subject,
          to: [person("X", to)],
          cc: cc === "" ? [] : [person("Y", cc)],
        });

      it("gives Sent mail newest first, with who it went to in lower case", async () => {
        await store().upsertMessages([
          sent("s1", 2, "Rozliczenie", "Tax@Mail.Northwind.Example"),
          sent("s2", 8, "Copied", "bob@elsewhere.example", "cara@northwind.example"),
          makeMessage({
            providerId: "r1",
            labelIds: ["inbox"],
            subject: "Received",
            to: [person("X", "anna@northwind.example")],
          }),
        ]);
        expect(await store().listSentMail()).toEqual([
          { subject: "Copied", recipients: ["bob@elsewhere.example", "cara@northwind.example"] },
          { subject: "Rozliczenie", recipients: ["tax@mail.northwind.example"] },
        ]);
      });

      it("leaves out Sent mail in Trash", async () => {
        await store().upsertMessages([
          { ...sent("s1", 2, "Deleted", "anna@northwind.example"), labelIds: ["sent", "trash"] },
          sent("s2", 3, "Kept", "anna@northwind.example"),
        ]);
        expect((await store().listSentMail()).map((m) => m.subject)).toEqual(["Kept"]);
      });
    });

    describe("listReceivedMail (ADR 0070)", () => {
      const received = (providerId: string, dayN: number, from: string, labelIds = ["inbox"]) =>
        makeMessage({
          providerId,
          threadId: `t-${providerId}`,
          dateMs: day(dayN),
          labelIds,
          from: person("X", from),
        });

      it("gives mail since a time, newest first, with the sender in lower case", async () => {
        await store().upsertMessages([
          received("r1", 2, "a@northwind.example"),
          received("r2", 5, "News@Mail.Northwind.Example"),
          received("r3", 7, "b@elsewhere.example"),
        ]);
        const since = async (dayN: number) =>
          (await store().listReceivedMail(day(dayN))).map((m) => [m.threadId, m.from]);
        expect(await since(1)).toEqual([
          ["t-r3", "b@elsewhere.example"],
          ["t-r2", "news@mail.northwind.example"],
          ["t-r1", "a@northwind.example"],
        ]);
        expect(await since(5)).toEqual([
          ["t-r3", "b@elsewhere.example"],
          ["t-r2", "news@mail.northwind.example"],
        ]);
      });

      it("leaves out the person's own Sent mail and mail in Trash and Spam", async () => {
        await store().upsertMessages([
          received("r1", 2, "a@northwind.example"),
          received("r2", 3, "a@northwind.example", ["sent"]),
          received("r3", 4, "a@northwind.example", ["trash"]),
          received("r4", 5, "a@northwind.example", ["spam"]),
        ]);
        expect((await store().listReceivedMail(day(1))).map((m) => m.threadId)).toEqual(["t-r1"]);
      });
    });

    describe("listSenderCounts (ADR 0102)", () => {
      const mail = (
        providerId: string,
        dayN: number,
        from: string,
        over: Parameters<typeof makeMessage>[0] = {},
      ) =>
        makeMessage({
          providerId,
          threadId: `t-${providerId}`,
          dateMs: day(dayN),
          from: person(`Name ${providerId}`, from),
          ...over,
        });
      const read = { seen: true, flagged: false, answered: false, draft: false };

      it("counts mail per sender since a time, most first, with unread and the newest name", async () => {
        await store().upsertMessages([
          mail("a1", 3, "Anna@North.example", { flags: read }),
          mail("a2", 5, "anna@north.example"),
          mail("a3", 6, "anna@north.example"),
          mail("b1", 7, "bob@north.example", { flags: read }),
          mail("c1", 8, "cara@south.example"),
          mail("old", 1, "cara@south.example"),
        ]);
        const got = await store().listSenderCounts(day(2), {
          accountIds: ["acc1"],
          by: "sender",
          limit: 10,
        });
        expect(got).toEqual([
          { key: "anna@north.example", name: "Name a3", messages: 3, unread: 2 },
          { key: "cara@south.example", name: "Name c1", messages: 1, unread: 1 },
          { key: "bob@north.example", name: "Name b1", messages: 1, unread: 0 },
        ]);
        expect(
          await store().listSenderCounts(day(2), { accountIds: ["acc1"], by: "sender", limit: 1 }),
        ).toHaveLength(1);
      });

      it("counts per domain, with no name", async () => {
        await store().upsertMessages([
          mail("a1", 3, "anna@north.example"),
          mail("b1", 4, "bob@north.example", { flags: read }),
          mail("c1", 5, "cara@south.example"),
        ]);
        expect(
          await store().listSenderCounts(day(1), { accountIds: ["acc1"], by: "domain", limit: 10 }),
        ).toEqual([
          { key: "north.example", messages: 2, unread: 1 },
          { key: "south.example", messages: 1, unread: 1 },
        ]);
      });

      it("leaves out other accounts, the person's own Sent mail, and mail in Trash and Spam", async () => {
        await store().upsertMessages([
          mail("a1", 3, "anna@north.example"),
          mail("a2", 4, "anna@north.example", { accountId: "acc2" }),
          mail("a3", 5, "anna@north.example", { labelIds: ["sent"] }),
          mail("a4", 6, "anna@north.example", { labelIds: ["trash"] }),
          mail("a5", 7, "anna@north.example", { labelIds: ["spam"] }),
        ]);
        expect(
          await store().listSenderCounts(day(1), { accountIds: ["acc1"], by: "sender", limit: 10 }),
        ).toEqual([{ key: "anna@north.example", name: "Name a1", messages: 1, unread: 1 }]);
        expect(
          await store().listSenderCounts(day(1), { accountIds: [], by: "sender", limit: 10 }),
        ).toEqual([]);
      });
    });

    describe("listThreadsSince (ADR 0052)", () => {
      const put = (over: Parameters<typeof makeMessage>[0]) => {
        const m = makeMessage(over);
        return m;
      };

      it("lists threads with a message in the window, newest activity first, and no text", async () => {
        const a1 = put({
          dateMs: day(2),
          threadId: "ta",
          providerId: "a1",
          from: person("A", "A@Example.com"),
        });
        const a2 = put({ dateMs: day(9), threadId: "ta", providerId: "a2", automated: true });
        const b1 = put({ dateMs: day(5), threadId: "tb", providerId: "b1" });
        const old = put({ dateMs: day(1), threadId: "told", providerId: "o1" });
        await store().upsertMessages([a1, a2, b1, old]);
        const got = await store().listThreadsSince(day(3), 10);
        expect(got.map((t) => t.threadId)).toEqual(["ta", "tb"]);
        const [first] = got;
        expect(first).toEqual({
          threadId: "ta",
          accountId: "acc1",
          lastMessageKey: a2.key,
          lastDateMs: a2.dateMs,
          lastFromOwn: false,
          subject: a2.subject,
          // All of the thread's messages, also those before the window, oldest first; addresses lower case.
          messages: [{ from: "a@example.com" }, { from: "sender@example.com", automated: true }],
        });
      });

      it("includes a message dated exactly at the start of the window, not one before it", async () => {
        const at = put({ dateMs: day(3), threadId: "t1", providerId: "p1" });
        const before = put({ dateMs: day(3) - 1, threadId: "t2", providerId: "p2" });
        await store().upsertMessages([at, before]);
        expect((await store().listThreadsSince(day(3), 10)).map((t) => t.threadId)).toEqual(["t1"]);
      });

      it("limits the number of threads and keeps the newest", async () => {
        const ms = [1, 2, 3, 4].map((d) =>
          put({ dateMs: day(d), threadId: `t${d}`, providerId: `p${d}` }),
        );
        await store().upsertMessages(ms);
        expect((await store().listThreadsSince(0, 2)).map((t) => t.threadId)).toEqual(["t4", "t3"]);
        expect(await store().listThreadsSince(0, 0)).toEqual([]);
      });

      it("leaves out Trash and Spam as All mail does", async () => {
        const keep = put({ dateMs: day(2), threadId: "tk", providerId: "k1" });
        const trashed = put({
          dateMs: day(5),
          threadId: "tt",
          providerId: "t1",
          labelIds: ["trash"],
        });
        const spam = put({ dateMs: day(6), threadId: "ts", providerId: "s1", labelIds: ["spam"] });
        // A thread whose newest message was deleted is a thread whose last message is the older one.
        const older = put({ dateMs: day(4), threadId: "tm", providerId: "m1" });
        const gone = put({ dateMs: day(8), threadId: "tm", providerId: "m2", labelIds: ["trash"] });
        await store().upsertMessages([keep, trashed, spam, older, gone]);
        const got = await store().listThreadsSince(0, 10);
        expect(got.map((t) => t.threadId)).toEqual(["tm", "tk"]);
        expect(got[0]).toMatchObject({
          lastMessageKey: older.key,
          messages: [{ from: "sender@example.com" }],
        });
      });

      it("says whether the newest message is in a Sent mailbox", async () => {
        const inbound = put({ dateMs: day(2), threadId: "t1", providerId: "p1" });
        const reply = put({ dateMs: day(3), threadId: "t1", providerId: "p2", labelIds: ["sent"] });
        const unanswered = put({ dateMs: day(4), threadId: "t2", providerId: "p3" });
        await store().upsertMessages([inbound, reply, unanswered]);
        const got = await store().listThreadsSince(0, 10);
        expect(got.map((t) => [t.threadId, t.lastFromOwn])).toEqual([
          ["t2", false],
          ["t1", true],
        ]);
      });

      it("keeps the accounts apart", async () => {
        const a = put({ dateMs: day(2), threadId: "t1", providerId: "p1", accountId: "acc1" });
        const b = put({ dateMs: day(3), threadId: "t2", providerId: "p2", accountId: "acc2" });
        await store().upsertMessages([a, b]);
        const got = await store().listThreadsSince(0, 10);
        expect(got.map((t) => t.accountId)).toEqual(["acc2", "acc1"]);
      });

      it("is empty for an empty store", async () => {
        expect(await store().listThreadsSince(0, 10)).toEqual([]);
      });
    });

    it("lists newest first with a limit", async () => {
      const ms = [1, 2, 3, 4].map((d) => makeMessage({ dateMs: day(d) }));
      await store().upsertMessages([
        ms[2] as never,
        ms[0] as never,
        ms[3] as never,
        ms[1] as never,
      ]);
      const got = await store().listNewest({ limit: 3 });
      expect(got.map((m) => m.key)).toEqual([ms[3]?.key, ms[2]?.key, ms[1]?.key]);
    });

    it("paginates with beforeKey and never repeats or skips", async () => {
      const ms = Array.from({ length: 25 }, (_, i) => makeMessage({ dateMs: day(1) + i * 1000 }));
      await store().upsertMessages(ms);
      const seen: number[] = [];
      let before: number | undefined;
      for (let page = 0; page < 10; page++) {
        const got = await store().listNewest({
          limit: 10,
          ...(before === undefined ? {} : { beforeKey: before }),
        });
        if (got.length === 0) break;
        seen.push(...got.map((m) => m.key));
        before = got[got.length - 1]?.key;
      }
      expect(seen).toEqual(ms.map((m) => m.key).sort((a, b) => b - a));
    });

    it("filters by label", async () => {
      const inbox = makeMessage({ dateMs: day(1), labelIds: ["inbox"] });
      const sent = makeMessage({ dateMs: day(2), labelIds: ["sent"] });
      const both = makeMessage({ dateMs: day(3), labelIds: ["inbox", "sent"] });
      await store().upsertMessages([inbox, sent, both]);
      const got = await store().listNewest({ labelId: "inbox", limit: 10 });
      expect(got.map((m) => m.key)).toEqual([both.key, inbox.key]);
    });

    it("keeps messages with equal dates distinct and ordered by seq", async () => {
      const a = makeMessage({ dateMs: day(1), seq: 0 });
      const b = makeMessage({ dateMs: day(1), seq: 1 });
      await store().upsertMessages([a, b]);
      const got = await store().listNewest({ limit: 10 });
      expect(got.map((m) => m.key)).toEqual([b.key, a.key]);
    });

    it("returns a thread ascending with its summary", async () => {
      const t = "thread-1";
      const m1 = makeMessage({
        dateMs: day(1),
        threadId: t,
        subject: "Hello",
        labelIds: ["inbox"],
        flags: { seen: true, flagged: false, answered: false, draft: false },
      });
      const m2 = makeMessage({
        dateMs: day(2),
        threadId: t,
        subject: "Re: Hello",
        labelIds: ["sent"],
      });
      const m3 = makeMessage({
        dateMs: day(3),
        threadId: t,
        subject: "Re: Hello",
        labelIds: ["inbox"],
      });
      const other = makeMessage({ dateMs: day(4), threadId: "thread-2" });
      await store().upsertMessages([m3, other, m1, m2]);

      const view = await store().getThread(t);
      expect(view?.messages.map((m) => m.key)).toEqual([m1.key, m2.key, m3.key]);
      expect(view?.thread).toMatchObject({
        id: t,
        accountId: m1.accountId,
        subject: "Hello",
        messageKeys: [m1.key, m2.key, m3.key],
        lastMessageKey: m3.key,
        unreadCount: 2,
      });
      expect([...(view?.thread.labelIds ?? [])].sort()).toEqual(["inbox", "sent"]);
    });

    it("returns null for an unknown thread", async () => {
      expect(await store().getThread("nope")).toBeNull();
    });

    it("reports changes since a sequence", async () => {
      const empty = await store().changesSince(0);
      expect(empty.changedKeys).toEqual([]);

      const a = makeMessage({ dateMs: day(1) });
      const b = makeMessage({ dateMs: day(2) });
      const r1 = await store().upsertMessages([a]);
      const r2 = await store().upsertMessages([b]);
      expect(r2.changeSeq).toBeGreaterThan(r1.changeSeq);

      const all = await store().changesSince(0);
      expect(all.changeSeq).toBe(r2.changeSeq);
      expect([...all.changedKeys].sort()).toEqual([a.key, b.key].sort());

      const afterFirst = await store().changesSince(r1.changeSeq);
      expect(afterFirst.changedKeys).toEqual([b.key]);

      const none = await store().changesSince(r2.changeSeq);
      expect(none).toEqual({ changeSeq: r2.changeSeq, changedKeys: [], removedKeys: [] });
    });

    it("reports an updated message as changed again, once", async () => {
      const a = makeMessage({ dateMs: day(1) });
      const r1 = await store().upsertMessages([a]);
      await store().upsertMessages([{ ...a, flags: { ...a.flags, seen: true } }]);
      await store().upsertMessages([{ ...a, flags: { ...a.flags, seen: true, flagged: true } }]);
      const c = await store().changesSince(r1.changeSeq);
      expect(c.changedKeys).toEqual([a.key]);
    });

    it("does not advance the sequence for an empty batch", async () => {
      const r1 = await store().upsertMessages([makeMessage({ dateMs: day(1) })]);
      const r2 = await store().upsertMessages([]);
      expect(r2.changeSeq).toBe(r1.changeSeq);
    });

    describe("removal", () => {
      it("removes by provider id, returns the keys in input order and skips unknown ids", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2) });
        const c = makeMessage({ dateMs: day(3) });
        await store().upsertMessages([a, b, c]);

        const removed = await store().removeByProviderIds("acc1", [
          c.providerId,
          "nope",
          a.providerId,
          c.providerId,
        ]);
        expect(removed).toEqual([c.key, a.key]);
        expect(await store().getByKeys([a.key, b.key, c.key])).toEqual([asStored(b)]);
        expect((await store().listNewest({ limit: 10 })).map((m) => m.key)).toEqual([b.key]);
        expect(await store().removeByProviderIds("acc1", [])).toEqual([]);
      });

      it("only touches the given account and drops the thread view and label entries", async () => {
        const mine = makeMessage({ dateMs: day(1), threadId: "t", labelIds: ["inbox"] });
        const other = makeMessage({
          dateMs: day(2),
          providerId: mine.providerId,
          accountId: "acc2",
          threadId: "t2",
        });
        await store().upsertMessages([mine, other]);

        expect(await store().removeByProviderIds("acc1", [mine.providerId])).toEqual([mine.key]);
        expect(await store().getThread("t")).toBeNull();
        expect(
          (await store().listNewest({ labelId: "inbox", limit: 10 })).map((m) => m.key),
        ).toEqual([other.key]);
        expect(await store().getByKeys([other.key])).toEqual([asStored(other)]);
      });

      it("frees the identity: a later upsert stores it again", async () => {
        const a = makeMessage({ dateMs: day(1), subject: "first life" });
        await store().upsertMessages([a]);
        await store().removeByProviderIds("acc1", [a.providerId]);
        const again = { ...a, subject: "second life" };
        const r = await store().upsertMessages([again]);
        expect(r.keys).toEqual([a.key]);
        expect((await store().getByKeys([a.key]))[0]?.subject).toBe("second life");
      });

      it("reports removals in changesSince, bumping the sequence only when something went", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2) });
        const r1 = await store().upsertMessages([a, b]);

        const none = await store().removeByProviderIds("acc1", ["nope"]);
        expect(none).toEqual([]);
        expect((await store().changesSince(0)).changeSeq).toBe(r1.changeSeq);

        await store().removeByProviderIds("acc1", [a.providerId]);
        const since = await store().changesSince(r1.changeSeq);
        expect(since.changeSeq).toBeGreaterThan(r1.changeSeq);
        expect(since.removedKeys).toEqual([a.key]);
        expect(since.changedKeys).toEqual([]);

        const all = await store().changesSince(0);
        expect(all.changedKeys).toEqual([b.key]);
        expect(all.removedKeys).toEqual([a.key]);
        expect((await store().changesSince(since.changeSeq)).removedKeys).toEqual([]);
      });

      it("reports a message changed and then removed only as removed", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const r1 = await store().upsertMessages([a]);
        await store().upsertMessages([{ ...a, flags: { ...a.flags, seen: true } }]);
        await store().removeByProviderIds("acc1", [a.providerId]);
        const c = await store().changesSince(r1.changeSeq);
        expect(c.changedKeys).toEqual([]);
        expect(c.removedKeys).toEqual([a.key]);
      });

      it("reports a message stored again after removal as changed, not removed", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const r1 = await store().upsertMessages([a]);
        await store().removeByProviderIds("acc1", [a.providerId]);
        await store().upsertMessages([a]);
        const c = await store().changesSince(r1.changeSeq);
        expect(c.changedKeys).toEqual([a.key]);
        expect(c.removedKeys).toEqual([]);
      });
    });

    describe("locations (ADR 0016)", () => {
      const at = (uid: number, folderId = "INBOX", uidValidity = "1") =>
        makeLocation(uid, folderId, uidValidity);

      it("finds keys by provider id and leaves unknown ids and other accounts out", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2), accountId: "acc2", providerId: a.providerId });
        await store().upsertMessages([a, b]);
        const found = await store().findByProviderIds("acc1", [a.providerId, "nope"]);
        expect([...found]).toEqual([[a.providerId, a.key]]);
        expect((await store().findByProviderIds("acc1", [])).size).toBe(0);
      });

      it("allocates distinct unused keys, also for equal dates", async () => {
        const taken = makeMessage({ dateMs: day(1), seq: 0 });
        await store().upsertMessages([taken]);
        const keys = await store().allocateKeys([day(1), day(1), day(2), day(1)]);
        expect(new Set(keys).size).toBe(4);
        expect(keys).not.toContain(taken.key);
        expect(keys.map((k) => splitMessageKey(k).dateMs)).toEqual([
          day(1),
          day(1),
          day(2),
          day(1),
        ]);
        await store().upsertMessages(keys.map((key) => makeMessage({ key })));
      });

      it("stores locations, lists UIDs per folder and UIDVALIDITY ascending, and is idempotent", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2) });
        await store().upsertMessages([a, b]);
        const entries = [
          { key: b.key, location: at(7) },
          { key: a.key, location: at(3) },
          { key: a.key, location: at(5, "Archive") },
          { key: a.key, location: at(9, "INBOX", "2") },
        ];
        await store().addLocations(entries);
        await store().addLocations(entries);
        expect(await store().listLocationUids("acc1", "INBOX", "1")).toEqual([3, 7]);
        expect(await store().listLocationUids("acc1", "Archive", "1")).toEqual([5]);
        expect(await store().listLocationUids("acc1", "INBOX", "2")).toEqual([9]);
        expect(await store().listLocationUids("acc2", "INBOX", "1")).toEqual([]);
        expect(await store().getLocations(a.key)).toEqual([
          at(5, "Archive"),
          at(3),
          at(9, "INBOX", "2"),
        ]);
      });

      it("rejects a location for an unknown key and stores none of the batch", async () => {
        const a = makeMessage({ dateMs: day(1) });
        await store().upsertMessages([a]);
        await expect(
          store().addLocations([
            { key: a.key, location: at(1) },
            { key: 12345, location: at(2) },
          ]),
        ).rejects.toThrow();
        expect(await store().listLocationUids("acc1", "INBOX", "1")).toEqual([]);
      });

      it("keeps a message while another location is left and deletes it with the last one", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2) });
        const r = await store().upsertMessages([a, b]);
        await store().addLocations([
          { key: a.key, location: at(1) },
          { key: a.key, location: at(2, "Archive") },
          { key: b.key, location: at(3) },
        ]);

        const first = await store().removeLocations([at(1), at(99)]);
        expect(first).toEqual({ deletedKeys: [], survivingKeys: [a.key] });
        expect(await store().getByKeys([a.key])).toEqual([asStored(a)]);
        expect((await store().changesSince(0)).changeSeq).toBe(r.changeSeq);

        const second = await store().removeLocations([at(2, "Archive"), at(3)]);
        expect([...second.deletedKeys].sort()).toEqual([a.key, b.key].sort());
        expect(second.survivingKeys).toEqual([]);
        expect(await store().getByKeys([a.key, b.key])).toEqual([]);
        const changes = await store().changesSince(r.changeSeq);
        expect([...changes.removedKeys].sort()).toEqual([a.key, b.key].sort());
        expect(await store().getLocations(a.key)).toEqual([]);
      });

      it("drops the locations of a removed message", async () => {
        const a = makeMessage({ dateMs: day(1) });
        await store().upsertMessages([a]);
        await store().addLocations([{ key: a.key, location: at(1) }]);
        await store().removeByProviderIds("acc1", [a.providerId]);
        expect(await store().listLocationUids("acc1", "INBOX", "1")).toEqual([]);
      });

      it("resets a folder except one UIDVALIDITY and deletes what is left without a location", async () => {
        const kept = makeMessage({ dateMs: day(1) });
        const copied = makeMessage({ dateMs: day(2) });
        const gone = makeMessage({ dateMs: day(3) });
        await store().upsertMessages([kept, copied, gone]);
        await store().addLocations([
          { key: kept.key, location: at(1, "INBOX", "1") },
          { key: kept.key, location: at(1, "INBOX", "2") },
          { key: copied.key, location: at(2, "INBOX", "1") },
          { key: copied.key, location: at(1, "Archive", "1") },
          { key: gone.key, location: at(3, "INBOX", "1") },
        ]);
        const r = await store().removeFolderLocations("acc1", "INBOX", "2");
        expect(r.deletedKeys).toEqual([gone.key]);
        expect([...r.survivingKeys].sort()).toEqual([kept.key, copied.key].sort());
        expect(await store().listLocationUids("acc1", "INBOX", "1")).toEqual([]);
        expect(await store().listLocationUids("acc1", "INBOX", "2")).toEqual([1]);
        expect(await store().listLocationUids("acc1", "Archive", "1")).toEqual([1]);

        const all = await store().removeFolderLocations("acc1", "INBOX");
        expect(all.deletedKeys).toEqual([kept.key]);
      });

      it("updates flags by location, only for what changed, and skips unknown locations", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2) });
        const r = await store().upsertMessages([a, b]);
        await store().addLocations([
          { key: a.key, location: at(1) },
          { key: b.key, location: at(2) },
        ]);
        const read = { ...a.flags, seen: true };

        const changed = await store().updateFlags([
          { location: at(1), flags: read },
          { location: at(2), flags: b.flags },
          { location: at(99), flags: read },
        ]);
        expect(changed).toEqual([a.key]);
        expect((await store().getByKeys([a.key]))[0]?.flags).toEqual(read);
        expect((await store().changesSince(r.changeSeq)).changedKeys).toEqual([a.key]);

        const seq = (await store().changesSince(0)).changeSeq;
        expect(await store().updateFlags([{ location: at(1), flags: read }])).toEqual([]);
        expect((await store().changesSince(0)).changeSeq).toBe(seq);
      });

      it("sets and clears seen by key, leaves other flags and unknown keys alone, bumps once", async () => {
        const a = makeMessage({ dateMs: day(1), flags: flags({ flagged: true }) });
        const b = makeMessage({ dateMs: day(2), flags: flags({ seen: true }) });
        const c = makeMessage({ dateMs: day(3) });
        const up = await store().upsertMessages([a, b, c]);

        const read = await store().setSeen([a.key, b.key, 424242], true);
        // b already had it: only a changed, and the sequence moved by one.
        expect(read.changedKeys).toEqual([a.key]);
        expect(read.changeSeq).toBe(up.changeSeq + 1);
        expect((await store().getByKeys([a.key]))[0]?.flags).toEqual(
          flags({ seen: true, flagged: true }),
        );
        expect((await store().changesSince(up.changeSeq)).changedKeys).toEqual([a.key]);

        const both = await store().setSeen([a.key, b.key, c.key], false);
        expect([...both.changedKeys].sort()).toEqual([a.key, b.key].sort());
        expect(both.changeSeq).toBe(read.changeSeq + 1);
        expect((await store().getByKeys([a.key]))[0]?.flags).toEqual(flags({ flagged: true }));
        expect((await store().getByKeys([b.key]))[0]?.flags.seen).toBe(false);
      });

      it("does not touch the sequence when every message already has the state", async () => {
        const a = makeMessage({ dateMs: day(1) });
        await store().upsertMessages([a]);
        const seq = (await store().changesSince(0)).changeSeq;
        expect(await store().setSeen([a.key], false)).toEqual({ changeSeq: seq, changedKeys: [] });
        expect(await store().setSeen([], true)).toEqual({ changeSeq: seq, changedKeys: [] });
        expect((await store().changesSince(0)).changeSeq).toBe(seq);
      });

      it("counts a thread's unread messages from the flag", async () => {
        const a = makeMessage({ dateMs: day(1), threadId: "t-seen" });
        const b = makeMessage({ dateMs: day(2), threadId: "t-seen" });
        await store().upsertMessages([a, b]);
        await store().setSeen([a.key], true);
        expect((await store().getThread("t-seen"))?.thread.unreadCount).toBe(1);
      });

      it("replaces provider labels with an update that carries them", async () => {
        const a = makeMessage({ dateMs: day(1), labelIds: ["inbox"] });
        await store().upsertMessages([a]);
        await store().addLocations([{ key: a.key, location: at(1) }]);
        await store().updateFlags([
          { location: at(1), flags: a.flags, labelIds: ["inbox", "starred"] },
        ]);
        expect((await store().getByKeys([a.key]))[0]?.labelIds).toEqual(["inbox", "starred"]);
        expect(
          (await store().listNewest({ labelId: "starred", limit: 10 })).map((m) => m.key),
        ).toEqual([a.key]);
      });

      it("derives labels from the folders of the locations and leaves location-less messages alone", async () => {
        const a = makeMessage({ dateMs: day(1), labelIds: ["wrong"] });
        const b = makeMessage({ dateMs: day(2), labelIds: ["kept"] });
        await store().upsertMessages([a, b]);
        await store().addLocations([
          { key: a.key, location: at(1, "INBOX") },
          { key: a.key, location: at(2, "Archive") },
        ]);
        await store().deriveLabelsFromLocations([a.key, b.key, 424242]);
        expect((await store().getByKeys([a.key]))[0]?.labelIds).toEqual(["Archive", "INBOX"]);
        expect((await store().getByKeys([b.key]))[0]?.labelIds).toEqual(["kept"]);
        expect(
          (await store().listNewest({ labelId: "wrong", limit: 10 })).map((m) => m.key),
        ).toEqual([]);

        const seq = (await store().changesSince(0)).changeSeq;
        await store().deriveLabelsFromLocations([a.key]);
        expect((await store().changesSince(0)).changeSeq).toBe(seq);
      });

      it("removes every message, label and location of one account and no other", async () => {
        const a = makeMessage({ dateMs: day(1), accountId: "acc1" });
        const b = makeMessage({ dateMs: day(2), accountId: "acc1", labelIds: ["x"] });
        const c = makeMessage({ dateMs: day(3), accountId: "acc2", providerId: a.providerId });
        await store().upsertMessages([a, b, c]);
        await store().addLocations([
          { key: a.key, location: at(1) },
          { key: c.key, location: makeLocation(1, "INBOX", "1", "acc2") },
        ]);
        const seq = (await store().changesSince(0)).changeSeq;

        const removed = await store().removeAccountMessages("acc1");

        expect([...removed].sort()).toEqual([a.key, b.key].sort());
        expect((await store().listNewest({ limit: 10 })).map((m) => m.key)).toEqual([c.key]);
        expect(await store().getLocations(a.key)).toEqual([]);
        expect(await store().getLocations(c.key)).toHaveLength(1);
        expect(await store().listNewest({ labelId: "x", limit: 10 })).toEqual([]);
        const changes = await store().changesSince(seq);
        expect(changes.changeSeq).toBe(seq + 1);
        expect([...changes.removedKeys].sort()).toEqual([a.key, b.key].sort());

        expect(await store().removeAccountMessages("acc1")).toEqual([]);
        expect((await store().changesSince(0)).changeSeq).toBe(seq + 1);
      });

      it("lists distinct folded label names, sorted, across accounts", async () => {
        expect(await store().listLabels()).toEqual([]);
        await store().upsertMessages([
          makeMessage({ dateMs: day(1), accountId: "acc1", labelIds: ["Work", "INBOX"] }),
          makeMessage({ dateMs: day(2), accountId: "acc1", labelIds: ["inbox", "Żółw"] }),
          makeMessage({ dateMs: day(3), accountId: "acc2", labelIds: ["Work"] }),
        ]);
        expect(await store().listLabels()).toEqual(["inbox", "work", "zolw"]);
      });

      it("caps the label list at 500", async () => {
        const batch = Array.from({ length: 520 }, (_, i) =>
          makeMessage({ dateMs: day(1) + i, labelIds: [`l${String(i).padStart(4, "0")}`] }),
        );
        await store().upsertMessages(batch);
        const labels = await store().listLabels();
        expect(labels).toHaveLength(500);
        expect(labels[0]).toBe("l0000");
        expect(labels[499]).toBe("l0499");
      });
    });
    describe("Reply-To (ADR 0042)", () => {
      const help = [{ name: "Help", address: "help@shop.example" }];
      const at = (uid: number, folderId = "INBOX", uidValidity = "1", accountId = "acc1") =>
        makeLocation(uid, folderId, uidValidity, accountId);
      /** A message stored with the location it was found at. */
      async function put(over: Partial<Message>, location: ReturnType<typeof at>) {
        const m = makeMessage(over);
        const { keys } = await store().upsertMessages([m]);
        await store().addLocations([{ key: keys[0] as number, location }]);
        return keys[0] as number;
      }
      const replyToOf = async (key: number) => (await store().getByKeys([key]))[0]?.replyTo;

      it("tells unknown from none: absent stays absent, an empty list stays empty", async () => {
        const a = makeMessage({ dateMs: day(1) });
        const b = makeMessage({ dateMs: day(2), replyTo: [] });
        const c = makeMessage({ dateMs: day(3), replyTo: help });
        await store().upsertMessages([a, b, c]);
        expect(await replyToOf(a.key)).toBeUndefined();
        expect(await replyToOf(b.key)).toEqual([]);
        expect(await replyToOf(c.key)).toEqual(help);
      });

      it("keeps a known value when the message is upserted again without one", async () => {
        const a = makeMessage({ dateMs: day(1), replyTo: help });
        await store().upsertMessages([a]);
        const { replyTo: _dropped, ...unknown } = a;
        await store().upsertMessages([{ ...unknown, subject: "changed" }]);
        const [got] = await store().getByKeys([a.key]);
        expect(got?.subject).toBe("changed");
        expect(got?.replyTo).toEqual(help);
      });

      it("takes a newer value when the message is upserted with one", async () => {
        const a = makeMessage({ dateMs: day(1), replyTo: help });
        await store().upsertMessages([a]);
        await store().upsertMessages([{ ...a, replyTo: [] }]);
        expect(await replyToOf(a.key)).toEqual([]);
      });

      it("lists the UIDs of one folder whose message does not know, newest message first, ascending", async () => {
        await put({ dateMs: day(1), providerId: "old" }, at(7));
        await put({ dateMs: day(2), providerId: "mid" }, at(3));
        await put({ dateMs: day(3), providerId: "new" }, at(5));
        await put({ dateMs: day(4), providerId: "known", replyTo: [] }, at(9));
        await put({ dateMs: day(5), providerId: "other" }, at(1, "Work"));
        await put({ dateMs: day(6), providerId: "epoch" }, at(2, "INBOX", "2"));
        await put(
          { dateMs: day(7), providerId: "else", accountId: "acc2" },
          at(4, "INBOX", "1", "acc2"),
        );
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "1", 10)).toEqual([3, 5, 7]);
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "1", 2)).toEqual([3, 5]);
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "1", 0)).toEqual([]);
        expect(await store().listUnknownReplyToUids("acc1", "Work", "1", 10)).toEqual([1]);
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "2", 10)).toEqual([2]);
        expect(await store().listUnknownReplyToUids("acc2", "INBOX", "1", 10)).toEqual([4]);
        expect(await store().listUnknownReplyToUids("acc1", "Nope", "1", 10)).toEqual([]);
      });

      it("lists a message with copies in this folder's own UID only", async () => {
        const key = await put({ dateMs: day(1) }, at(3));
        await store().addLocations([{ key, location: at(8, "Work") }]);
        expect(await store().listUnknownReplyToUids("acc1", "Work", "1", 10)).toEqual([8]);
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "1", 10)).toEqual([3]);
      });

      it("sets what the server said, once", async () => {
        const key = await put({ dateMs: day(1) }, at(3));
        expect(await store().setReplyTo([{ location: at(3), replyTo: help }])).toEqual([key]);
        expect(await replyToOf(key)).toEqual(help);
        expect(await store().listUnknownReplyToUids("acc1", "INBOX", "1", 10)).toEqual([]);

        // A second answer finds it known: nothing is replaced.
        expect(await store().setReplyTo([{ location: at(3), replyTo: [] }])).toEqual([]);
        expect(await replyToOf(key)).toEqual(help);
      });

      it("skips locations it does not have, and answers that repeat", async () => {
        const key = await put({ dateMs: day(1) }, at(3));
        const done = await store().setReplyTo([
          { location: at(99), replyTo: help },
          { location: at(3), replyTo: help },
          { location: at(3), replyTo: [] },
        ]);
        expect(done).toEqual([key]);
        expect(await replyToOf(key)).toEqual(help);
        expect(await store().setReplyTo([])).toEqual([]);
      });

      it("announces a change when someone is named, and stays quiet for none", async () => {
        const named = await put({ dateMs: day(1), providerId: "named" }, at(1));
        const none = await put({ dateMs: day(2), providerId: "none" }, at(2));
        const before = await store().changesSince(0);

        await store().setReplyTo([{ location: at(2), replyTo: [] }]);
        const quiet = await store().changesSince(before.changeSeq);
        expect(quiet.changeSeq).toBe(before.changeSeq);
        expect(quiet.changedKeys).toEqual([]);
        expect(await replyToOf(none)).toEqual([]);

        await store().setReplyTo([{ location: at(1), replyTo: help }]);
        const loud = await store().changesSince(before.changeSeq);
        expect(loud.changeSeq).toBeGreaterThan(before.changeSeq);
        expect(loud.changedKeys).toEqual([named]);
      });
    });

    describe("whether a message is automated (ADR 0066, rule 6)", () => {
      const at = (uid: number, folderId = "INBOX", uidValidity = "1", accountId = "acc1") =>
        makeLocation(uid, folderId, uidValidity, accountId);
      async function put(over: Partial<Message>, location: ReturnType<typeof at>) {
        const m = makeMessage(over);
        const { keys } = await store().upsertMessages([m]);
        await store().addLocations([{ key: keys[0] as number, location }]);
        return keys[0] as number;
      }
      const automatedOf = async (key: number) => (await store().getByKeys([key]))[0]?.automated;

      it("lists the UIDs of one folder whose message has no flag, newest first, ascending", async () => {
        await put({ dateMs: day(1), providerId: "old" }, at(7));
        await put({ dateMs: day(2), providerId: "mid" }, at(3));
        await put({ dateMs: day(3), providerId: "new" }, at(5));
        await put({ dateMs: day(4), providerId: "known", automated: false }, at(9));
        await put({ dateMs: day(5), providerId: "listed", automated: true }, at(10));
        await put({ dateMs: day(6), providerId: "other" }, at(1, "Work"));
        await put(
          { dateMs: day(7), providerId: "else", accountId: "acc2" },
          at(4, "INBOX", "1", "acc2"),
        );
        expect(await store().listUnknownAutomatedUids("acc1", "INBOX", "1", 10)).toEqual([3, 5, 7]);
        expect(await store().listUnknownAutomatedUids("acc1", "INBOX", "1", 2)).toEqual([3, 5]);
        expect(await store().listUnknownAutomatedUids("acc1", "INBOX", "1", 0)).toEqual([]);
        expect(await store().listUnknownAutomatedUids("acc1", "Work", "1", 10)).toEqual([1]);
        expect(await store().listUnknownAutomatedUids("acc2", "INBOX", "1", 10)).toEqual([4]);
        expect(await store().listUnknownAutomatedUids("acc1", "Nope", "1", 10)).toEqual([]);
      });

      it("sets what the headers said, once, and never replaces a value", async () => {
        const key = await put({ dateMs: day(1) }, at(3));
        expect(await automatedOf(key)).toBeUndefined();
        expect(await store().setAutomated([{ location: at(3), automated: true }])).toEqual([key]);
        expect(await automatedOf(key)).toBe(true);
        expect(await store().listUnknownAutomatedUids("acc1", "INBOX", "1", 10)).toEqual([]);
        expect(await store().setAutomated([{ location: at(3), automated: false }])).toEqual([]);
        expect(await automatedOf(key)).toBe(true);
      });

      it("writes false as false, skips locations it does not have, and takes none", async () => {
        const key = await put({ dateMs: day(1) }, at(3));
        const done = await store().setAutomated([
          { location: at(99), automated: true },
          { location: at(3), automated: false },
        ]);
        expect(done).toEqual([key]);
        expect(await automatedOf(key)).toBe(false);
        expect(await store().setAutomated([])).toEqual([]);
      });

      it("announces no change: the flag shows nothing different to anyone", async () => {
        await put({ dateMs: day(1) }, at(3));
        const before = await store().changesSince(0);
        await store().setAutomated([{ location: at(3), automated: true }]);
        const after = await store().changesSince(before.changeSeq);
        expect(after.changeSeq).toBe(before.changeSeq);
        expect(after.changedKeys).toEqual([]);
      });
    });

    describe("files of a message (ADR 0043)", () => {
      const at = (uid: number, folderId = "INBOX", uidValidity = "1", accountId = "acc1") =>
        makeLocation(uid, folderId, uidValidity, accountId);
      const file = (partId: string, name: string, over: Partial<ReceivedAttachment> = {}) => ({
        partId,
        name,
        mimeType: "application/pdf",
        size: 1000,
        inline: false,
        ...over,
      });
      async function put(over: Partial<Message>, location: ReturnType<typeof at>) {
        const m = makeMessage(over);
        const { keys } = await store().upsertMessages([m]);
        await store().addLocations([{ key: keys[0] as number, location }]);
        return keys[0] as number;
      }
      const threadFiles = async (threadId: string) =>
        (await store().getThread(threadId))?.attachments;

      it("starts a message with no files as known and one that claims files as not known", async () => {
        const plain = makeMessage({ dateMs: day(1), threadId: "t1" });
        const claims = makeMessage({ dateMs: day(2), threadId: "t2", hasAttachments: true });
        await store().upsertMessages([plain, claims]);
        expect((await threadFiles("t1"))?.get(plain.key)).toEqual({
          known: true,
          items: [],
          hasInline: false,
        });
        expect((await threadFiles("t2"))?.get(claims.key)).toEqual({
          known: false,
          items: [],
          hasInline: false,
        });
      });

      it("lists the unknown UIDs of one folder, newest message first, ascending", async () => {
        await put({ dateMs: day(1), providerId: "old", hasAttachments: true }, at(7));
        await put({ dateMs: day(2), providerId: "mid", hasAttachments: true }, at(3));
        await put({ dateMs: day(3), providerId: "new", hasAttachments: true }, at(5));
        await put({ dateMs: day(4), providerId: "plain" }, at(9));
        await put({ dateMs: day(5), providerId: "other", hasAttachments: true }, at(1, "Work"));
        await put(
          { dateMs: day(6), providerId: "epoch", hasAttachments: true },
          at(2, "INBOX", "2"),
        );
        await put(
          { dateMs: day(7), providerId: "else", accountId: "acc2", hasAttachments: true },
          at(4, "INBOX", "1", "acc2"),
        );
        const list = (a: string, f: string, v: string, n: number) =>
          store().listUnknownAttachmentUids(a, f, v, n);
        expect(await list("acc1", "INBOX", "1", 10)).toEqual([3, 5, 7]);
        expect(await list("acc1", "INBOX", "1", 2)).toEqual([3, 5]);
        expect(await list("acc1", "INBOX", "1", 0)).toEqual([]);
        expect(await list("acc1", "Work", "1", 10)).toEqual([1]);
        expect(await list("acc1", "INBOX", "2", 10)).toEqual([2]);
        expect(await list("acc2", "INBOX", "1", 10)).toEqual([4]);
        expect(await list("acc1", "Nope", "1", 10)).toEqual([]);
      });

      it("stores the files an answer names, in order, with the thread", async () => {
        const key = await put({ dateMs: day(1), threadId: "t", hasAttachments: true }, at(3));
        const set = await store().setAttachments([
          {
            location: at(3),
            attachments: [
              file("2", "b.pdf"),
              file("3", "a.png", { mimeType: "image/png", contentId: "cid1" }),
            ],
          },
        ]);
        expect(set).toEqual([key]);
        expect((await threadFiles("t"))?.get(key)).toEqual({
          known: true,
          items: [
            file("2", "b.pdf"),
            file("3", "a.png", { mimeType: "image/png", contentId: "cid1" }),
          ],
          hasInline: false,
        });
        expect(await store().listUnknownAttachmentUids("acc1", "INBOX", "1", 10)).toEqual([]);
      });

      it("keeps inline parts out of the list but can still find them", async () => {
        const key = await put({ dateMs: day(1), threadId: "t", hasAttachments: true }, at(3));
        await store().setAttachments([
          {
            location: at(3),
            attachments: [file("1.2", "logo.png", { inline: true }), file("2", "real.pdf")],
          },
        ]);
        expect((await threadFiles("t"))?.get(key)?.items.map((a) => a.name)).toEqual(["real.pdf"]);
        expect(await store().getAttachment(key, "1.2")).toMatchObject({
          name: "logo.png",
          inline: true,
        });
      });

      it("gets one file by message key and part id, and nothing for any other", async () => {
        const key = await put({ dateMs: day(1), hasAttachments: true }, at(3));
        await store().setAttachments([{ location: at(3), attachments: [file("2", "a.pdf")] }]);
        expect(await store().getAttachment(key, "2")).toEqual(file("2", "a.pdf"));
        expect(await store().getAttachment(key, "3")).toBeNull();
        expect(await store().getAttachment(key + 1, "2")).toBeNull();
      });

      it("corrects hasAttachments to what the structure says, and announces a flip", async () => {
        const wrong = await put(
          { dateMs: day(1), providerId: "wrong", hasAttachments: true },
          at(1),
        );
        const before = await store().changesSince(0);
        await store().setAttachments([{ location: at(1), attachments: [] }]);
        expect((await store().getByKeys([wrong]))[0]?.hasAttachments).toBe(false);
        expect(await store().listUnknownAttachmentUids("acc1", "INBOX", "1", 10)).toEqual([]);
        const flipped = await store().changesSince(before.changeSeq);
        expect(flipped.changeSeq).toBeGreaterThan(before.changeSeq);
        expect(flipped.changedKeys).toEqual([wrong]);
      });

      it("corrects a message that claimed none but has a file", async () => {
        const missed = await put({ dateMs: day(1), providerId: "missed" }, at(1));
        await store().setAttachments([{ location: at(1), attachments: [file("2", "x.pdf")] }]);
        expect((await store().getByKeys([missed]))[0]?.hasAttachments).toBe(true);
        expect((await store().changesSince(0)).changedKeys).toContain(missed);
      });

      it("says only inline parts are no attachments at all", async () => {
        const logo = await put({ dateMs: day(1), providerId: "logo", hasAttachments: true }, at(1));
        await store().setAttachments([
          { location: at(1), attachments: [file("2", "logo.png", { inline: true })] },
        ]);
        expect((await store().getByKeys([logo]))[0]?.hasAttachments).toBe(false);
      });

      it("stays quiet when a message with none is told it has none", async () => {
        await put({ dateMs: day(1), providerId: "none" }, at(1));
        const before = await store().changesSince(0);
        await store().setAttachments([{ location: at(1), attachments: [] }]);
        const after = await store().changesSince(before.changeSeq);
        expect(after.changeSeq).toBe(before.changeSeq);
        expect(after.changedKeys).toEqual([]);
      });

      it("announces a message that now lists a file even when the flag was right", async () => {
        const key = await put({ dateMs: day(1), hasAttachments: true }, at(1));
        const before = await store().changesSince(0);
        await store().setAttachments([{ location: at(1), attachments: [file("2", "a.pdf")] }]);
        const after = await store().changesSince(before.changeSeq);
        expect(after.changedKeys).toEqual([key]);
      });

      it("replaces the rows of an earlier answer", async () => {
        const key = await put({ dateMs: day(1), threadId: "t", hasAttachments: true }, at(1));
        await store().setAttachments([
          { location: at(1), attachments: [file("2", "a.pdf"), file("3", "b.pdf")] },
        ]);
        await store().setAttachments([{ location: at(1), attachments: [file("2", "a.pdf")] }]);
        expect((await threadFiles("t"))?.get(key)?.items.map((a) => a.partId)).toEqual(["2"]);
        expect(await store().getAttachment(key, "3")).toBeNull();
      });

      it("skips locations it does not have", async () => {
        const key = await put({ dateMs: day(1), hasAttachments: true }, at(1));
        const done = await store().setAttachments([
          { location: at(99), attachments: [file("2", "ghost.pdf")] },
          { location: at(1), attachments: [file("2", "a.pdf")] },
        ]);
        expect(done).toEqual([key]);
        expect(await store().setAttachments([])).toEqual([]);
      });

      it("makes a message that starts to claim files unknown again, and leaves a known one", async () => {
        const m = makeMessage({ dateMs: day(1), threadId: "t" });
        await store().upsertMessages([m]);
        await store().addLocations([{ key: m.key, location: at(1) }]);
        await store().upsertMessages([{ ...m, hasAttachments: true }]);
        expect((await threadFiles("t"))?.get(m.key)?.known).toBe(false);

        await store().setAttachments([{ location: at(1), attachments: [file("2", "a.pdf")] }]);
        await store().upsertMessages([{ ...m, hasAttachments: true, subject: "again" }]);
        expect((await threadFiles("t"))?.get(m.key)).toMatchObject({ known: true });
        expect((await threadFiles("t"))?.get(m.key)?.items).toHaveLength(1);
      });

      it("deletes the files with the message", async () => {
        const key = await put(
          { dateMs: day(1), providerId: "gone", threadId: "t", hasAttachments: true },
          at(1),
        );
        await store().setAttachments([{ location: at(1), attachments: [file("2", "a.pdf")] }]);
        await store().removeByProviderIds("acc1", ["gone"]);
        expect(await store().getAttachment(key, "2")).toBeNull();
        expect(await store().getThread("t")).toBeNull();
      });

      it("deletes the files with the account's messages", async () => {
        const key = await put({ dateMs: day(1), hasAttachments: true }, at(1));
        await store().setAttachments([{ location: at(1), attachments: [file("2", "a.pdf")] }]);
        await store().removeAccountMessages("acc1");
        expect(await store().getAttachment(key, "2")).toBeNull();
      });

      it("reads every message of a thread with its own files", async () => {
        const a = await put(
          { dateMs: day(1), providerId: "a", threadId: "t", hasAttachments: true },
          at(1),
        );
        const b = await put({ dateMs: day(2), providerId: "b", threadId: "t" }, at(2));
        const c = await put(
          { dateMs: day(3), providerId: "c", threadId: "t", hasAttachments: true },
          at(3),
        );
        await store().setAttachments([
          { location: at(1), attachments: [file("2", "one.pdf")] },
          { location: at(3), attachments: [file("2", "two.pdf"), file("3", "three.pdf")] },
        ]);
        const files = await threadFiles("t");
        expect(files?.get(a)?.items.map((x) => x.name)).toEqual(["one.pdf"]);
        expect(files?.get(b)).toEqual({ known: true, items: [], hasInline: false });
        expect(files?.get(c)?.items.map((x) => x.name)).toEqual(["two.pdf", "three.pdf"]);
      });
    });
  });
}

export function describeSearchIndexContract(name: string, factory: Factory<SearchIndexPort>) {
  describe(`SearchIndexPort contract: ${name}`, () => {
    const index = useFixture(factory);

    const zolw = makeDocument(
      {
        dateMs: day(1),
        subject: "Żółw w ogrodzie",
        from: person("Anna", "anna@example.com"),
      },
      "Cześć, zobacz źródło problemu",
    );
    const lodz = makeDocument(
      {
        dateMs: day(2),
        subject: "Spotkanie w Łodzi",
        from: person("Bartek", "bartek@example.com"),
      },
      "Przysłał Jan fakturę za usługi",
    );
    const faktura = makeDocument(
      {
        dateMs: day(3),
        subject: "Faktura marzec",
        from: person("Jan Kowalski", "jan@example.com"),
        hasAttachments: true,
      },
      "Przesłane faktury w załączniku",
    );
    const ascii = makeDocument(
      {
        dateMs: day(4),
        subject: "zolw ascii only",
        from: person("Carla", "carla@example.com"),
      },
      "lodzi zrodlo przyslal",
    );
    const key = (d: { message: { key: number } }) => d.message.key;

    async function seed() {
      await index().indexMessages([faktura, zolw, ascii, lodz]);
    }
    const find = async (q: string, limit = 50, beforeKey?: number) =>
      index().search(parseQuery(q), { limit, ...(beforeKey === undefined ? {} : { beforeKey }) });

    it("removes documents from the index and tolerates unknown keys", async () => {
      await seed();
      expect(await find("zolw")).toEqual([key(ascii), key(zolw)]);
      await index().removeMessages([key(zolw), 999]);
      expect(await find("zolw")).toEqual([key(ascii)]);
      expect(await find("faktura")).toEqual([key(faktura)]);
      await index().removeMessages([]);
    });

    it("indexes a removed key again", async () => {
      await seed();
      await index().removeMessages([key(zolw)]);
      expect(await find("ogrodzie")).toEqual([]);
      await index().indexMessages([zolw]);
      expect(await find("ogrodzie")).toEqual([key(zolw)]);
    });

    it.each([
      ["zolw", [ascii, zolw]],
      ["Żółw", [ascii, zolw]],
      ["lodzi", [ascii, lodz]],
      ["Łodzi", [ascii, lodz]],
      ["zrodlo", [ascii, zolw]],
      ["źródło", [ascii, zolw]],
      ["przyslal", [ascii, lodz]],
      ["przysłał", [ascii, lodz]],
    ])("folds Polish text both ways: %s", async (q, expected) => {
      await seed();
      expect(await find(q)).toEqual(expected.map(key));
    });

    it("returns newest first", async () => {
      await seed();
      expect(await find("faktur")).toEqual([key(faktura), key(lodz)]);
    });

    it("matches prefixes of words, not infixes", async () => {
      await seed();
      expect(await find("fakt")).toEqual([key(faktura), key(lodz)]);
      expect(await find("aktur")).toEqual([]);
    });

    it("requires every term", async () => {
      await seed();
      expect(await find("faktura marzec")).toEqual([key(faktura)]);
      expect(await find("faktura ogrodzie")).toEqual([]);
    });

    it("matches phrases as consecutive whole words", async () => {
      await seed();
      expect(await find('"przesłane faktury"')).toEqual([key(faktura)]);
      expect(await find('"faktury przesłane"')).toEqual([]);
      expect(await find('"przesłane faktur"')).toEqual([]);
    });

    it("filters by sender with from:", async () => {
      await seed();
      expect(await find("from:kowalski")).toEqual([key(faktura)]);
      // "Jan" appears in a body, but from: looks at the sender only.
      expect(await find("from:jan")).toEqual([key(faktura)]);
      expect(await find("from:anna@example.com")).toEqual([key(zolw)]);
    });

    it("filters by subject with subject:", async () => {
      await seed();
      expect(await find("subject:łodzi")).toEqual([key(lodz)]);
    });

    it("filters by attachment and by date", async () => {
      await seed();
      expect(await find("has:attachment")).toEqual([key(faktura)]);
      // Days are local (ADR 0025): name the local day the fixture falls on.
      const d3 = localDay(day(3));
      expect(await find(`after:${d3}`)).toEqual([key(ascii), key(faktura)]);
      expect(await find(`before:${d3}`)).toEqual([key(lodz), key(zolw)]);
      expect(await find(`faktur after:${d3}`)).toEqual([key(faktura)]);
    });

    describe("query language (ADR 0025)", () => {
      const accounts = [
        { id: "acc1", address: "me@example.com", displayName: "Me" },
        { id: "acc2", address: "work@acme.org", displayName: "Acme Work" },
      ];
      const findIn = (q: string, ctx = { accounts }) =>
        index().search(parseQuery(q, ctx), { limit: 50 });
      const chunked = async (q: string, limit: number): Promise<number[]> => {
        const out: number[] = [];
        let beforeKey: number | undefined;
        for (let i = 0; i < 1000; i++) {
          const chunk = await index().searchChunk(parseQuery(q, { accounts }), {
            limit,
            ...(beforeKey === undefined ? {} : { beforeKey }),
          });
          expect(chunk.keys.length).toBeLessThanOrEqual(limit);
          out.push(...chunk.keys);
          if (chunk.nextBeforeKey === undefined) return out;
          beforeKey = chunk.nextBeforeKey;
        }
        throw new Error("chunks never ended");
      };

      it("says which of the given keys match, whatever else matches around them", async () => {
        await index().indexMessages([faktura, zolw, ascii, lodz]);
        const among = (q: string, keys: readonly number[]) =>
          index().matchesAmong(parseQuery(q, { accounts }), keys);
        expect(await among("faktur", [key(faktura), key(zolw)])).toEqual([key(faktura)]);
        expect(await among("faktur", [key(zolw)])).toEqual([]);
        expect(await among("-faktur", [key(faktura), key(zolw)])).toEqual([key(zolw)]);
        expect(await among("from:kowalski OR ogrodzie", [])).toEqual([]);
        expect(await among("from:", [key(faktura)])).toEqual([]);
        // Newest first, as every search answers.
        const both = [key(faktura), key(lodz)].sort((a, b) => a - b);
        expect(await among("faktur", both)).toEqual(await find("faktur"));
      });

      it("supports OR, NOT, brackets and cc", async () => {
        const withCc = makeDocument(
          {
            dateMs: day(5),
            subject: "kopia dla zespołu",
            cc: [person("Dorota", "dorota@example.com")],
          },
          "nic ciekawego",
        );
        await index().indexMessages([faktura, zolw, ascii, lodz, withCc]);
        expect(await find("ogrodzie OR marzec")).toEqual([key(faktura), key(zolw)]);
        expect(await find("ogrodzie OR marzec -kowalski")).toEqual([key(zolw)]);
        expect(await find("faktur -marzec")).toEqual([key(lodz)]);
        expect(await find("-faktur")).toEqual([key(withCc), key(ascii), key(zolw)]);
        expect(await find("-(zolw OR lodzi OR kopia)")).toEqual([key(faktura)]);
        expect(await find("(ogrodzie OR marzec) (anna OR jan)")).toEqual([key(faktura), key(zolw)]);
        expect(await find("ogrodzie OR marzec carla")).toEqual([key(zolw)]);
        expect(await find("from:(anna OR carla)")).toEqual([key(ascii), key(zolw)]);
        expect(await find("cc:dorota")).toEqual([key(withCc)]);
        expect(await find("to:dorota")).toEqual([]);
        expect(await find("dorota")).toEqual([key(withCc)]);
        expect(await find("-cc:dorota subject:zolw")).toEqual([key(ascii), key(zolw)]);
        expect(await find("has:attachment OR ogrodzie")).toEqual([key(faktura), key(zolw)]);
        expect(await find("-has:attachment")).toEqual([
          key(withCc),
          key(ascii),
          key(lodz),
          key(zolw),
        ]);
        expect(await find("ogrodzie -(has:attachment OR marzec)")).toEqual([key(zolw)]);
        expect(await find("or")).toEqual([]);
      });

      it("filters by flag", async () => {
        const read = makeDocument({
          dateMs: day(1),
          subject: "tag one",
          flags: flags({ seen: true }),
        });
        const unread = makeDocument({ dateMs: day(2), subject: "tag two" });
        const starred = makeDocument({
          dateMs: day(3),
          subject: "tag three",
          flags: flags({ seen: true, flagged: true }),
        });
        const replied = makeDocument({
          dateMs: day(4),
          subject: "tag four",
          flags: flags({ answered: true }),
        });
        const draft = makeDocument({
          dateMs: day(5),
          subject: "tag five",
          flags: flags({ seen: true, draft: true }),
        });
        await index().indexMessages([read, unread, starred, replied, draft]);
        expect(await find("is:unread")).toEqual([key(replied), key(unread)]);
        expect(await find("is:read")).toEqual([key(draft), key(starred), key(read)]);
        expect(await find("is:starred")).toEqual([key(starred)]);
        expect(await find("is:replied")).toEqual([key(replied)]);
        expect(await find("is:draft")).toEqual([key(draft)]);
        expect(await find("tag is:unread")).toEqual([key(replied), key(unread)]);
        expect(await find("tag two is:unread")).toEqual([key(unread)]);
        expect(await find("tag -is:read")).toEqual([key(replied), key(unread)]);
        expect(await find("tag is:starred OR is:draft")).toEqual([key(draft), key(starred)]);
        expect(await find("tag is:starred is:read")).toEqual([key(starred)]);
        expect(await find("tag is:unread is:starred")).toEqual([]);
        expect(await find("-tag is:unread")).toEqual([]);
        expect(await find("-three is:read")).toEqual([key(draft), key(read)]);
        expect(await find("is:un")).toEqual([]);
      });

      it("filters by account and from:me", async () => {
        const mine = makeDocument({ dateMs: day(1), subject: "own note", accountId: "acc1" });
        const work = makeDocument({
          dateMs: day(2),
          subject: "work note",
          accountId: "acc2",
          from: person("Me at work", "work@acme.org"),
        });
        const sent = makeDocument(
          {
            dateMs: day(3),
            subject: "sent note",
            accountId: "acc1",
            from: person("Me", "me@example.com"),
            to: [person("Boss", "boss@acme.org")],
          },
          "",
        );
        await index().indexMessages([mine, work, sent]);
        expect(await findIn("note account:acme")).toEqual([key(work)]);
        expect(await findIn("note account:me")).toEqual([key(sent), key(mine)]);
        expect(await findIn("note account:(acme OR example)")).toEqual([
          key(sent),
          key(work),
          key(mine),
        ]);
        expect(await findIn("note -account:acme")).toEqual([key(sent), key(mine)]);
        expect(await findIn("account:nothing")).toEqual([]);
        expect(await findIn("account:acme")).toEqual([key(work)]);
        expect(await findIn("from:me")).toEqual([key(sent), key(work)]);
        expect(await findIn("note from:me to:boss")).toEqual([key(sent)]);
        expect(await findIn("note -from:me")).toEqual([key(mine)]);
        expect(await findIn("from:me", { accounts: [] })).toEqual([]);
        expect(await findIn("note -from:me", { accounts: [] })).toEqual([
          key(sent),
          key(work),
          key(mine),
        ]);
      });

      it("bounds dates by the key, on local days", async () => {
        const at = (y: number, m: number, d: number, h: number) => new Date(y, m, d, h).getTime();
        const early = makeDocument({ dateMs: at(2024, 4, 9, 23), subject: "dated early" });
        const edge = makeDocument({ dateMs: at(2024, 4, 10, 0), subject: "dated edge" });
        const late = makeDocument({ dateMs: at(2024, 4, 10, 23), subject: "dated late" });
        const next = makeDocument({ dateMs: at(2024, 4, 11, 0), subject: "dated next" });
        await index().indexMessages([early, edge, late, next]);
        expect(await find("dated after:2024-05-10")).toEqual([key(next), key(late), key(edge)]);
        expect(await find("dated before:2024-05-11")).toEqual([key(late), key(edge), key(early)]);
        expect(await find("dated after:2024-05-10 before:2024-05-11")).toEqual([
          key(late),
          key(edge),
        ]);
        expect(await find("after:2024-05-10 before:2024-05-11")).toEqual([key(late), key(edge)]);
        expect(await find("dated (after:2024-05-11 OR before:2024-05-10)")).toEqual([
          key(next),
          key(early),
        ]);
        expect(await find("dated -after:2024-05-10")).toEqual([key(early)]);
        expect(await find("dated after:2024-05-11 before:2024-05-10")).toEqual([]);
        expect(await find("dated after:2024-05")).toEqual([
          key(next),
          key(late),
          key(edge),
          key(early),
        ]);
        expect(await find("dated after:2024-13-45")).toEqual([
          key(next),
          key(late),
          key(edge),
          key(early),
        ]);
      });

      it("dates by the key, not by the message's own date", async () => {
        const moved = makeDocument({ dateMs: day(2), subject: "moved note" });
        const message = { ...moved.message, dateMs: day(20) };
        await index().indexMessages([{ message, bodyText: "" }]);
        const d10 = localDay(day(10));
        expect(await find(`moved before:${d10}`)).toEqual([key(moved)]);
        expect(await find(`moved after:${d10}`)).toEqual([]);
      });

      it("returns each message once however many labels match", async () => {
        const twice = makeDocument({
          dateMs: day(1),
          subject: "twice",
          labelIds: ["Inbox", "INBOX", "work"],
        });
        const once = makeDocument({ dateMs: day(2), subject: "once", labelIds: ["inbox"] });
        await index().indexMessages([twice, once]);
        expect(await find("label:inbox")).toEqual([key(once), key(twice)]);
        expect(await find("twice label:inbox")).toEqual([key(twice)]);
        expect(await find("label:inbox OR label:work")).toEqual([key(once), key(twice)]);
        expect(await find("-label:work label:inbox")).toEqual([key(once)]);
        expect(await find("label:(work OR inbox)")).toEqual([key(once), key(twice)]);
      });

      it("yields through chunks exactly what search yields", async () => {
        const docs = Array.from({ length: 40 }, (_, i) =>
          makeDocument({
            dateMs: day(1) + i * 36 * 3_600_000,
            subject: i % 3 === 0 ? `alpha beta ${i}` : `alpha gamma ${i}`,
            labelIds: i % 5 === 0 ? ["inbox", "rare"] : ["inbox"],
            flags: flags({ seen: i % 2 === 0, flagged: i % 7 === 0 }),
            hasAttachments: i % 4 === 0,
          }),
        );
        await index().indexMessages(docs);
        for (const q of [
          "alpha",
          "alpha OR beta",
          "alpha -beta",
          "-beta",
          "label:rare",
          "alpha label:rare",
          "is:unread",
          "alpha is:starred",
          "alpha OR is:starred",
          "-alpha OR is:starred",
          "has:attachment -is:read",
          "alpha after:2024-03-10",
        ]) {
          const all = await index().search(parseQuery(q, { accounts }), { limit: 500 });
          for (const limit of [1, 3, 7, 500]) {
            expect(await chunked(q, limit), `${q} / ${limit}`).toEqual(all);
          }
        }
      });
    });

    it("replaces the document when a key is indexed again", async () => {
      const doc = makeDocument({ dateMs: day(1), subject: "stary temat" });
      await index().indexMessages([doc]);
      expect(await find("stary")).toEqual([key(doc)]);
      const message = { ...doc.message, subject: "nowy temat" };
      await index().indexMessages([{ message, bodyText: "" }]);
      expect(await find("stary")).toEqual([]);
      expect(await find("nowy")).toEqual([key(doc)]);
    });

    it("limits and paginates with beforeKey", async () => {
      const docs = Array.from({ length: 25 }, (_, i) =>
        makeDocument({ dateMs: day(1) + i * 1000, subject: `alpha report ${i}` }),
      );
      await index().indexMessages(docs);
      const expected = docs.map(key).sort((a, b) => b - a);

      const p1 = await find("alpha", 10);
      expect(p1).toEqual(expected.slice(0, 10));
      const p2 = await find("alpha", 10, p1[p1.length - 1]);
      expect(p2).toEqual(expected.slice(10, 20));
      const p3 = await find("alpha", 10, p2[p2.length - 1]);
      expect(p3).toEqual(expected.slice(20));
      expect(await find("alpha", 10, p3[p3.length - 1])).toEqual([]);
    });

    it("returns nothing for an empty query", async () => {
      await seed();
      expect(await find("")).toEqual([]);
    });

    const hostile = [
      '"unbalanced',
      'foo" bar',
      '"',
      "NEAR(a b, 2)",
      "a NEAR/3 b",
      "a AND b OR c NOT d",
      "NOT",
      "-faktura",
      "faktur*",
      "*",
      "^faktura",
      "(((",
      "))) (a OR b)",
      ":::",
      "from:",
      "a:b:c:d",
      'subject:"',
      "label:",
      "{}[]\\/",
      "'; DROP TABLE messages;--",
      "x".repeat(10_000),
    ];

    it.each(hostile.map((h) => [h.slice(0, 24), h]))(
      "never throws on hostile input %j",
      async (_name, input) => {
        await seed();
        const keys = await find(input as string);
        expect(Array.isArray(keys)).toBe(true);
        for (const k of keys) expect(Number.isSafeInteger(k)).toBe(true);
      },
    );

    it("does not treat operators as syntax", async () => {
      await seed();
      // Same results as the plain word, whatever the engine thinks "-" or "*" mean.
      const plain = await find("faktura");
      expect(await find("faktura*")).toEqual(plain);
      expect(await find("^faktura")).toEqual(plain);
      expect(await find("(faktura)")).toEqual(plain);
    });
  });
}

export function describeMessageBodyContract(name: string, factory: Factory<MessageBodyPort>) {
  describe(`MessageBodyPort contract: ${name}`, () => {
    const bodies = useFixture(factory);
    const put = (key: number, threadId: string, text: string) => ({ key, threadId, text });

    it("round-trips bodies by key", async () => {
      await bodies().putBodies([put(1, "t1", "first"), put(2, "t2", "second")]);
      const got = await bodies().getBodies([2, 1]);
      expect(got.get(1)).toBe("first");
      expect(got.get(2)).toBe("second");
      expect(got.size).toBe(2);
    });

    it("leaves missing keys out of the result", async () => {
      await bodies().putBodies([put(1, "t1", "first")]);
      const got = await bodies().getBodies([1, 404]);
      expect(got.has(404)).toBe(false);
      expect(got.get(1)).toBe("first");
      expect((await bodies().getBodies([])).size).toBe(0);
    });

    it("tells an empty body from a missing one", async () => {
      await bodies().putBodies([put(1, "t1", "")]);
      const got = await bodies().getBodies([1, 2]);
      expect(got.get(1)).toBe("");
      expect(got.has(2)).toBe(false);
    });

    it("overwrites the body of a key and keeps its neighbours", async () => {
      await bodies().putBodies([put(1, "t1", "a"), put(2, "t1", "b")]);
      await bodies().putBodies([put(2, "t1", "b2")]);
      const got = await bodies().getBodies([1, 2]);
      expect(got.get(1)).toBe("a");
      expect(got.get(2)).toBe("b2");
    });

    it("keeps earlier messages when a thread grows, across batches", async () => {
      await bodies().putBodies([put(1, "t1", "one"), put(2, "t1", "two")]);
      await bodies().putBodies([put(3, "t1", "three")]);
      await bodies().putBodies([put(4, "t2", "other thread")]);
      const got = await bodies().getBodies([1, 2, 3, 4]);
      expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [1, "one"],
        [2, "two"],
        [3, "three"],
        [4, "other thread"],
      ]);
    });

    it("handles many messages in one thread, including a very long one", async () => {
      const batch = Array.from({ length: 300 }, (_, i) =>
        put(
          i + 1,
          "long",
          `message ${i}\n${"akapit tekstu, który się powtarza. ".repeat(40 + (i % 7))}`,
        ),
      );
      batch.push(put(1000, "long", `${"x".repeat(600_000)}`));
      for (let i = 0; i < batch.length; i += 50) await bodies().putBodies(batch.slice(i, i + 50));
      const got = await bodies().getBodies(batch.map((b) => b.key));
      expect(got.size).toBe(batch.length);
      for (const b of batch) expect(got.get(b.key)).toBe(b.text);
    });

    it("keeps a message's HTML apart from its text, and removes both", async () => {
      await bodies().putBodies([
        { key: 1, threadId: "t1", text: "one", html: "<p>żółć</p>", htmlKind: "designed" },
        { key: 2, threadId: "t1", text: "two", html: "<b>two</b>", htmlKind: "simple" },
        put(3, "t1", "three"),
      ]);
      expect((await bodies().getBodies([1])).get(1)).toBe("one");
      expect(await bodies().getHtml(1)).toBe("<p>żółć</p>");
      expect(await bodies().getHtml(3)).toBeUndefined();
      const kinds = await bodies().getHtmlKinds([1, 2, 3, 404]);
      expect([...kinds].sort(([a], [b]) => a - b)).toEqual([
        [1, "designed"],
        [2, "simple"],
      ]);

      await bodies().removeBodies([1]);
      expect(await bodies().getHtml(1)).toBeUndefined();
      expect((await bodies().getHtmlKinds([1])).size).toBe(0);
      expect(await bodies().getHtml(2)).toBe("<b>two</b>");
    });

    it("removes a whole thread at once, and part of one that stays readable", async () => {
      await bodies().putBodies([
        put(1, "t1", "one"),
        put(2, "t1", "two"),
        put(3, "t2", "zażółć"),
        put(4, "t2", "four"),
      ]);
      await bodies().removeBodies([1, 2, 4]);
      const got = await bodies().getBodies([1, 2, 3, 4]);
      expect([...got]).toEqual([[3, "zażółć"]]);
      await bodies().putBodies([put(5, "t1", "after")]);
      expect((await bodies().getBodies([5])).get(5)).toBe("after");
    });

    it("removes bodies, keeps neighbours and tolerates unknown keys", async () => {
      await bodies().putBodies([put(1, "t1", "one"), put(2, "t1", "two"), put(3, "t2", "three")]);
      await bodies().removeBodies([2, 3, 404]);
      const got = await bodies().getBodies([1, 2, 3]);
      expect([...got.entries()]).toEqual([[1, "one"]]);
      await bodies().removeBodies([]);
    });

    it("keeps a thread usable after removals: grows, replaces and empties", async () => {
      await bodies().putBodies([put(1, "t1", "one"), put(2, "t1", "two")]);
      await bodies().removeBodies([1]);
      await bodies().putBodies([put(3, "t1", "three")]);
      await bodies().putBodies([put(2, "t1", "two again")]);
      const got = await bodies().getBodies([1, 2, 3]);
      expect([...got.entries()].sort((a, b) => a[0] - b[0])).toEqual([
        [2, "two again"],
        [3, "three"],
      ]);
      await bodies().removeBodies([2, 3]);
      expect((await bodies().getBodies([2, 3])).size).toBe(0);
      await bodies().putBodies([put(4, "t1", "fresh")]);
      expect((await bodies().getBodies([4])).get(4)).toBe("fresh");
    });

    it("returns Polish text unchanged", async () => {
      const text = [
        "Zażółć gęślą jaźń. ŁÓDŹ, Żółć, Świętokrzyskie.",
        "> cytat z poprzedniej wiadomości",
        "",
        "-- ",
        "Miłosz\r\ntab\tzero\u200bwidth, emoji 🙂, NFD: a\u0328 e\u0328",
      ].join("\n");
      await bodies().putBodies([put(1, "t1", text)]);
      expect((await bodies().getBodies([1])).get(1)).toBe(text);
    });
  });
}

/** Ports under test plus the view a reader (the UI) has of committed data. */
export interface UnitOfWorkHarness {
  readonly uow: UnitOfWorkPort;
  readonly store: MessageStorePort;
  readonly index: SearchIndexPort;
  readonly bodies: MessageBodyPort;
  readonly cursors: CursorPort;
  readonly flagOps: FlagOutboxPort;
  readonly moveOps: MoveOutboxPort;
  /** Where committed data is read back; the same ports for adapters without a reader. */
  readonly read: {
    readonly store: Pick<
      MessageStorePort,
      "getByKeys" | "getThread" | "listNewest" | "listLabels" | "changesSince"
    >;
    readonly index: Pick<SearchIndexPort, "search">;
    readonly bodies: Pick<MessageBodyPort, "getBodies">;
  };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

export function describeUnitOfWorkContract(name: string, factory: Factory<UnitOfWorkHarness>) {
  describe(`UnitOfWorkPort contract: ${name}`, () => {
    const h = useFixture(factory);
    const ACC = "acc1";
    const FOLDER = "INBOX";
    const find = (q: string) => h().read.index.search(parseQuery(q), { limit: 50 });

    const doc = (n: number, text: string, extra: Parameters<typeof makeDocument>[0] = {}) =>
      makeDocument({ dateMs: day(n), subject: `unit ${text}`, ...extra }, `body ${text}`);

    /** Everything a reader can see: must be identical before and after a rolled-back unit. */
    async function observe() {
      const { read, cursors } = h();
      const listed = await read.store.listNewest({ limit: 100 });
      const keys = listed.map((m) => m.key);
      const bodies = [...(await read.bodies.getBodies(keys)).entries()].sort((a, b) => a[0] - b[0]);
      return {
        listed,
        bodies,
        changes: await read.store.changesSince(0),
        hits: await find("unit"),
        bodyHits: await find("body"),
        cursor: await cursors.get(ACC, FOLDER),
      };
    }

    const batch = (
      documents: readonly SyncedDocument[],
      cursor: SyncBatch["cursor"],
      removedUids: readonly number[] = [],
    ): SyncBatch =>
      makeSyncBatch({
        documents,
        cursor,
        removedLocations: removedUids.map((uid) => makeLocation(uid, FOLDER)),
      });

    it("makes every write visible after commit and returns the result of work", async () => {
      const d = doc(1, "alpha");
      const result = await h().uow.run(async () => {
        const r = await ingestDocuments(h(), [d]);
        await h().cursors.set(ACC, FOLDER, { uid: 1 });
        return r.keys;
      });
      expect(result).toEqual([d.message.key]);
      const seen = await observe();
      expect(seen.listed.map((m) => m.key)).toEqual([d.message.key]);
      expect(seen.bodies).toEqual([[d.message.key, "body alpha"]]);
      expect(seen.hits).toEqual([d.message.key]);
      expect(seen.cursor).toEqual({ uid: 1 });
    });

    it("rolls back store, index, bodies and cursor when work throws, and rethrows", async () => {
      const before = doc(1, "before");
      await applySyncBatch(h(), {
        accountId: ACC,
        folderId: FOLDER,
        batch: batch([syncedDoc(before, 1)], { uid: 1 }),
      });
      const snapshot = await observe();

      const boom = new Error("boom");
      await expect(
        h().uow.run(async () => {
          await ingestDocuments(h(), [doc(2, "after"), { ...before, bodyText: "body changed" }]);
          await h().store.removeByProviderIds(ACC, [before.message.providerId]);
          await h().cursors.set(ACC, FOLDER, { uid: 99 });
          throw boom;
        }),
      ).rejects.toBe(boom);

      expect(await observe()).toEqual(snapshot);
    });

    it("keeps working after a rollback", async () => {
      await expect(
        h().uow.run(async () => {
          await ingestDocuments(h(), [doc(1, "lost")]);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      const kept = doc(2, "kept");
      await ingestDocuments(h(), [kept]);
      expect((await observe()).hits).toEqual([kept.message.key]);
    });

    it("serializes concurrent units", async () => {
      const events: string[] = [];
      const unit = (label: string, fail = false) =>
        h().uow.run(async () => {
          events.push(`${label}:start`);
          await ingestDocuments(h(), [doc(label.charCodeAt(0) - 96, label)]);
          await tick();
          await tick();
          events.push(`${label}:end`);
          if (fail) throw new Error(label);
        });

      const results = await Promise.allSettled([unit("a", true), unit("b"), unit("c")]);
      expect(events).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
      expect(results.map((r) => r.status)).toEqual(["rejected", "fulfilled", "fulfilled"]);
      // The failed first unit left nothing behind for the others to commit by accident.
      const subjects = (await h().read.store.listNewest({ limit: 10 })).map((m) => m.subject);
      expect(subjects.sort()).toEqual(["unit b", "unit c"]);
    });

    it("joins a nested run to the outer unit", async () => {
      const d1 = doc(1, "outer");
      const d2 = doc(2, "inner");
      const value = await h().uow.run(async () => {
        await ingestDocuments(h(), [d1]);
        // ingestDocuments runs its own unit: a nested run that must not wait for the outer.
        const inner = await h().uow.run(async () => {
          await ingestDocuments(h(), [d2]);
          await tick();
          return 42;
        });
        return inner;
      });
      expect(value).toBe(42);
      expect([...(await observe()).hits].sort()).toEqual([d1.message.key, d2.message.key].sort());

      const before = await observe();
      await expect(
        h().uow.run(async () => {
          await h().uow.run(() => ingestDocuments(h(), [doc(3, "nested lost")]));
          throw new Error("outer fails");
        }),
      ).rejects.toThrow("outer fails");
      expect(await observe()).toEqual(before);
    });

    describe("applySyncBatch", () => {
      const d1 = doc(1, "one", { providerId: "uid-1", threadId: "t1" });
      const d2 = doc(2, "two", { providerId: "uid-2", threadId: "t1" });
      const d3 = doc(3, "three", { providerId: "uid-3", threadId: "t3" });

      async function firstBatch() {
        await applySyncBatch(h(), {
          accountId: ACC,
          folderId: FOLDER,
          batch: batch([syncedDoc(d1, 1), syncedDoc(d2, 2)], { uid: 2 }),
        });
      }

      it("persists nothing and keeps the old cursor when putBodies fails", async () => {
        await firstBatch();
        const snapshot = await observe();
        const bodies = Object.create(h().bodies, {
          putBodies: {
            value: async () => {
              throw new Error("bodies down");
            },
          },
        }) as MessageBodyPort;
        await expect(
          applySyncBatch(
            { ...h(), bodies },
            {
              accountId: ACC,
              folderId: FOLDER,
              batch: batch([syncedDoc(d3, 3)], { uid: 3 }, [1]),
            },
          ),
        ).rejects.toThrow("bodies down");
        expect(await observe()).toEqual(snapshot);
        expect(snapshot.cursor).toEqual({ uid: 2 });
      });

      it("persists nothing and keeps the old cursor when cursors.set fails", async () => {
        await firstBatch();
        const snapshot = await observe();
        const cursors = Object.create(h().cursors, {
          set: {
            value: async () => {
              throw new Error("cursor down");
            },
          },
        }) as CursorPort;
        await expect(
          applySyncBatch(
            { ...h(), cursors },
            {
              accountId: ACC,
              folderId: FOLDER,
              batch: batch([syncedDoc(d3, 3)], { uid: 3 }, [1]),
            },
          ),
        ).rejects.toThrow("cursor down");
        expect(await observe()).toEqual(snapshot);
      });

      it("applies removals to store, index and bodies and advances the cursor", async () => {
        await firstBatch();
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        const result = await applySyncBatch(h(), {
          accountId: ACC,
          folderId: FOLDER,
          batch: batch([syncedDoc(d3, 3)], { uid: 3 }, [1, 99]),
        });
        expect(result.removedKeys).toEqual([d1.message.key]);
        expect(result.upserted.keys).toEqual([d3.message.key]);

        const seen = await observe();
        expect(seen.listed.map((m) => m.key).sort()).toEqual(
          [d2.message.key, d3.message.key].sort(),
        );
        expect([...seen.hits].sort()).toEqual([d2.message.key, d3.message.key].sort());
        expect(seen.bodies.map(([k]) => k).sort()).toEqual([d2.message.key, d3.message.key].sort());
        expect(seen.cursor).toEqual({ uid: 3 });
        expect(await find("one")).toEqual([]);

        const changes = await h().read.store.changesSince(seq);
        expect(changes.changedKeys).toEqual([d3.message.key]);
        expect(changes.removedKeys).toEqual([d1.message.key]);
      });

      it("is idempotent when the same batch is applied again", async () => {
        const input = {
          accountId: ACC,
          folderId: FOLDER,
          batch: batch([syncedDoc(d3, 3)], { uid: 3 }, [1]),
        };
        await firstBatch();
        await applySyncBatch(h(), input);
        const once = await observe();
        await applySyncBatch(h(), input);
        const twice = await observe();

        expect(twice.listed).toEqual(once.listed);
        expect(twice.bodies).toEqual(once.bodies);
        expect(twice.hits).toEqual(once.hits);
        expect(twice.bodyHits).toEqual(once.bodyHits);
        expect(twice.cursor).toEqual({ uid: 3 });
        expect(twice.changes.removedKeys).toEqual([d1.message.key]);
      });

      it("stores a batch with only a cursor move", async () => {
        await firstBatch();
        const before = await observe();
        await applySyncBatch(h(), {
          accountId: ACC,
          folderId: FOLDER,
          batch: batch([], { uid: 2, note: "idle" }),
        });
        const after = await observe();
        expect(after.listed).toEqual(before.listed);
        expect(after.cursor).toEqual({ uid: 2, note: "idle" });
      });
    });
  });
}

/** ADR 0016 scenarios through `applySyncBatch`: the whole write path, on any adapter. */
export function describeSyncBatchContract(name: string, factory: Factory<UnitOfWorkHarness>) {
  describe(`SyncBatch locations contract: ${name}`, () => {
    const h = useFixture(factory);
    const ACC = "acc1";
    const find = (q: string) => h().read.index.search(parseQuery(q), { limit: 50 });
    const apply = (
      folderId: string,
      batch: Partial<SyncBatch>,
      labelSource?: "provider" | "locations",
    ) =>
      applySyncBatch(h(), {
        accountId: ACC,
        folderId,
        batch: makeSyncBatch(batch),
        ...(labelSource ? { labelSource } : {}),
      });
    const doc = (n: number, text: string, extra: Parameters<typeof makeDocument>[0] = {}) =>
      makeDocument({ dateMs: day(n), subject: `loc ${text}`, ...extra }, `body ${text}`);
    const message = async (providerId: string) => {
      const key = (await h().store.findByProviderIds(ACC, [providerId])).get(providerId);
      const [m] = key === undefined ? [] : await h().read.store.getByKeys([key]);
      return m;
    };

    it("gives new messages distinct keys even when their documents carry the same key", async () => {
      const a = doc(1, "alpha", { providerId: "a", seq: 0 });
      const b = doc(1, "beta", { providerId: "b", seq: 0 });
      expect(a.message.key).toBe(b.message.key);
      await apply("INBOX", { documents: [syncedDoc(a, 1), syncedDoc(b, 2)] });
      const keys = (await h().read.store.listNewest({ limit: 10 })).map((m) => m.key);
      expect(new Set(keys).size).toBe(2);
    });

    it("keeps the key, body and index entry when a message moves to another folder", async () => {
      const d = doc(1, "mover", { providerId: "mv" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      const before = await message("mv");

      // Additions first, the removal later: the order syncAccount guarantees.
      await apply("Archive", {
        knownLocations: [
          { providerId: "mv", location: makeLocation(10, "Archive", "5"), flags: d.message.flags },
        ],
        cursor: { uid: 10 },
      });
      await apply("INBOX", { removedLocations: [makeLocation(1)], cursor: { uid: 1, n: 2 } });

      const after = await message("mv");
      expect(after?.key).toBe(before?.key);
      expect(after?.labelIds).toEqual(["Archive"]);
      expect(await h().store.getLocations(before?.key as number)).toEqual([
        makeLocation(10, "Archive", "5"),
      ]);
      expect(await find("mover")).toEqual([before?.key]);
      expect(
        (await h().read.bodies.getBodies([before?.key as number])).get(before?.key as number),
      ).toBe("body mover");
      expect((await h().read.store.listNewest({ limit: 10 })).length).toBe(1);
    });

    it("adds a location for a copy and labels the message with both folders", async () => {
      const d = doc(1, "copy", { providerId: "cp" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)] });
      await apply("Work", {
        knownLocations: [
          { providerId: "cp", location: makeLocation(4, "Work"), flags: d.message.flags },
        ],
      });
      const m = await message("cp");
      expect(m?.labelIds).toEqual(["INBOX", "Work"]);
      expect(await h().store.getLocations(m?.key as number)).toEqual([
        makeLocation(1),
        makeLocation(4, "Work"),
      ]);
      expect((await h().read.store.listNewest({ labelId: "Work", limit: 10 })).length).toBe(1);

      await apply("Work", { removedLocations: [makeLocation(4, "Work")] });
      expect((await message("cp"))?.labelIds).toEqual(["INBOX"]);
    });

    it("deletes store, index and body when the last location is gone, not before", async () => {
      const d = doc(1, "doomed", { providerId: "dm" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)] });
      await apply("Work", {
        knownLocations: [
          { providerId: "dm", location: makeLocation(4, "Work"), flags: d.message.flags },
        ],
      });
      const key = (await message("dm"))?.key as number;

      await apply("INBOX", { removedLocations: [makeLocation(1)] });
      expect(await message("dm")).toBeDefined();
      expect(await find("doomed")).toEqual([key]);

      const seq = (await h().read.store.changesSince(0)).changeSeq;
      const result = await apply("Work", { removedLocations: [makeLocation(4, "Work")] });
      expect(result.removedKeys).toEqual([key]);
      expect(await message("dm")).toBeUndefined();
      expect(await find("doomed")).toEqual([]);
      expect((await h().read.bodies.getBodies([key])).size).toBe(0);
      expect((await h().read.store.changesSince(seq)).removedKeys).toEqual([key]);
    });

    it("resets a folder: other epochs go, announced messages keep their keys, the rest is deleted", async () => {
      const d1 = doc(1, "stays", { providerId: "s1" });
      const d2 = doc(2, "vanishes", { providerId: "s2" });
      const d3 = doc(3, "elsewhere", { providerId: "s3" });
      await apply("INBOX", {
        documents: [syncedDoc(d1, 1, "INBOX", "1"), syncedDoc(d2, 2, "INBOX", "1")],
      });
      await apply("Work", {
        knownLocations: [
          { providerId: "s2", location: makeLocation(8, "Work"), flags: d2.message.flags },
        ],
      });
      await apply("INBOX", { documents: [syncedDoc(d3, 3, "INBOX", "1")] });
      const keys = {
        s1: (await message("s1"))?.key,
        s2: (await message("s2"))?.key,
        s3: (await message("s3"))?.key,
      };

      const result = await apply("INBOX", {
        resetFolder: true,
        documents: [syncedDoc(d1, 11, "INBOX", "2")],
        cursor: { uidValidity: "2" },
      });

      expect(result.removedKeys).toEqual([keys.s3]);
      expect((await message("s1"))?.key).toBe(keys.s1);
      expect((await message("s2"))?.key).toBe(keys.s2);
      expect(await message("s3")).toBeUndefined();
      expect(await find("elsewhere")).toEqual([]);
      expect(await h().store.listLocationUids(ACC, "INBOX", "1")).toEqual([]);
      expect(await h().store.listLocationUids(ACC, "INBOX", "2")).toEqual([11]);
      expect((await message("s2"))?.labelIds).toEqual(["Work"]);
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uidValidity: "2" });
    });

    it("updates flags without a document and leaves index and body alone", async () => {
      const d = doc(1, "flagged", { providerId: "fl" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)] });
      const key = (await message("fl"))?.key as number;
      const seq = (await h().read.store.changesSince(0)).changeSeq;

      const result = await apply("INBOX", {
        flagUpdates: [{ location: makeLocation(1), flags: { ...d.message.flags, seen: true } }],
        cursor: { uid: 1, modseq: "9" },
      });
      expect(result.flagsUpdated).toBe(1);
      expect((await message("fl"))?.flags.seen).toBe(true);
      expect((await h().read.store.changesSince(seq)).changedKeys).toEqual([key]);
      expect(await find("flagged")).toEqual([key]);
      expect((await h().read.bodies.getBodies([key])).get(key)).toBe("body flagged");
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uid: 1, modseq: "9" });
    });

    it("keeps provider labels from the document when labels do not come from locations", async () => {
      const d = doc(1, "gmail", { providerId: "gm:1", labelIds: ["inbox", "starred"] });
      await apply("All Mail", { documents: [syncedDoc(d, 1, "All Mail")] }, "provider");
      expect((await message("gm:1"))?.labelIds).toEqual(["inbox", "starred"]);

      await apply(
        "All Mail",
        {
          flagUpdates: [
            { location: makeLocation(1, "All Mail"), flags: d.message.flags, labelIds: ["inbox"] },
          ],
        },
        "provider",
      );
      expect((await message("gm:1"))?.labelIds).toEqual(["inbox"]);
    });

    it("is idempotent for location batches", async () => {
      const d = doc(1, "again", { providerId: "ag" });
      const first = { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } };
      const known = {
        knownLocations: [
          { providerId: "ag", location: makeLocation(4, "Work"), flags: d.message.flags },
        ],
      };
      await apply("INBOX", first);
      await apply("Work", known);
      const once = await h().read.store.changesSince(0);
      await apply("INBOX", first);
      await apply("Work", known);
      const twice = await h().read.store.changesSince(0);
      expect(twice.changedKeys).toEqual(once.changedKeys);
      expect(twice.changeSeq).toBeGreaterThanOrEqual(once.changeSeq);
      expect((await message("ag"))?.labelIds).toEqual(["INBOX", "Work"]);
      expect((await h().read.store.listNewest({ limit: 10 })).length).toBe(1);
    });
    it("applies Reply-To answers with the cursor, only where unknown, and repeating is harmless", async () => {
      const d = doc(1, "old mail", { providerId: "rt" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      const key = (await message("rt"))?.key as number;
      expect((await message("rt"))?.replyTo).toBeUndefined();
      expect(await h().store.listUnknownReplyToUids(ACC, "INBOX", "1", 10)).toEqual([1]);

      const help = [{ address: "help@shop.example" }];
      const answers = { replyTos: [{ location: makeLocation(1), replyTo: help }] };
      await apply("INBOX", { ...answers, cursor: { uid: 1, n: 2 } });
      expect((await message("rt"))?.replyTo).toEqual(help);
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uid: 1, n: 2 });
      expect(await h().store.listUnknownReplyToUids(ACC, "INBOX", "1", 10)).toEqual([]);

      const once = await h().read.store.changesSince(0);
      expect(once.changedKeys).toContain(key);
      await apply("INBOX", { ...answers, cursor: { uid: 1, n: 3 } });
      await apply("INBOX", {
        replyTos: [{ location: makeLocation(1), replyTo: [] }],
        cursor: { uid: 1, n: 4 },
      });
      expect((await message("rt"))?.replyTo).toEqual(help);
      expect((await h().read.store.changesSince(0)).changeSeq).toBe(once.changeSeq);
    });

    it("applies attachment answers with the cursor, corrects the flag, and repeating is harmless", async () => {
      const d = doc(1, "old mail", { providerId: "fa", hasAttachments: true });
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      expect(await h().store.listUnknownAttachmentUids(ACC, "INBOX", "1", 10)).toEqual([1]);

      const answers = {
        attachmentAnswers: [
          {
            location: makeLocation(1),
            attachments: [
              { partId: "2", name: "a.pdf", mimeType: "application/pdf", size: 10, inline: false },
            ],
          },
        ],
      };
      await apply("INBOX", { ...answers, cursor: { uid: 1, n: 2 } });
      const key = (await message("fa"))?.key as number;
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uid: 1, n: 2 });
      expect(await h().store.listUnknownAttachmentUids(ACC, "INBOX", "1", 10)).toEqual([]);
      expect(
        (await h().store.getThread(d.message.threadId))?.attachments.get(key)?.items,
      ).toHaveLength(1);

      await apply("INBOX", { ...answers, cursor: { uid: 1, n: 3 } });
      expect(
        (await h().store.getThread(d.message.threadId))?.attachments.get(key)?.items,
      ).toHaveLength(1);
    });

    it("announces a has_attachments correction as an ordinary change", async () => {
      const d = doc(1, "wrongly flagged", { providerId: "fc", hasAttachments: true });
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      const key = (await message("fc"))?.key as number;
      const seq = (await h().read.store.changesSince(0)).changeSeq;

      await apply("INBOX", {
        attachmentAnswers: [{ location: makeLocation(1), attachments: [] }],
        cursor: { uid: 1, n: 2 },
      });
      expect((await message("fc"))?.hasAttachments).toBe(false);
      const changes = await h().read.store.changesSince(seq);
      expect(changes.changeSeq).toBeGreaterThan(seq);
      expect(changes.changedKeys).toEqual([key]);
    });

    it("finds the message of an answer in the same batch that stores it", async () => {
      const d = doc(1, "fresh", { providerId: "fn", hasAttachments: true });
      await apply("INBOX", {
        documents: [syncedDoc(d, 4)],
        attachmentAnswers: [
          {
            location: makeLocation(4),
            attachments: [
              { partId: "2", name: "new.pdf", mimeType: "application/pdf", size: 5, inline: false },
            ],
          },
        ],
        cursor: { uid: 4 },
      });
      const key = (await message("fn"))?.key as number;
      expect((await h().store.getAttachment(key, "2"))?.name).toBe("new.pdf");
      expect(await h().store.listUnknownAttachmentUids(ACC, "INBOX", "1", 10)).toEqual([]);
    });

    it("leaves the answers and the cursor as they were when the batch fails", async () => {
      const d = doc(1, "atomic", { providerId: "at" });
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      const seq = (await h().read.store.changesSince(0)).changeSeq;

      // The cursor is written last: failing there undoes everything the batch did before it.
      const failing = {
        ...h(),
        cursors: {
          get: h().cursors.get.bind(h().cursors),
          deleteAccount: h().cursors.deleteAccount.bind(h().cursors),
          set: async () => {
            throw new Error("disk full");
          },
        },
      };
      await expect(
        applySyncBatch(failing, {
          accountId: ACC,
          folderId: "INBOX",
          batch: makeSyncBatch({
            replyTos: [{ location: makeLocation(1), replyTo: [{ address: "help@shop.example" }] }],
            attachmentAnswers: [{ location: makeLocation(1), attachments: [] }],
            cursor: { uid: 2 },
          }),
        }),
      ).rejects.toThrow("disk full");
      expect(await h().store.listUnknownAttachmentUids(ACC, "INBOX", "1", 10)).toEqual([]);

      expect((await message("at"))?.replyTo).toBeUndefined();
      expect(await h().store.listUnknownReplyToUids(ACC, "INBOX", "1", 10)).toEqual([1]);
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uid: 1 });
      expect((await h().read.store.changesSince(0)).changeSeq).toBe(seq);
    });
  });
}

export function describeFlagOutboxContract(name: string, factory: Factory<FlagOutboxPort>) {
  describe(`FlagOutboxPort contract: ${name}`, () => {
    const ops = useFixture(factory);
    const intent = (key: number, over: Partial<NewSeenIntent> = {}): NewSeenIntent => ({
      key,
      accountId: "acc1",
      seen: true,
      previousSeen: false,
      nextAttemptMs: 1000,
      createdAtMs: 500,
      ...over,
    });

    it("stores one request per message and lists it as it was put", async () => {
      await ops().put([
        intent(1),
        intent(2, { accountId: "acc2", seen: false, previousSeen: true }),
      ]);
      expect(await ops().listPending()).toEqual([
        {
          key: 1,
          accountId: "acc1",
          seen: true,
          previousSeen: false,
          attempts: 0,
          nextAttemptMs: 1000,
          createdAtMs: 500,
          rev: 1,
        },
        expect.objectContaining({ key: 2, accountId: "acc2", seen: false, previousSeen: true }),
      ]);
      expect((await ops().listPending("acc2")).map((i) => i.key)).toEqual([2]);
      expect(await ops().listPending("nobody")).toEqual([]);
    });

    it("lets the latest request win but remembers what the server had", async () => {
      await ops().put([intent(1, { seen: true, previousSeen: false })]);
      const [first] = await ops().listPending();
      await ops().defer([{ intent: first as SeenIntent, nextAttemptMs: 9000 }]);
      await ops().put([
        intent(1, { seen: false, previousSeen: true, nextAttemptMs: 2000, createdAtMs: 700 }),
      ]);
      expect(await ops().listPending()).toEqual([
        {
          key: 1,
          accountId: "acc1",
          seen: false,
          // The state before the first unpushed request, not the one the second saw.
          previousSeen: false,
          attempts: 0,
          nextAttemptMs: 2000,
          createdAtMs: 500,
          rev: 2,
        },
      ]);
    });

    it("lists what is due, earliest first, and tells when the next one is", async () => {
      expect(await ops().nextDueMs()).toBeNull();
      await ops().put([
        intent(1, { nextAttemptMs: 3000 }),
        intent(2, { nextAttemptMs: 1000 }),
        intent(3, { nextAttemptMs: 2000 }),
      ]);
      expect(await ops().nextDueMs()).toBe(1000);
      expect((await ops().listDue(999, 10)).map((i) => i.key)).toEqual([]);
      expect((await ops().listDue(2500, 10)).map((i) => i.key)).toEqual([2, 3]);
      expect((await ops().listDue(5000, 2)).map((i) => i.key)).toEqual([2, 3]);
    });

    it("deletes a settled request only while it is the revision that was pushed", async () => {
      await ops().put([intent(1), intent(2)]);
      const [one, two] = (await ops().listPending()) as [SeenIntent, SeenIntent];
      // A newer request for message 1 arrives while the old one is on the wire.
      await ops().put([intent(1, { seen: false })]);

      const deleted = await ops().settle([one, two]);
      expect(deleted.map((i) => i.key)).toEqual([2]);
      expect(await ops().listPending()).toEqual([
        expect.objectContaining({ key: 1, seen: false, rev: 2 }),
      ]);
      expect(await ops().settle([two])).toEqual([]);
    });

    it("counts a failed attempt and moves the request, unless a newer one replaced it", async () => {
      await ops().put([intent(1), intent(2)]);
      const [one, two] = (await ops().listPending()) as [SeenIntent, SeenIntent];
      await ops().put([intent(2, { seen: false })]);

      await ops().defer([
        { intent: one, nextAttemptMs: 4000 },
        { intent: two, nextAttemptMs: 4000 },
      ]);
      const now = await ops().listPending();
      expect(now.find((i) => i.key === 1)).toMatchObject({ attempts: 1, nextAttemptMs: 4000 });
      expect(now.find((i) => i.key === 2)).toMatchObject({ attempts: 0, nextAttemptMs: 1000 });
    });

    it("drops every request of an account and nothing else", async () => {
      await ops().put([intent(1), intent(2, { accountId: "acc2" })]);
      await ops().discardAccount("acc1");
      expect((await ops().listPending()).map((i) => i.key)).toEqual([2]);
    });
  });
}

/** Marking read and unread, and what a sync may and may not do to a request not yet pushed. */
export function describeSeenContract(name: string, factory: Factory<UnitOfWorkHarness>) {
  describe(`Read state contract (ADR 0039): ${name}`, () => {
    const h = useFixture(factory);
    const ACC = "acc1";
    const deps = () => ({ ...h(), now: () => 5000 });
    const apply = (folderId: string, batch: Partial<SyncBatch>) =>
      applySyncBatch(h(), { accountId: ACC, folderId, batch: makeSyncBatch(batch) });
    const message = async (providerId: string) => {
      const key = (await h().store.findByProviderIds(ACC, [providerId])).get(providerId);
      const [m] = key === undefined ? [] : await h().read.store.getByKeys([key]);
      return m;
    };
    const readAt = async (providerId: string) => (await message(providerId))?.flags.seen;
    const seqNow = async () => (await h().read.store.changesSince(0)).changeSeq;

    async function stored(providerId = "rd", over: Partial<Message["flags"]> = {}) {
      const d = makeDocument(
        { dateMs: day(1), providerId, flags: flags(over) },
        `body ${providerId}`,
      );
      await apply("INBOX", { documents: [syncedDoc(d, 1)], cursor: { uid: 1 } });
      return { d, key: (await message(providerId))?.key as number };
    }

    it("writes the flag and the request in one unit, and a failed unit leaves neither", async () => {
      const { key } = await stored();
      const result = await setSeen(deps(), [key], true);
      expect(result.changedKeys).toEqual([key]);
      expect(await readAt("rd")).toBe(true);
      expect(await h().flagOps.listPending()).toEqual([
        expect.objectContaining({
          key,
          accountId: ACC,
          seen: true,
          previousSeen: false,
          nextAttemptMs: 6000,
        }),
      ]);

      const other = await stored("rd2");
      await expect(
        h().uow.run(async () => {
          await setSeen(deps(), [other.key], true);
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await readAt("rd2")).toBe(false);
      expect((await h().flagOps.listPending()).map((i) => i.key)).toEqual([key]);
    });

    it("queues nothing for a message that already has the state", async () => {
      const { key } = await stored("rd", { seen: true });
      const seq = await seqNow();
      await setSeen(deps(), [key], true);
      expect(await h().flagOps.listPending()).toEqual([]);
      expect(await seqNow()).toBe(seq);
    });

    it("keeps the first previous state when the reader changes their mind", async () => {
      const { key } = await stored();
      await setSeen(deps(), [key], true);
      await setSeen(deps(), [key], false);
      expect(await h().flagOps.listPending()).toEqual([
        expect.objectContaining({ key, seen: false, previousSeen: false, rev: 2 }),
      ]);
    });

    it("does not let a batch from the server's older state undo an unpushed change", async () => {
      const { d, key } = await stored();
      await setSeen(deps(), [key], true);

      // The server still says unread, and has a flag the reader set elsewhere.
      const result = await apply("INBOX", {
        flagUpdates: [{ location: makeLocation(1), flags: { ...d.message.flags, flagged: true } }],
        cursor: { uid: 1, modseq: "5" },
      });
      expect((await message("rd"))?.flags).toEqual(flags({ seen: true, flagged: true }));
      expect(result.seenRestored).toBe(1);
      expect(await h().cursors.get(ACC, "INBOX")).toEqual({ uid: 1, modseq: "5" });
      expect((await h().read.store.changesSince(0)).changedKeys).toContain(key);
    });

    it("puts a pending unread back over a document, a known location and a flag update", async () => {
      const { d, key } = await stored("rd", { seen: true });
      await setSeen(deps(), [key], false);
      const readOnServer = { ...d.message.flags, seen: true };

      await apply("INBOX", {
        documents: [syncedDoc({ ...d, message: { ...d.message, flags: readOnServer } }, 1)],
      });
      expect(await readAt("rd")).toBe(false);

      await apply("Work", {
        knownLocations: [
          { providerId: "rd", location: makeLocation(4, "Work"), flags: readOnServer },
        ],
      });
      expect(await readAt("rd")).toBe(false);

      await apply("INBOX", { flagUpdates: [{ location: makeLocation(1), flags: readOnServer }] });
      expect(await readAt("rd")).toBe(false);
    });

    it("announces nothing when the batch leaves the pending state as it is", async () => {
      const { d, key } = await stored();
      await setSeen(deps(), [key], true);
      const seq = await seqNow();
      const result = await apply("INBOX", {
        flagUpdates: [{ location: makeLocation(1), flags: { ...d.message.flags, seen: true } }],
      });
      expect(result.seenRestored).toBe(0);
      expect(result.flagsUpdated).toBe(0);
      expect(await seqNow()).toBe(seq);
    });

    it("does not touch the store when nothing is pending", async () => {
      const { d } = await stored();
      const seq = await seqNow();
      const result = await apply("INBOX", {
        flagUpdates: [{ location: makeLocation(1), flags: d.message.flags }],
      });
      expect(result.seenRestored).toBe(0);
      expect(await seqNow()).toBe(seq);
      expect(await reapplyPendingSeen(h(), ACC)).toEqual([]);
    });

    it("takes the server's other flags, and leaves a request of another account alone", async () => {
      const { d, key } = await stored();
      await setSeen(deps(), [key], true);
      await h().flagOps.put([
        {
          key: 999,
          accountId: "other",
          seen: true,
          previousSeen: false,
          nextAttemptMs: 0,
          createdAtMs: 0,
        },
      ]);
      const seq = await seqNow();
      await apply("INBOX", {
        flagUpdates: [{ location: makeLocation(1), flags: { ...d.message.flags, answered: true } }],
      });
      expect((await message("rd"))?.flags).toEqual(flags({ seen: true, answered: true }));
      expect(await seqNow()).toBeGreaterThan(seq);
    });

    it("gives the message its previous state when the server refuses, but not if a newer request replaced it", async () => {
      const first = await stored();
      const second = await stored("rd2");
      await setSeen(deps(), [first.key, second.key], true);
      const pending = (await h().flagOps.listPending()) as SeenIntent[];
      // The reader toggles the second message again while the push is on the wire.
      await setSeen(deps(), [second.key], false);

      const restored = await rejectSeen(h(), pending);
      expect(restored).toEqual([first.key]);
      expect(await readAt("rd")).toBe(false);
      expect(await h().flagOps.listPending()).toEqual([
        expect.objectContaining({ key: second.key, seen: false }),
      ]);
      // The restore is a change of its own: the server will never report it.
      expect((await h().read.store.changesSince(0)).changedKeys).toContain(first.key);
    });

    it("deletes finished requests but keeps one that a newer request replaced", async () => {
      const first = await stored();
      const second = await stored("rd2");
      await setSeen(deps(), [first.key, second.key], true);
      const pending = (await h().flagOps.listPending()) as SeenIntent[];
      await setSeen(deps(), [second.key], false);
      await finishSeen(h(), pending);
      expect((await h().flagOps.listPending()).map((i) => i.key)).toEqual([second.key]);
      expect(await readAt("rd")).toBe(true);
    });
  });
}

const stored = (overrides: Partial<StoredAccount> = {}): StoredAccount => ({
  id: "acc1",
  address: "me@example.com",
  displayName: "Me",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "me@example.com" },
  createdAtMs: 100,
  ...overrides,
});

export function describeAccountStoreContract(name: string, factory: Factory<AccountStorePort>) {
  describe(`AccountStorePort contract: ${name}`, () => {
    const accounts = useFixture(factory);

    it("stores accounts and returns them oldest first, by id too", async () => {
      expect(await accounts().list()).toEqual([]);
      expect(await accounts().get("acc1")).toBeNull();
      const later = stored({ id: "b", address: "b@example.com", createdAtMs: 200 });
      const earlier = stored({ id: "a", address: "a@example.com", createdAtMs: 100 });
      await accounts().add(later);
      await accounts().add(earlier);
      expect(await accounts().list()).toEqual([earlier, later]);
      expect(await accounts().get("b")).toEqual(later);
    });

    it("keeps the server settings exactly", async () => {
      const a = stored({
        imap: { host: "mail.example.pl", port: 143, security: "starttls", username: "me" },
      });
      await accounts().add(a);
      expect(await accounts().get(a.id)).toEqual(a);
    });

    it("rejects a taken id or address, whatever its case", async () => {
      await accounts().add(stored());
      await expect(accounts().add(stored({ address: "other@example.com" }))).rejects.toMatchObject({
        name: "AccountExistsError",
      });
      await expect(
        accounts().add(stored({ id: "acc2", address: "ME@Example.com" })),
      ).rejects.toMatchObject({
        name: "AccountExistsError",
      });
      expect(await accounts().list()).toHaveLength(1);
    });

    it("keeps the largest message the server takes, and forgets it on request", async () => {
      await accounts().add(stored());
      expect((await accounts().get("acc1"))?.messageLimitBytes).toBeUndefined();
      await accounts().setMessageLimit("acc1", 26_214_400);
      expect(await accounts().get("acc1")).toEqual(stored({ messageLimitBytes: 26_214_400 }));
      await accounts().setMessageLimit("acc1", null);
      expect(await accounts().get("acc1")).toEqual(stored());
      // an unknown account is skipped, not an error
      await accounts().setMessageLimit("nope", 5);
      expect(await accounts().list()).toHaveLength(1);
      await accounts().add(stored({ id: "acc2", address: "x@example.com", messageLimitBytes: 99 }));
      expect((await accounts().get("acc2"))?.messageLimitBytes).toBe(99);
    });

    it("removes an account once", async () => {
      await accounts().add(stored());
      expect(await accounts().remove("acc1")).toBe(true);
      expect(await accounts().remove("acc1")).toBe(false);
      expect(await accounts().list()).toEqual([]);
      await accounts().add(stored());
    });
  });
}

const sampleDraft = (overrides: Partial<Draft> = {}): Draft => ({
  id: "d1",
  accountId: "acc1",
  from: person("Miłosz", "me@example.com"),
  to: [person("Anna", "anna@example.com")],
  cc: [],
  bcc: [{ address: "hidden@example.com" }],
  subject: "Re: Wycena",
  bodyMarkdown: "Dzień dobry,\n\n**Cena**: 36 000 PLN",
  inReplyTo: "<a@example.com>",
  references: ["<root@example.com>", "<a@example.com>"],
  version: 1,
  fingerprint: "f".repeat(64),
  updatedAtMs: 1000,
  ...overrides,
});

export function describeDraftStoreContract(name: string, factory: Factory<DraftStorePort>) {
  describe(`DraftStorePort contract: ${name}`, () => {
    const drafts = useFixture(factory);

    it("round-trips every field, with and without a thread", async () => {
      const plain = sampleDraft();
      const threaded = sampleDraft({ id: "d2", threadId: "lt:acc1:<root@example.com>" });
      await drafts().put(plain);
      await drafts().put(threaded);
      expect(await drafts().get("d1")).toEqual(plain);
      expect(await drafts().get("d2")).toEqual(threaded);
      expect(await drafts().get("nope")).toBeNull();
    });

    it("replaces a draft with the same id", async () => {
      await drafts().put(sampleDraft());
      await drafts().put(sampleDraft({ version: 2, subject: "Zmiana", updatedAtMs: 2000 }));
      expect(await drafts().get("d1")).toMatchObject({ version: 2, subject: "Zmiana" });
      expect(await drafts().list()).toHaveLength(1);
    });

    it("deletes and says whether the draft existed", async () => {
      await drafts().put(sampleDraft());
      expect(await drafts().delete("d1")).toBe(true);
      expect(await drafts().delete("d1")).toBe(false);
      expect(await drafts().get("d1")).toBeNull();
    });

    it("keeps the files of a draft in order, with their delivery", async () => {
      const attachments = [
        { id: "f2", name: "b.pdf", size: 20, delivery: { kind: "inline" as const } },
        { id: "f1", name: "a.png", size: 10, delivery: { kind: "link" as const, carrierId: "x" } },
      ];
      await drafts().put(sampleDraft({ attachments }));
      expect((await drafts().get("d1"))?.attachments).toEqual(attachments);
      await drafts().put(sampleDraft({ attachments: [] }));
      expect((await drafts().get("d1"))?.attachments ?? []).toEqual([]);
    });

    it("lists the most recently changed first", async () => {
      await drafts().put(sampleDraft({ id: "old", updatedAtMs: 1 }));
      await drafts().put(sampleDraft({ id: "new", updatedAtMs: 3 }));
      await drafts().put(sampleDraft({ id: "mid", updatedAtMs: 2 }));
      expect((await drafts().list()).map((d) => d.id)).toEqual(["new", "mid", "old"]);
    });

    it("finds the draft answering a thread, per account", async () => {
      await drafts().put(sampleDraft({ id: "a", threadId: "t1" }));
      await drafts().put(sampleDraft({ id: "b", threadId: "t1", accountId: "acc2" }));
      expect((await drafts().findByThread("acc1", "t1"))?.id).toBe("a");
      expect((await drafts().findByThread("acc2", "t1"))?.id).toBe("b");
      expect(await drafts().findByThread("acc1", "t2")).toBeNull();
    });

    it("drops the drafts of one account", async () => {
      await drafts().put(sampleDraft({ id: "a" }));
      await drafts().put(sampleDraft({ id: "b", accountId: "acc2" }));
      await drafts().discardAccount("acc1");
      expect((await drafts().list()).map((d) => d.id)).toEqual(["b"]);
    });
  });
}

const opAt = (
  id: string,
  nowMs: number,
  over: { draftId?: string; accountId?: string; windowMs?: number; encodedBytes?: number } = {},
) =>
  newSendOperation({
    id,
    accountId: over.accountId ?? "acc1",
    approval: approve(sampleDraft({ id: over.draftId ?? "d1" }), 7, nowMs),
    nowMs,
    notBeforeMs: nowMs + (over.windowMs ?? 10_000),
    ...(over.encodedBytes === undefined ? {} : { encodedBytes: over.encodedBytes }),
  });

export function describeOutboxContract(name: string, factory: Factory<OutboxPort>) {
  describe(`OutboxPort contract: ${name}`, () => {
    const outbox = useFixture(factory);

    it("stores an operation and returns it unchanged", async () => {
      const op = opAt("o1", 1000);
      await outbox().enqueue(op);
      expect(await outbox().get("o1")).toEqual(op);
      expect(await outbox().get("nope")).toBeNull();
    });

    it("claims the earliest due pending operation once, as running", async () => {
      await outbox().enqueue(opAt("late", 1000, { windowMs: 5000 }));
      await outbox().enqueue(opAt("first", 1000, { windowMs: 1000 }));
      await outbox().enqueue(opAt("second", 1001, { windowMs: 999 }));

      expect(await outbox().claimNext(1999, "small")).toBeNull();
      const a = await outbox().claimNext(2000, "small");
      expect(a).toMatchObject({ id: "first", attempts: 1, state: { kind: "running" } });
      expect(await outbox().claimNext(2000, "small")).toMatchObject({ id: "second" });
      expect(await outbox().claimNext(2000, "small")).toBeNull();
      expect(await outbox().claimNext(6000, "small")).toMatchObject({ id: "late" });
      expect(await outbox().get("first")).toMatchObject({
        state: { kind: "running" },
        attempts: 1,
      });
    });

    it("reports when the next pending operation is due", async () => {
      expect(await outbox().nextDueMs("small")).toBeNull();
      await outbox().enqueue(opAt("a", 1000, { windowMs: 9000 }));
      await outbox().enqueue(opAt("b", 1000, { windowMs: 4000 }));
      expect(await outbox().nextDueMs("small")).toBe(5000);
      await outbox().claimNext(5000, "small");
      expect(await outbox().nextDueMs("small")).toBe(10_000);
    });

    it("keeps every state, with its text, across update", async () => {
      const op = opAt("o1", 0, { windowMs: 0 });
      await outbox().enqueue(op);
      const running = startSend(op, 5) as SendOperation;
      const cases: SendOperation[] = [
        holdSend(op, 5),
        running,
        finishSend(running, { kind: "succeeded", providerMessageId: "<id@x>" }, 6),
        finishSend(running, { kind: "failed", reason: "550 Mailbox unavailable" }, 6),
        finishSend(running, { kind: "unknown" }, 6),
        voidSend(op, "The draft was edited", 6),
        cancelSend(op, 6),
        { ...op, warning: "Sent, but no copy", messageId: "<m@x>" },
      ];
      for (const next of cases) {
        await outbox().update(next);
        expect(await outbox().get("o1")).toEqual(next);
      }
    });

    it("ignores an update for an unknown operation", async () => {
      await outbox().update(opAt("ghost", 0));
      expect(await outbox().get("ghost")).toBeNull();
    });

    it("lists by state, oldest first", async () => {
      await outbox().enqueue(opAt("b", 200, { windowMs: 0 }));
      await outbox().enqueue(opAt("a", 100, { windowMs: 0 }));
      await outbox().enqueue(opAt("c", 300, { windowMs: 0 }));
      await outbox().claimNext(300, "small");
      expect((await outbox().listByState(["pending"])).map((o) => o.id)).toEqual(["b", "c"]);
      expect((await outbox().listByState(["running", "pending"])).map((o) => o.id)).toEqual([
        "a",
        "b",
        "c",
      ]);
      expect(await outbox().listByState([])).toEqual([]);
    });

    it("shows active operations and recently finished ones, never cancelled", async () => {
      const mk = async (id: string, at: number) => {
        await outbox().enqueue(opAt(id, at, { windowMs: 0 }));
        return (await outbox().get(id)) as SendOperation;
      };
      const pending = await mk("pending", 1);
      const done = await mk("done", 2);
      const oldDone = await mk("oldDone", 3);
      const cancelled = await mk("cancelled", 4);
      const voided = await mk("voided", 5);
      await outbox().update(
        finishSend(
          startSend(done, 100) as SendOperation,
          { kind: "succeeded", providerMessageId: "x" },
          100,
        ),
      );
      await outbox().update(
        finishSend(
          startSend(oldDone, 10) as SendOperation,
          { kind: "succeeded", providerMessageId: "y" },
          10,
        ),
      );
      await outbox().update(cancelSend(cancelled, 100));
      await outbox().update(voidSend(voided, "edited", 100));
      expect((await outbox().listVisible(50)).map((o) => o.id)).toEqual([
        "pending",
        "done",
        "voided",
      ]);
      expect(pending.id).toBe("pending");
    });

    it("finds the unfinished operations of one draft", async () => {
      await outbox().enqueue(opAt("a", 1, { draftId: "d1" }));
      await outbox().enqueue(opAt("b", 2, { draftId: "d2" }));
      const c = opAt("c", 3, { draftId: "d1" });
      await outbox().enqueue(c);
      await outbox().update(cancelSend(c, 4));
      expect((await outbox().activeForDraft("d1")).map((o) => o.id)).toEqual(["a"]);
    });

    it("keeps the MIME apart from the record, with the Message-ID", async () => {
      const op = opAt("o1", 0, { windowMs: 0 });
      await outbox().enqueue(op);
      expect(await outbox().getMime("o1")).toBeNull();
      const bytes = new Uint8Array([0, 1, 2, 254, 255, 13, 10]);
      await outbox().setMime("o1", "<x@y>", bytes);
      expect(await outbox().getMime("o1")).toEqual(bytes);
      expect(await outbox().get("o1")).toMatchObject({ messageId: "<x@y>" });
      // An update of the record leaves the bytes alone.
      await outbox().update(
        startSend((await outbox().get("o1")) as SendOperation, 1) as SendOperation,
      );
      expect(await outbox().getMime("o1")).toEqual(bytes);
    });

    it("keeps what a send needs to survive a restart: lane input, the mark, the retries, the action", async () => {
      await outbox().enqueue(opAt("o1", 1000, { windowMs: 0, encodedBytes: 5_000_000 }));
      const running = (await outbox().claimNext(1000, "large")) as SendOperation;
      expect(running).toMatchObject({ encodedBytes: 5_000_000, dataEnded: false, autoRetries: 0 });
      await outbox().update({ ...markDataEnded(running), autoRetries: 2 });
      expect(await outbox().get("o1")).toMatchObject({ dataEnded: true, autoRetries: 2 });
      const failed = finishSend(
        (await outbox().get("o1")) as SendOperation,
        { kind: "failed", reason: "552 too big", action: "openDraft" },
        1001,
      );
      await outbox().update(failed);
      expect((await outbox().get("o1"))?.state).toEqual({
        kind: "failed",
        reason: "552 too big",
        action: "openDraft",
      });
      const plain = finishSend(
        startSend({ ...failed, state: { kind: "pending" } }, 1002) as SendOperation,
        { kind: "failed", reason: "550" },
        1003,
      );
      await outbox().update(plain);
      expect((await outbox().get("o1"))?.state).toEqual({ kind: "failed", reason: "550" });
      // claiming starts a fresh attempt without the mark
      await outbox().update({ ...plain, state: { kind: "pending" }, dataEnded: true });
      expect(await outbox().claimNext(2000, "large")).toMatchObject({ dataEnded: false });
    });

    it("splits the lanes at 1 MiB encoded and nothing crosses", async () => {
      await outbox().enqueue(opAt("small", 1000, { windowMs: 0, encodedBytes: 1_048_575 }));
      await outbox().enqueue(opAt("large", 1000, { windowMs: 0, encodedBytes: 1_048_576 }));
      expect(await outbox().nextDueMs("small")).toBe(1000);
      expect(await outbox().nextDueMs("large")).toBe(1000);
      expect(await outbox().claimNext(1000, "large")).toMatchObject({ id: "large" });
      expect(await outbox().claimNext(1000, "large")).toBeNull();
      expect(await outbox().claimNext(1000, "small")).toMatchObject({ id: "small" });
      expect(await outbox().nextDueMs("small")).toBeNull();
      expect(await outbox().nextDueMs("large")).toBeNull();
    });

    it("runs one large send per account, and another account's goes alongside", async () => {
      const big = 2_000_000;
      await outbox().enqueue(
        opAt("a1", 1000, { windowMs: 0, accountId: "acc1", encodedBytes: big }),
      );
      await outbox().enqueue(
        opAt("a2", 1001, { windowMs: 0, accountId: "acc1", encodedBytes: big }),
      );
      await outbox().enqueue(
        opAt("b1", 1002, { windowMs: 0, accountId: "acc2", encodedBytes: big }),
      );
      expect(await outbox().claimNext(2000, "large")).toMatchObject({ id: "a1" });
      // a2 waits for a1; b1 is another account's
      expect(await outbox().claimNext(2000, "large")).toMatchObject({ id: "b1" });
      expect(await outbox().claimNext(2000, "large")).toBeNull();
      const a1 = (await outbox().get("a1")) as SendOperation;
      await outbox().update(finishSend(a1, { kind: "succeeded", providerMessageId: "x" }, 2001));
      expect(await outbox().claimNext(2001, "large")).toMatchObject({ id: "a2" });
    });

    it("keeps the built message as a spool path with its size, apart from the BLOB", async () => {
      await outbox().enqueue(opAt("o1", 1000));
      expect(await outbox().getSpool("o1")).toBeNull();
      await outbox().setSpool("o1", "<big@y>", "/spool/o1.eml", 12_345_678);
      expect(await outbox().getSpool("o1")).toEqual({ path: "/spool/o1.eml", bytes: 12_345_678 });
      expect(await outbox().get("o1")).toMatchObject({
        messageId: "<big@y>",
        mimeBytes: 12_345_678,
      });
      expect(await outbox().getMime("o1")).toBeNull();
      // an update with an older copy of the operation does not forget the size
      await outbox().update((await outbox().get("o1")) as SendOperation);
      await outbox().update({ ...opAt("o1", 1000), mimeBytes: null });
      expect((await outbox().get("o1"))?.mimeBytes).toBe(12_345_678);
      // the BLOB path knows its size too
      await outbox().enqueue(opAt("o2", 1000));
      await outbox().setMime("o2", "<s@y>", new Uint8Array([1, 2, 3]));
      expect(await outbox().get("o2")).toMatchObject({ mimeBytes: 3 });
      expect(await outbox().getSpool("o2")).toBeNull();
    });

    it("prunes finished operations that are old enough", async () => {
      for (const id of ["keep", "oldCancelled", "oldDone"])
        await outbox().enqueue(opAt(id, 1, { windowMs: 0 }));
      const get = async (id: string) => (await outbox().get(id)) as SendOperation;
      await outbox().update(cancelSend(await get("oldCancelled"), 10));
      await outbox().update(
        finishSend(
          startSend(await get("oldDone"), 10) as SendOperation,
          { kind: "succeeded", providerMessageId: "z" },
          10,
        ),
      );
      expect(await outbox().pruneFinished(11)).toBe(2);
      expect(await outbox().get("keep")).not.toBeNull();
      expect(await outbox().get("oldDone")).toBeNull();
    });

    it("drops the operations of one account in every state", async () => {
      await outbox().enqueue(opAt("a", 1, { accountId: "acc1", windowMs: 0 }));
      await outbox().enqueue(opAt("b", 1, { accountId: "acc2", windowMs: 0 }));
      await outbox().claimNext(1, "small");
      await outbox().discardAccount("acc1");
      expect(await outbox().get("a")).toBeNull();
      expect(await outbox().get("b")).not.toBeNull();
    });
  });
}

const sampleView = (overrides: Partial<SavedView> = {}): SavedView => ({
  id: "v1",
  name: "Invoices",
  query: "faktura has:attachment",
  position: 0,
  createdMs: 1000,
  updatedMs: 1000,
  ...overrides,
});

export function describeSavedViewStoreContract(name: string, factory: Factory<SavedViewStorePort>) {
  describe(`SavedViewStorePort contract: ${name}`, () => {
    const views = useFixture(factory);

    it("keeps recent searches per view, latest first, up to the limit", async () => {
      await views().noteSearch("a", "one", 1);
      await views().noteSearch("a", "two", 2);
      await views().noteSearch("b", "other", 3);
      await views().noteSearch("a", "one", 4);
      expect(await views().recentSearches("a")).toEqual(["one", "two"]);
      expect(await views().recentSearches("b")).toEqual(["other"]);
      expect(await views().recentSearches("none")).toEqual([]);

      for (let i = 0; i < MAX_RECENT_SEARCHES + 3; i++) {
        await views().noteSearch("a", `q${i}`, 10 + i);
      }
      const kept = await views().recentSearches("a");
      expect(kept).toHaveLength(MAX_RECENT_SEARCHES);
      expect(kept[0]).toBe(`q${MAX_RECENT_SEARCHES + 2}`);
      expect(kept).not.toContain("one");
    });

    it("clears all the searches of one view, and only of that one", async () => {
      await views().noteSearch("a", "one", 1);
      await views().noteSearch("a", "two", 2);
      await views().noteSearch("b", "other", 3);
      await views().clearSearches("a");
      expect(await views().recentSearches("a")).toEqual([]);
      expect(await views().recentSearches("b")).toEqual(["other"]);
      await views().clearSearches("none");
    });

    it("forgets one search, and all of them with the view", async () => {
      await views().put(sampleView());
      await views().noteSearch("v1", "one", 1);
      await views().noteSearch("v1", "two", 2);
      await views().forgetSearch("v1", "two");
      expect(await views().recentSearches("v1")).toEqual(["one"]);
      await views().remove("v1");
      expect(await views().recentSearches("v1")).toEqual([]);
    });

    it("round-trips every field", async () => {
      const v = sampleView({ query: 'from:anna "a b" -is:read', name: "Zażółć" });
      await views().put(v);
      expect(await views().get("v1")).toEqual(v);
      expect(await views().get("nope")).toBeNull();
    });

    it("replaces a view with the same id", async () => {
      await views().put(sampleView());
      await views().put(sampleView({ query: "is:unread", updatedMs: 2000 }));
      expect(await views().get("v1")).toMatchObject({ query: "is:unread", updatedMs: 2000 });
      expect(await views().list()).toHaveLength(1);
    });

    it("lists by position, then creation time, then id", async () => {
      await views().put(sampleView({ id: "c", position: 2 }));
      await views().put(sampleView({ id: "b", position: 1, createdMs: 5 }));
      await views().put(sampleView({ id: "a2", position: 1, createdMs: 5 }));
      await views().put(sampleView({ id: "a1", position: 1, createdMs: 1 }));
      expect((await views().list()).map((v) => v.id)).toEqual(["a1", "a2", "b", "c"]);
    });

    it("removes and says whether the view existed", async () => {
      await views().put(sampleView());
      expect(await views().remove("v1")).toBe(true);
      expect(await views().remove("v1")).toBe(false);
      expect(await views().list()).toEqual([]);
    });

    it("sets positions in the order given and skips unknown ids", async () => {
      for (const [i, id] of ["a", "b", "c"].entries()) {
        await views().put(sampleView({ id, position: i }));
      }
      await views().setPositions(["c", "ghost", "a", "b"]);
      const list = await views().list();
      expect(list.map((v) => v.id)).toEqual(["c", "a", "b"]);
      expect(list.map((v) => v.position)).toEqual([0, 2, 3]);
      expect(list.every((v) => v.name === "Invoices" && v.updatedMs === 1000)).toBe(true);
    });
  });
}

const imageRule = (overrides: Partial<ImageRule> = {}): ImageRule => ({
  scope: "address",
  value: "news@shop.example",
  decision: "allow",
  createdMs: 1000,
  ...overrides,
});

/** ADR 0037. Rules are unique by scope and value; the general setting starts at `ask`. */
export function describeImageRuleStoreContract(name: string, factory: Factory<ImageRuleStorePort>) {
  describe(`ImageRuleStorePort contract: ${name}`, () => {
    const rules = useFixture(factory);

    it("starts empty with the general setting at ask", async () => {
      expect(await rules().list()).toEqual([]);
      expect(await rules().get("address", "news@shop.example")).toBeNull();
      expect(await rules().getGeneral()).toBe("ask");
    });

    it("round-trips a rule, and tells an address from a domain of the same text", async () => {
      await rules().put(imageRule());
      await rules().put(imageRule({ scope: "domain", value: "shop.example", decision: "deny" }));
      expect(await rules().get("address", "news@shop.example")).toEqual(imageRule());
      expect((await rules().get("domain", "shop.example"))?.decision).toBe("deny");
      expect(await rules().get("address", "shop.example")).toBeNull();
    });

    it("replaces by scope and value, so an allow takes the place of a deny", async () => {
      await rules().put(imageRule({ decision: "deny", createdMs: 1 }));
      await rules().put(imageRule({ decision: "allow", createdMs: 2 }));
      expect(await rules().list()).toEqual([imageRule({ decision: "allow", createdMs: 2 })]);
    });

    it("lists the newest first, then by scope and value", async () => {
      await rules().put(imageRule({ value: "b@x.example", createdMs: 5 }));
      await rules().put(imageRule({ value: "a@x.example", createdMs: 5 }));
      await rules().put(imageRule({ scope: "domain", value: "x.example", createdMs: 5 }));
      await rules().put(imageRule({ value: "old@x.example", createdMs: 1 }));
      await rules().put(imageRule({ value: "new@x.example", createdMs: 9 }));
      expect((await rules().list()).map((r) => `${r.scope}:${r.value}`)).toEqual([
        "address:new@x.example",
        "address:a@x.example",
        "address:b@x.example",
        "domain:x.example",
        "address:old@x.example",
      ]);
    });

    it("removes a rule and says whether it was there", async () => {
      await rules().put(imageRule());
      expect(await rules().remove("address", "news@shop.example")).toBe(true);
      expect(await rules().remove("address", "news@shop.example")).toBe(false);
      expect(await rules().list()).toEqual([]);
    });

    it("adds only the rules that are not there yet, and counts them", async () => {
      await rules().put(imageRule({ decision: "deny", createdMs: 1 }));
      const added = await rules().putIfAbsent([
        imageRule({ decision: "allow", createdMs: 2 }),
        imageRule({ value: "other@shop.example", createdMs: 2 }),
      ]);
      expect(added).toBe(1);
      expect((await rules().get("address", "news@shop.example"))?.decision).toBe("deny");
      expect(await rules().get("address", "other@shop.example")).not.toBeNull();
      expect(await rules().putIfAbsent([])).toBe(0);
    });

    it("keeps the general setting", async () => {
      await rules().setGeneral("always");
      expect(await rules().getGeneral()).toBe("always");
      await rules().setGeneral("ask");
      expect(await rules().getGeneral()).toBe("ask");
    });
  });
}

/** ADR 0028. The index writes people with the documents; `suggest` reads them back. */
export function describePeopleContract(
  name: string,
  factory: Factory<SearchIndexPort & PeoplePort>,
) {
  describe(`PeoplePort contract: ${name}`, () => {
    const index = useFixture(factory);
    const mail = (n: number, from: Participant, to: Participant[] = [], cc: Participant[] = []) =>
      makeDocument({ dateMs: day(n), from, to, cc, subject: `mail ${n}` }, "text");
    const jan = person("Jan Kowalski", "jan@lodz.pl");
    const lukasz = person("Łukasz Żółć", "lukasz@zrodlo.pl");
    const anna = person("Anna Nowak", "anna@example.com");
    const addresses = async (prefix: string, limit = 10) =>
      (await index().suggest(prefix, limit)).map((p) => p.address);

    it("ranks everyone by count when nothing is typed, and only people with mail", async () => {
      await index().indexMessages([mail(1, jan, [anna]), mail(2, jan), mail(3, lukasz)]);
      const found = (await index().frequent(10)).map((p) => p.address);
      expect(found[0]).toBe("jan@lodz.pl");
      expect(found).toContain("lukasz@zrodlo.pl");
      expect(found).toContain("anna@example.com");
      expect(await index().frequent(1)).toHaveLength(1);
      expect(await index().frequent(0)).toEqual([]);
    });

    it("reads one person by address: count, newest date, latest name (ADR 0078)", async () => {
      await index().indexMessages([mail(1, jan, [anna]), mail(5, anna, [jan]), mail(3, jan)]);
      expect(await index().person("Jan@Lodz.PL ")).toEqual({
        address: "jan@lodz.pl",
        name: "Jan Kowalski",
        count: 3,
        lastMs: day(5),
      });
      expect((await index().person("anna@example.com"))?.count).toBe(2);
      expect(await index().person("nobody@nowhere.org")).toBeUndefined();
      expect(await index().person("")).toBeUndefined();
    });

    it("finds a person by a prefix of a word of the name or of the address", async () => {
      await index().indexMessages([mail(1, jan, [anna])]);
      expect(await addresses("kow")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("J")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("lod")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("nowak")).toEqual(["anna@example.com"]);
      expect(await addresses("owak")).toEqual([]);
      expect(await addresses("zzz")).toEqual([]);
    });

    it("answers with the latest name, the address in lower case and the count", async () => {
      await index().indexMessages([
        mail(1, person("", "Jan@Lodz.PL"), [anna]),
        mail(2, anna, [person("", "Jan@Lodz.PL")]),
      ]);
      expect(await index().suggest("jan", 5)).toEqual([{ address: "jan@lodz.pl", count: 2 }]);
      expect(await index().suggest("anna", 5)).toEqual([
        { address: "anna@example.com", name: "Anna Nowak", count: 2 },
      ]);
    });

    it("counts a message once per address, however often it names it", async () => {
      await index().indexMessages([mail(1, jan, [jan, anna], [jan])]);
      expect((await index().suggest("jan", 5))[0]?.count).toBe(1);
    });

    it("folds the input and the stored words alike", async () => {
      await index().indexMessages([mail(1, lukasz, [jan])]);
      for (const typed of ["lukasz", "Łuk", "zol", "ŻÓŁ", "zrodlo", "źró"]) {
        expect(await addresses(typed), typed).toEqual(["lukasz@zrodlo.pl"]);
      }
    });

    it("requires every typed word to start a word of the person", async () => {
      await index().indexMessages([mail(1, jan, [anna])]);
      expect(await addresses("jan kow")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("jan.kow")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("jan nowak")).toEqual([]);
    });

    it("ranks by messages, then by the latest message", async () => {
      const bob = person("Bob Test", "bob@test.org");
      const bea = person("Bea Test", "bea@test.org");
      const bia = person("Bia Test", "bia@test.org");
      await index().indexMessages([
        mail(1, bob),
        mail(2, bea),
        mail(3, bea),
        mail(4, bia, [bob]),
        mail(5, bia),
        mail(6, bia),
      ]);
      // bia 3, bea 2 (latest 3), bob 2 (latest 4)
      expect(await addresses("b")).toEqual(["bia@test.org", "bob@test.org", "bea@test.org"]);
      expect(await addresses("test")).toEqual(["bia@test.org", "bob@test.org", "bea@test.org"]);
    });

    it("caps the answer at the limit and gives nothing for no words", async () => {
      await index().indexMessages([mail(1, jan, [anna, lukasz])]);
      expect(await index().suggest("", 5)).toEqual([]);
      expect(await index().suggest("  ", 5)).toEqual([]);
      expect(await index().suggest("***", 5)).toEqual([]);
      expect(await index().suggest("pl", 0)).toEqual([]);
      expect(await addresses("pl", 1)).toHaveLength(1);
      expect(await addresses("pl", 10)).toHaveLength(2);
    });

    it("takes the name of the newest message that has one", async () => {
      await index().indexMessages([mail(2, person("Jan K.", "jan@lodz.pl"))]);
      await index().indexMessages([mail(3, person("Jan Kowalski", "jan@lodz.pl"))]);
      await index().indexMessages([mail(1, person("Johnny", "jan@lodz.pl"))]);
      await index().indexMessages([mail(4, { address: "jan@lodz.pl" })]);
      const [found] = await index().suggest("jan", 5);
      expect(found?.name).toBe("Jan Kowalski");
      expect(await addresses("kowalski")).toEqual(["jan@lodz.pl"]);
    });

    it("stops suggesting a person once no mail names them", async () => {
      const first = mail(1, jan, [anna]);
      const second = mail(2, jan);
      await index().indexMessages([first, second]);
      await index().removeMessages([first.message.key]);
      expect(await addresses("jan")).toEqual(["jan@lodz.pl"]);
      expect(await addresses("anna")).toEqual([]);
      await index().removeMessages([second.message.key]);
      expect(await addresses("jan")).toEqual([]);
      await index().indexMessages([second]);
      expect(await addresses("jan")).toEqual(["jan@lodz.pl"]);
    });

    it("finds a person named only as a recipient or in cc", async () => {
      await index().indexMessages([mail(1, jan, [], [anna])]);
      expect(await addresses("anna")).toEqual(["anna@example.com"]);
    });

    it.each([
      '"',
      '""',
      '"jan',
      "jan*",
      "jan OR anna",
      'jan" OR "anna',
      "NEAR(jan anna)",
      "{sender}: jan",
      "-jan",
      "(",
      "'; DROP TABLE people; --",
      "\u0000",
      "💥",
      "a".repeat(5000),
    ])("treats hostile input as plain text: %s", async (typed) => {
      await index().indexMessages([mail(1, jan, [anna])]);
      const found = await index().suggest(typed, 5);
      expect(found.length).toBeLessThanOrEqual(1);
      expect(await addresses("jan")).toEqual(["jan@lodz.pl"]);
    });

    it("skips an address with no letter or digit in it", async () => {
      await index().indexMessages([mail(1, person("Ghost", "@@@"), [jan])]);
      expect(await addresses("ghost")).toEqual([]);
      expect(await addresses("jan")).toEqual(["jan@lodz.pl"]);
    });
  });
}

/** What a claim needs of the files of a draft (ADR 0041, rule 7). */
export interface OutboxWithAttachments {
  readonly outbox: OutboxPort;
  readonly attachments: AttachmentStorePort;
}

export function describeOutboxAttachmentsContract(
  name: string,
  factory: Factory<OutboxWithAttachments>,
) {
  describe(`OutboxPort and files contract: ${name}`, () => {
    const rig = useFixture(factory);
    const file = (id: string, draftId: string, state: StoredAttachment["state"]) =>
      attachmentRow({ id, draftId, state });

    it("does not claim a send while a file of its draft is still being read", async () => {
      const { outbox, attachments } = rig();
      await outbox.enqueue(opAt("waits", 1000, { windowMs: 0, draftId: "d1" }));
      await outbox.enqueue(opAt("free", 1001, { windowMs: 0, draftId: "d2" }));
      await attachments.add(file("f1", "d1", "reading"));
      await attachments.add(file("f2", "d1", "ready"));
      expect(await outbox.claimNext(2000, "small")).toMatchObject({ id: "free" });
      expect(await outbox.claimNext(2000, "small")).toBeNull();
      // the wait is not a time to wake for: the file's end wakes the runner
      expect(await outbox.nextDueMs("small")).toBeNull();

      const row = (await attachments.get("f1")) as StoredAttachment;
      await attachments.update({ ...row, state: "ready", sha256: "a".repeat(64) });
      expect(await outbox.nextDueMs("small")).toBe(1000);
      expect(await outbox.claimNext(2000, "small")).toMatchObject({ id: "waits" });
    });

    it("a failed file does not hold the send back: the use case fails it", async () => {
      const { outbox, attachments } = rig();
      await outbox.enqueue(opAt("o1", 1000, { windowMs: 0, draftId: "d1" }));
      await attachments.add(file("f1", "d1", "failed"));
      expect(await outbox.claimNext(2000, "small")).toMatchObject({ id: "o1" });
    });

    it("the large lane honours the wait too", async () => {
      const { outbox, attachments } = rig();
      await outbox.enqueue(
        opAt("o1", 1000, { windowMs: 0, draftId: "d1", encodedBytes: 5_000_000 }),
      );
      await attachments.add(file("f1", "d1", "reading"));
      expect(await outbox.claimNext(2000, "large")).toBeNull();
      expect(await outbox.nextDueMs("large")).toBeNull();
    });
  });
}

export const attachmentRow = (over: Partial<StoredAttachment> = {}): StoredAttachment => ({
  id: "f1",
  draftId: "d1",
  accountId: "acc1",
  name: "report.pdf",
  size: 1234,
  state: "ready",
  reason: null,
  sha256: "b".repeat(64),
  sourcePath: "/Users/me/report.pdf",
  sourceMtimeMs: 1_700_000_000_123.5,
  origin: null,
  createdAtMs: 100,
  ...over,
});

export function describeAttachmentStoreContract(
  name: string,
  factory: Factory<AttachmentStorePort>,
) {
  describe(`AttachmentStorePort contract: ${name}`, () => {
    const store = useFixture(factory);

    it("stores a row and returns it unchanged, fractional modification time included", async () => {
      const a = attachmentRow();
      await store().add(a);
      expect(await store().get("f1")).toEqual(a);
      expect(await store().get("nope")).toBeNull();
      const bare = attachmentRow({
        id: "f2",
        state: "reading",
        sha256: null,
        sourcePath: null,
        sourceMtimeMs: null,
      });
      await store().add(bare);
      expect(await store().get("f2")).toEqual(bare);
    });

    it("keeps where a forwarded file came from, apart from the path of an ordinary one (ADR 0045)", async () => {
      const forwarded = attachmentRow({
        id: "fw",
        state: "reading",
        sha256: null,
        sourcePath: null,
        sourceMtimeMs: null,
        origin: { messageKey: 1_744_965_242_880_000, partId: "2.1" },
      });
      await store().add(forwarded);
      await store().add(attachmentRow({ id: "own" }));
      expect(await store().get("fw")).toEqual(forwarded);
      expect((await store().get("own"))?.origin).toBeNull();
      expect((await store().get("own"))?.sourcePath).toBe("/Users/me/report.pdf");
      expect((await store().forDraft("d1")).map((r) => [r.id, r.origin !== null])).toEqual([
        ["fw", true],
        ["own", false],
      ]);
      expect((await store().listByState(["reading"])).map((r) => r.origin?.partId)).toEqual([
        "2.1",
      ]);
    });

    it("moves every row of a draft to an account, and an update never moves one back (ADR 0050)", async () => {
      const reading = attachmentRow({ id: "f1", state: "reading" });
      await store().add(reading);
      await store().add(attachmentRow({ id: "f2" }));
      await store().add(attachmentRow({ id: "other", draftId: "d2" }));
      await store().moveDraft("d1", "acc2");
      expect((await store().get("f1"))?.accountId).toBe("acc2");
      expect((await store().get("f2"))?.accountId).toBe("acc2");
      expect((await store().get("other"))?.accountId).toBe("acc1");
      // A copy that was running writes the row it read before the move.
      await store().update({ ...reading, state: "ready" });
      expect(await store().get("f1")).toMatchObject({ state: "ready", accountId: "acc2" });
      await store().discardAccount("acc1");
      expect(await store().get("f1")).not.toBeNull();
      expect(await store().get("other")).toBeNull();
    });

    it("keeps the origin when a forwarded file is updated as it ends", async () => {
      const origin = { messageKey: 42, partId: "3" };
      const reading = attachmentRow({
        id: "fw",
        state: "reading",
        sha256: null,
        sourcePath: null,
        sourceMtimeMs: null,
        origin,
      });
      await store().add(reading);
      await store().update({ ...reading, state: "ready", sha256: "d".repeat(64), size: 777 });
      expect(await store().get("fw")).toMatchObject({ state: "ready", size: 777, origin });
      await store().update({ ...reading, state: "failed", reason: "No longer on the server" });
      expect(await store().get("fw")).toMatchObject({
        state: "failed",
        reason: "No longer on the server",
        origin,
      });
    });

    it("refuses an id that exists", async () => {
      await store().add(attachmentRow());
      await expect(store().add(attachmentRow({ name: "other.pdf" }))).rejects.toBeDefined();
      expect((await store().get("f1"))?.name).toBe("report.pdf");
    });

    it("lists the files of a draft in the order they were added", async () => {
      await store().add(attachmentRow({ id: "z", createdAtMs: 3 }));
      await store().add(attachmentRow({ id: "a", createdAtMs: 1 }));
      await store().add(attachmentRow({ id: "m", draftId: "d2" }));
      expect((await store().forDraft("d1")).map((r) => r.id)).toEqual(["z", "a"]);
      expect((await store().forDraft("d2")).map((r) => r.id)).toEqual(["m"]);
      expect(await store().forDraft("none")).toEqual([]);
    });

    it("replaces a row, and skips an unknown id", async () => {
      await store().add(attachmentRow({ state: "reading", sha256: null, sourceMtimeMs: null }));
      await store().update(
        attachmentRow({ state: "failed", reason: "Can't read this file", sha256: null }),
      );
      expect(await store().get("f1")).toMatchObject({
        state: "failed",
        reason: "Can't read this file",
      });
      await store().update(attachmentRow({ id: "ghost" }));
      expect(await store().get("ghost")).toBeNull();
    });

    it("removes rows, unknown ids skipped", async () => {
      await store().add(attachmentRow({ id: "a" }));
      await store().add(attachmentRow({ id: "b" }));
      await store().remove(["a", "nope"]);
      expect(await store().allIds()).toEqual(["b"]);
    });

    it("lists by state, oldest first", async () => {
      await store().add(attachmentRow({ id: "a", state: "reading" }));
      await store().add(attachmentRow({ id: "b", state: "ready" }));
      await store().add(attachmentRow({ id: "c", state: "reading", draftId: "d2" }));
      await store().add(attachmentRow({ id: "d", state: "tooLarge" }));
      expect((await store().listByState(["reading"])).map((r) => r.id)).toEqual(["a", "c"]);
      expect((await store().listByState(["ready", "tooLarge"])).map((r) => r.id)).toEqual([
        "b",
        "d",
      ]);
      expect(await store().listByState([])).toEqual([]);
    });

    it("drops the rows of one account", async () => {
      await store().add(attachmentRow({ id: "a" }));
      await store().add(attachmentRow({ id: "b", accountId: "acc2" }));
      await store().discardAccount("acc1");
      expect(await store().allIds()).toEqual(["b"]);
    });
  });
}

const folderOf = (
  id: string,
  role: LabelRole,
  over: Partial<Pick<Label, "name" | "exclusive">> = {},
): Label => ({
  id,
  accountId: "acc1",
  name: over.name ?? id,
  role,
  exclusive: over.exclusive ?? true,
});

/** Where mail is and how it is moved (ADR 0044). Both stores must give the same answers. */
export function describeMoveContract(name: string, factory: Factory<UnitOfWorkHarness>) {
  describe(`Moving mail contract: ${name}`, () => {
    const h = useFixture(factory);
    const ACC = "acc1";
    const FOLDERS = [
      folderOf("INBOX", "inbox"),
      folderOf("Archive", "archive"),
      folderOf("Trash", "trash", { name: "Kosz" }),
      folderOf("Junk", "spam"),
      folderOf("Sent", "sent"),
      folderOf("Clients", "other"),
    ];
    let clock = 1000;
    let ids = 0;
    const deps = () => ({ ...h(), now: () => clock, newId: () => `op${++ids}` });
    const apply = (folderId: string, batch: Partial<SyncBatch>) =>
      applySyncBatch(h(), { accountId: ACC, folderId, batch: makeSyncBatch(batch) });
    const read = async (providerId: string) => {
      const key = (await h().store.findByProviderIds(ACC, [providerId])).get(providerId);
      return key === undefined ? undefined : (await h().read.store.getByKeys([key]))[0];
    };
    const find = (q: string) => h().read.index.search(parseQuery(q), { limit: 50 });
    const keyOf = async (providerId: string) => (await read(providerId))?.key as number;

    beforeEach(async () => {
      clock = 1000;
      ids = 0;
      await h().store.setFolders(ACC, FOLDERS);
    });

    /** A message found in a folder, in a thread of its own unless told. */
    async function put(
      providerId: string,
      folder: string,
      uid: number,
      over: Parameters<typeof makeDocument>[0] = {},
    ) {
      const d = makeDocument(
        { dateMs: day(uid), providerId, threadId: `t-${providerId}`, ...over },
        `body ${providerId}`,
      );
      await apply(folder, { documents: [syncedDoc(d, uid, folder)], cursor: { uid } });
      return keyOf(providerId);
    }
    /** A copy of a stored message in another folder, as sync reports it. */
    const copy = (providerId: string, folder: string, uid: number) =>
      apply(folder, {
        knownLocations: [
          {
            providerId,
            location: makeLocation(uid, folder),
            flags: flags(),
          },
        ],
        cursor: { uid },
      });

    describe("folders and mailboxes", () => {
      it("keeps the folders of an account, by id, and forgets them with the account", async () => {
        expect((await h().store.listFolders(ACC)).map((f) => f.id)).toEqual([
          "Archive",
          "Clients",
          "INBOX",
          "Junk",
          "Sent",
          "Trash",
        ]);
        expect(await h().store.listFolders("other")).toEqual([]);
        await put("p1", "INBOX", 1);
        await h().store.removeAccountMessages(ACC);
        expect(await h().store.listFolders(ACC)).toEqual([]);
      });

      it("says where mail is from its folders, and sets it again when a folder changes", async () => {
        await put("in", "INBOX", 1);
        await put("old", "Archive", 2);
        await put("bin", "Trash", 3);
        await put("ad", "Junk", 4);
        await put("mine", "Sent", 5);
        await put("co", "Clients", 6);
        const bits = async (id: string) => (await read(id))?.mailboxes;
        expect(await bits("in")).toBe(MAILBOX_BIT.inbox);
        expect(await bits("old")).toBe(MAILBOX_BIT.archive);
        expect(await bits("bin")).toBe(MAILBOX_BIT.trash);
        expect(await bits("ad")).toBe(MAILBOX_BIT.spam);
        expect(await bits("mine")).toBe(MAILBOX_BIT.sent);
        expect(await bits("co")).toBe(MAILBOX_BIT.other);

        // The same list again changes nothing and announces nothing.
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        expect(await h().store.setFolders(ACC, FOLDERS)).toEqual([]);
        expect((await h().read.store.changesSince(0)).changeSeq).toBe(seq);

        // A folder that turns out to be the Trash changes the mail in it, and only that.
        const changed = await h().store.setFolders(
          ACC,
          FOLDERS.map((f) => (f.id === "Clients" ? { ...f, role: "trash" as const } : f)),
        );
        expect(changed).toEqual([await keyOf("co")]);
        expect(await bits("co")).toBe(MAILBOX_BIT.trash);
        expect((await h().read.store.changesSince(seq)).changedKeys).toEqual(changed);
      });

      it("reads a message in two folders as in both", async () => {
        await put("two", "INBOX", 1);
        await copy("two", "Archive", 2);
        expect((await read("two"))?.mailboxes).toBe(MAILBOX_BIT.inbox | MAILBOX_BIT.archive);
        await apply("INBOX", { removedLocations: [makeLocation(1)], cursor: { uid: 3 } });
        expect((await read("two"))?.mailboxes).toBe(MAILBOX_BIT.archive);
      });

      it("reads mail of an account with labels from its labels and the folder of the copy", async () => {
        const gmail = [
          folderOf("All", "archive", { exclusive: false }),
          folderOf("GTrash", "trash", { exclusive: false }),
          folderOf("GSpam", "spam", { exclusive: false }),
        ];
        await h().store.setFolders(ACC, gmail);
        const labelled = async (id: string, folder: string, uid: number, labels: string[]) => {
          const d = makeDocument({ dateMs: day(uid), providerId: id, labelIds: labels }, id);
          await applySyncBatch(h(), {
            accountId: ACC,
            folderId: folder,
            labelSource: "provider",
            batch: makeSyncBatch({
              documents: [syncedDoc(d, uid, folder)],
              cursor: { uid },
            }),
          });
          return read(id);
        };
        expect((await labelled("g1", "All", 1, ["inbox"]))?.mailboxes).toBe(MAILBOX_BIT.inbox);
        expect((await labelled("g2", "All", 2, ["Clients"]))?.mailboxes).toBe(
          MAILBOX_BIT.archive | MAILBOX_BIT.other,
        );
        expect((await labelled("g3", "All", 3, ["sent"]))?.mailboxes).toBe(
          MAILBOX_BIT.archive | MAILBOX_BIT.sent,
        );
        expect((await labelled("g4", "GTrash", 4, []))?.mailboxes).toBe(MAILBOX_BIT.trash);
        expect((await labelled("g5", "GSpam", 5, []))?.mailboxes).toBe(MAILBOX_BIT.spam);

        // Setting every message again at once (a folder was renamed) gives what each was given
        // one by one: the two ways of working it out must agree.
        const all = ["g1", "g2", "g3", "g4", "g5"];
        const was = await Promise.all(all.map(async (id) => (await read(id))?.mailboxes));
        const changed = await h().store.setFolders(
          ACC,
          gmail.map((f) => ({ ...f, name: `${f.name} renamed` })),
        );
        expect(changed).toEqual([]);
        expect(await Promise.all(all.map(async (id) => (await read(id))?.mailboxes))).toEqual(was);
      });
    });

    describe("what All mail and a search leave out (rule 3)", () => {
      beforeEach(async () => {
        await put("in", "INBOX", 1, { subject: "hello inbox" });
        await put("bin", "Trash", 2, { subject: "hello deleted" });
        await put("ad", "Junk", 3, { subject: "hello advert" });
        await put("old", "Archive", 4, { subject: "hello archive" });
      });
      const subjects = async (q: string) =>
        (await h().read.store.getByKeys(await find(q))).map((m) => m.subject);

      it("lists the newest without Trash and Spam, and with them when a label is asked for", async () => {
        const all = await h().read.store.listNewest({ limit: 10 });
        expect(all.map((m) => m.subject)).toEqual(["hello archive", "hello inbox"]);
        const before = await h().read.store.listNewest({
          limit: 10,
          beforeKey: await keyOf("old"),
        });
        expect(before.map((m) => m.subject)).toEqual(["hello inbox"]);
        expect(
          (await h().read.store.listNewest({ limit: 10, labelId: "Trash" })).map((m) => m.subject),
        ).toEqual(["hello deleted"]);
      });

      it("leaves them out of every search that does not ask for them", async () => {
        expect(await subjects("hello")).toEqual(["hello archive", "hello inbox"]);
        expect(await subjects("is:unread")).toEqual(["hello archive", "hello inbox"]);
        expect(await subjects("hello -in:inbox")).toEqual(["hello archive"]);
        expect(await subjects("-in:trash")).toEqual(["hello archive", "hello inbox"]);
        expect(await subjects("hello OR from:sender")).toEqual(["hello archive", "hello inbox"]);
      });

      it("finds them with in: and with the label that names their folder", async () => {
        expect(await subjects("in:trash")).toEqual(["hello deleted"]);
        expect(await subjects("in:spam")).toEqual(["hello advert"]);
        expect(await subjects("in:trash hello")).toEqual(["hello deleted"]);
        expect(await subjects("in:trash OR in:spam")).toEqual(["hello advert", "hello deleted"]);
        // A label is the id of the folder (here its name is "Kosz"): naming it asks for its mail.
        expect(await subjects("label:trash")).toEqual(["hello deleted"]);
        expect(await subjects("label:junk")).toEqual(["hello advert"]);
        expect(await subjects("label:inbox")).toEqual(["hello inbox"]);
      });

      it("names the other places with in:", async () => {
        expect(await subjects("in:inbox")).toEqual(["hello inbox"]);
        expect(await subjects("in:archive")).toEqual(["hello archive"]);
        expect(await subjects("in:sent")).toEqual([]);
      });

      it("shows a thread without its deleted messages unless it is asked for whole", async () => {
        await put("a", "INBOX", 5, { threadId: "mix", subject: "mix one" });
        await put("b", "Trash", 6, { threadId: "mix", subject: "mix two" });
        const keys = async (visibleOnly: boolean) =>
          (await h().read.store.getThread("mix", { visibleOnly }))?.messages.map((m) => m.subject);
        expect(await keys(true)).toEqual(["mix one"]);
        expect(await keys(false)).toEqual(["mix one", "mix two"]);
        const whole = await h().read.store.getThread("mix");
        expect(whole?.messages).toHaveLength(2);
        expect(whole?.thread.unreadCount).toBe(2);
        expect(
          (await h().read.store.getThread("mix", { visibleOnly: true }))?.thread.unreadCount,
        ).toBe(1);
        // A thread with nothing left to show is none.
        expect(await h().read.store.getThread("t-bin", { visibleOnly: true })).toBeNull();
      });
    });

    describe("moving a thread (rules 5, 8 and 9)", () => {
      it("changes the labels and the mailboxes and records the request in one unit", async () => {
        const key = await put("m1", "INBOX", 1);
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        const result = await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        expect(result.keys).toEqual([key]);
        expect(result.operationId).toBe("op1");
        const m = await read("m1");
        expect(m?.labelIds).toEqual(["Archive"]);
        expect(m?.mailboxes).toBe(MAILBOX_BIT.archive);
        expect((await h().read.store.changesSince(seq)).changedKeys).toEqual([key]);
        expect(await find("in:inbox")).toEqual([]);
        expect(await find("in:archive")).toEqual([key]);
        expect(await h().moveOps.listPending()).toEqual([
          expect.objectContaining({
            key,
            accountId: ACC,
            operationId: "op1",
            action: "archive",
            target: "role:archive",
            labelsBefore: ["INBOX"],
            mailboxesBefore: MAILBOX_BIT.inbox,
            attempts: 0,
            nextAttemptMs: 11_000,
            rev: 1,
          }),
        ]);
        // The copy on the server is still where it was until the push says otherwise.
        expect(await h().store.getLocations(key)).toEqual([makeLocation(1)]);
      });

      it("leaves a failed unit with neither the labels nor the request", async () => {
        const key = await put("m1", "INBOX", 1);
        await expect(
          h().uow.run(async () => {
            await moveThread(deps(), { threadId: "t-m1", action: "archive" });
            throw new Error("boom");
          }),
        ).rejects.toThrow("boom");
        expect((await read("m1"))?.labelIds).toEqual(["INBOX"]);
        expect(await h().moveOps.listPending()).toEqual([]);
        expect(key).toBeDefined();
      });

      it("takes the whole thread but not Sent and Drafts, and Delete takes those too", async () => {
        await put("a", "INBOX", 1, { threadId: "T" });
        await put("b", "Sent", 2, { threadId: "T" });
        await put("c", "Clients", 3, { threadId: "T" });
        const archived = await moveThread(deps(), { threadId: "T", action: "archive" });
        expect(archived.keys).toEqual([await keyOf("a"), await keyOf("c")]);
        expect((await read("b"))?.labelIds).toEqual(["Sent"]);
        expect((await read("a"))?.labelIds).toEqual(["Archive"]);
        expect((await read("c"))?.labelIds).toEqual(["Archive"]);

        await put("d", "Sent", 4, { threadId: "U" });
        await put("e", "INBOX", 5, { threadId: "U" });
        const deleted = await moveThread(deps(), { threadId: "U", action: "delete" });
        expect(deleted.keys).toHaveLength(2);
        expect((await read("d"))?.labelIds).toEqual(["Trash"]);
        expect((await read("d"))?.mailboxes).toBe(MAILBOX_BIT.trash);
        expect(await find("in:sent")).toEqual([await keyOf("b")]);
      });

      it("leaves a message that is only at the target alone, and says so", async () => {
        await put("a", "Archive", 1);
        const none = await moveThread(deps(), { threadId: "t-a", action: "archive" });
        expect(none).toMatchObject({ operationId: null, keys: [] });
        expect(await h().moveOps.listPending()).toEqual([]);
        // Only Sent in the thread: nothing to take either.
        await put("s", "Sent", 2);
        expect(
          (await moveThread(deps(), { threadId: "t-s", action: "spam" })).operationId,
        ).toBeNull();
        expect((await read("s"))?.labelIds).toEqual(["Sent"]);
      });

      it("moves a message with copies in two folders out of both", async () => {
        const key = await put("two", "INBOX", 1);
        await copy("two", "Clients", 2);
        expect([...((await read("two"))?.labelIds ?? [])].sort()).toEqual(["Clients", "INBOX"]);
        await moveThread(deps(), {
          threadId: "t-two",
          action: "move",
          target: { role: "archive" },
        });
        expect((await read("two"))?.labelIds).toEqual(["Archive"]);
        expect((await h().moveOps.listPending())[0]).toMatchObject({
          key,
          labelsBefore: expect.arrayContaining(["INBOX", "Clients"]),
        });
      });

      it("leaves the messages in Trash and Spam out of a thread unless it is looked at from there", async () => {
        await put("a", "INBOX", 1, { threadId: "M" });
        await put("b", "Trash", 2, { threadId: "M" });
        const seen = await moveThread(deps(), { threadId: "M", action: "archive" });
        expect(seen.keys).toEqual([await keyOf("a")]);
        expect((await read("b"))?.labelIds).toEqual(["Trash"]);
        const from = await moveThread(deps(), { threadId: "M", action: "archive", hidden: true });
        expect(from.keys).toEqual([await keyOf("b")]);
        expect((await read("b"))?.labelIds).toEqual(["Archive"]);
      });

      it("keeps the first 'before' when a newer request replaces a pending one", async () => {
        const key = await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        clock += 2000;
        await moveThread(deps(), { threadId: "t-m1", action: "delete" });
        const [row] = await h().moveOps.listPending();
        expect(row).toMatchObject({
          key,
          operationId: "op2",
          action: "delete",
          target: "role:trash",
          labelsBefore: ["INBOX"],
          mailboxesBefore: MAILBOX_BIT.inbox,
          rev: 2,
          nextAttemptMs: 13_000,
        });
        expect((await read("m1"))?.mailboxes).toBe(MAILBOX_BIT.trash);
        // Undo goes back to what the server has: the inbox, not the archive between.
        expect(await undoMove(deps(), "op2")).toMatchObject({ kind: "undone", keys: [key] });
        expect(await read("m1")).toMatchObject({
          labelIds: ["INBOX"],
          mailboxes: MAILBOX_BIT.inbox,
        });
        expect(await undoMove(deps(), "op1")).toEqual({ kind: "gone" });
      });
    });

    describe("taking it back (rule 10)", () => {
      it("puts back exactly the labels and mailboxes, with a change of its own", async () => {
        const key = await put("two", "INBOX", 1);
        await copy("two", "Clients", 2);
        const before = await read("two");
        await moveThread(deps(), { threadId: "t-two", action: "delete" });
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        clock += 5000;
        const result = await undoMove(deps(), "op1");
        expect(result).toMatchObject({ kind: "undone", keys: [key] });
        expect(await read("two")).toEqual(before);
        expect((await h().read.store.changesSince(seq)).changedKeys).toEqual([key]);
        expect(await h().moveOps.listPending()).toEqual([]);
      });

      it("is too late once the window is over, and touches nothing", async () => {
        await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        clock += 10_000;
        expect(await undoMove(deps(), "op1")).toEqual({ kind: "tooLate" });
        expect((await read("m1"))?.labelIds).toEqual(["Archive"]);
        expect(await h().moveOps.listPending()).toHaveLength(1);
      });

      it("is too late for a row that has been tried, whatever its time says", async () => {
        await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        const [row] = await h().moveOps.listPending();
        await h().moveOps.defer([
          { operation: row as NonNullable<typeof row>, nextAttemptMs: 99_000 },
        ]);
        expect(await undoMove(deps(), "op1")).toEqual({ kind: "tooLate" });
        expect((await read("m1"))?.labelIds).toEqual(["Archive"]);
      });

      it("undoes a whole action or none of it", async () => {
        await put("a", "INBOX", 1, { threadId: "T" });
        await put("b", "INBOX", 2, { threadId: "T" });
        await moveThread(deps(), { threadId: "T", action: "archive" });
        const [first] = await h().moveOps.listPending();
        // One row is past its window: the other is not taken back alone.
        await h().moveOps.defer([
          { operation: first as NonNullable<typeof first>, nextAttemptMs: 5 },
        ]);
        expect(await undoMove(deps(), "op1")).toEqual({ kind: "tooLate" });
        expect(await h().moveOps.listPending()).toHaveLength(2);
      });
    });

    describe("a sync that was built before the push (rule 12)", () => {
      it("puts the move back over what the batch wrote, so no reader sees the old place", async () => {
        const key = await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        // The server still has it in the inbox: a flag update and the same document again.
        const d = makeDocument({ dateMs: day(1), providerId: "m1", threadId: "t-m1" }, "body m1");
        const seen: string[][] = [];
        const result = await apply("INBOX", {
          documents: [syncedDoc(d, 1)],
          flagUpdates: [{ location: makeLocation(1), flags: flags({ flagged: true }) }],
          cursor: { uid: 9 },
        });
        expect(result.movesRestored).toBe(1);
        const m = await read("m1");
        seen.push([...(m?.labelIds ?? [])]);
        expect(seen).toEqual([["Archive"]]);
        expect(m).toMatchObject({ mailboxes: MAILBOX_BIT.archive, flags: { flagged: true } });
        expect(await find("in:inbox")).toEqual([]);
        expect(key).toBe(await keyOf("m1"));
      });

      it("does nothing, and announces nothing, when no move is pending or it is in place", async () => {
        await put("m1", "INBOX", 1);
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        expect(await reapplyPendingMoves(h(), ACC)).toEqual([]);
        expect((await h().read.store.changesSince(0)).changeSeq).toBe(seq);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        const after = (await h().read.store.changesSince(0)).changeSeq;
        expect(await reapplyPendingMoves(h(), ACC)).toEqual([]);
        expect((await h().read.store.changesSince(0)).changeSeq).toBe(after);
      });

      it("holds through a folder list that sync writes again", async () => {
        await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "delete" });
        const changed = await h().uow.run(async () => {
          // A folder's role changes while the move is pending: the mailboxes follow, then the move.
          await h().store.setFolders(
            ACC,
            FOLDERS.map((f) => (f.id === "Clients" ? { ...f, name: "Clients 2" } : f)),
          );
          return reapplyPendingMoves(h(), ACC);
        });
        expect(changed).toEqual([]);
        expect((await read("m1"))?.mailboxes).toBe(MAILBOX_BIT.trash);
      });
    });

    describe("the server's answer (rules 13 and 15)", () => {
      it("swaps the location for the new one without losing the message, and settles", async () => {
        const key = await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        const [row] = await h().moveOps.listPending();
        await finishMoves(
          h(),
          [row as NonNullable<typeof row>],
          [{ key, from: makeLocation(1), to: makeLocation(77, "Archive") }],
        );
        expect(await h().store.getLocations(key)).toEqual([makeLocation(77, "Archive")]);
        expect((await read("m1"))?.key).toBe(key);
        expect(await h().moveOps.listPending()).toEqual([]);
        // The message is still found, its body is still there.
        expect((await h().read.bodies.getBodies([key])).get(key)).toBe("body m1");
        expect(await find("m1")).toEqual([key]);
      });

      it("keeps the old location when the server did not say where the copy went", async () => {
        const key = await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        const [row] = await h().moveOps.listPending();
        await finishMoves(h(), [row as NonNullable<typeof row>]);
        expect(await h().store.getLocations(key)).toEqual([makeLocation(1)]);
        expect((await read("m1"))?.labelIds).toEqual(["Archive"]);
      });

      it("does not undo a newer request when the old one is settled late", async () => {
        const key = await put("m1", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-m1", action: "archive" });
        const [old] = await h().moveOps.listPending();
        await moveThread(deps(), { threadId: "t-m1", action: "delete" });
        await finishMoves(h(), [old as NonNullable<typeof old>]);
        expect(await h().moveOps.listPending()).toHaveLength(1);
        expect(await rejectMoves(h(), [old as NonNullable<typeof old>])).toEqual([]);
        expect((await read("m1"))?.mailboxes).toBe(MAILBOX_BIT.trash);
        expect(key).toBe(await keyOf("m1"));
      });

      it("gives a refused message back the labels and mailboxes it had, with a change", async () => {
        const key = await put("m1", "INBOX", 1);
        const before = await read("m1");
        await moveThread(deps(), { threadId: "t-m1", action: "spam" });
        const seq = (await h().read.store.changesSince(0)).changeSeq;
        const rows = await h().moveOps.listPending();
        expect(await rejectMoves(h(), rows)).toEqual([key]);
        expect(await read("m1")).toEqual(before);
        expect((await h().read.store.changesSince(seq)).changedKeys).toEqual([key]);
        expect(await h().moveOps.listPending()).toEqual([]);
      });
    });

    describe("Delete forever (rules 7 and 16)", () => {
      const purge = (keys: readonly number[]) => deleteForever(deps(), keys);

      it("refuses anything that is not in Trash, and anything with a copy outside it", async () => {
        const inbox = await put("a", "INBOX", 1);
        const both = await put("b", "Trash", 2);
        await copy("b", "Clients", 3);
        const bin = await put("c", "Trash", 4);
        const result = await purge([inbox, both, 12345, bin]);
        expect(result.queued).toEqual([bin]);
        expect([...result.refused].sort()).toEqual([12345, both, inbox].sort());
        expect(await h().moveOps.listPending()).toEqual([
          expect.objectContaining({ key: bin, action: "purge", nextAttemptMs: 1000 }),
        ]);
        expect(await read("a")).toBeDefined();
        expect(await h().store.getLocations(both)).toHaveLength(2);
      });

      it("refuses a message that was only moved to Trash here and is still in the inbox on the server", async () => {
        const key = await put("a", "INBOX", 1);
        await moveThread(deps(), { threadId: "t-a", action: "delete" });
        expect((await read("a"))?.mailboxes).toBe(MAILBOX_BIT.trash);
        expect((await purge([key])).refused).toEqual([key]);
        expect(await h().moveOps.listPending()).toEqual([
          expect.objectContaining({ action: "delete" }),
        ]);
      });

      it("removes a message with no copy on the server at once, with its index entry and body", async () => {
        const d = makeDocument(
          { dateMs: day(1), providerId: "demo", labelIds: ["Trash"] },
          "demo body",
        );
        const { keys } = await ingestDocuments(h(), [d]);
        const key = keys[0] as number;
        expect((await read("demo"))?.mailboxes).toBe(MAILBOX_BIT.trash);
        const result = await purge([key]);
        expect(result).toMatchObject({ removed: [key], queued: [], refused: [] });
        expect(await h().read.store.getByKeys([key])).toEqual([]);
        expect((await h().read.bodies.getBodies([key])).size).toBe(0);
        expect(await find("in:trash demo")).toEqual([]);
      });

      it("leaves the store one location at a time, and the message with the last", async () => {
        const key = await put("b", "Trash", 1);
        await copy("b", "Trash", 2);
        await purge([key]);
        const rows = await h().moveOps.listPending();
        const gone = (...uids: number[]) =>
          finishPurge(
            h(),
            rows,
            uids.map((u) => makeLocation(u, "Trash")),
          );
        // The server confirmed one copy only: the message stays with the other.
        expect(await gone(1)).toEqual([]);
        expect(await h().store.getLocations(key)).toEqual([makeLocation(2, "Trash")]);
        expect(await read("b")).toBeDefined();
        expect(await gone(2)).toEqual([key]);
        expect(await h().read.store.getByKeys([key])).toEqual([]);
        expect((await h().read.bodies.getBodies([key])).size).toBe(0);
        expect(await find("in:trash")).toEqual([]);
        expect(await h().moveOps.listPending()).toEqual([]);
      });
    });
  });
}

/** The queue of moves the server does not have yet (ADR 0044, rule 8). */
export function describeMoveOutboxContract(name: string, factory: Factory<MoveOutboxPort>) {
  describe(`MoveOutboxPort contract: ${name}`, () => {
    const ops = useFixture(factory);
    const op = (key: number, over: Partial<NewMoveOperation> = {}): NewMoveOperation => ({
      key,
      accountId: "acc1",
      operationId: "a",
      action: "archive",
      target: "role:archive",
      labelsBefore: ["INBOX", "Clients"],
      mailboxesBefore: 65,
      nextAttemptMs: 1000,
      createdAtMs: 500,
      ...over,
    });

    it("stores one row per message and lists it as it was put", async () => {
      await ops().put([
        op(1),
        op(2, { accountId: "acc2", action: "delete", target: "role:trash" }),
      ]);
      expect(await ops().listPending()).toEqual([
        {
          key: 1,
          accountId: "acc1",
          operationId: "a",
          action: "archive",
          target: "role:archive",
          labelsBefore: ["INBOX", "Clients"],
          mailboxesBefore: 65,
          attempts: 0,
          nextAttemptMs: 1000,
          createdAtMs: 500,
          rev: 1,
        },
        expect.objectContaining({ key: 2, accountId: "acc2", action: "delete" }),
      ]);
      expect((await ops().listPending("acc2")).map((o) => o.key)).toEqual([2]);
      expect(await ops().listPending("nobody")).toEqual([]);
    });

    it("lets the latest request win but remembers what the server had", async () => {
      await ops().put([op(1)]);
      const [first] = await ops().listPending();
      await ops().defer([{ operation: first as MoveOperation, nextAttemptMs: 9000 }]);
      await ops().put([
        op(1, {
          operationId: "b",
          action: "delete",
          target: "role:trash",
          labelsBefore: ["Archive"],
          mailboxesBefore: 32,
          nextAttemptMs: 2000,
          createdAtMs: 700,
        }),
      ]);
      expect(await ops().listPending()).toEqual([
        {
          key: 1,
          accountId: "acc1",
          operationId: "b",
          action: "delete",
          target: "role:trash",
          // What the first unpushed request found, not what the second did.
          labelsBefore: ["INBOX", "Clients"],
          mailboxesBefore: 65,
          attempts: 0,
          nextAttemptMs: 2000,
          createdAtMs: 500,
          rev: 2,
        },
      ]);
    });

    it("lists what is due, earliest first, and tells when the next one is", async () => {
      expect(await ops().nextDueMs()).toBeNull();
      await ops().put([op(1, { nextAttemptMs: 3000 }), op(2, { nextAttemptMs: 1000 }), op(3)]);
      expect(await ops().nextDueMs()).toBe(1000);
      expect((await ops().listDue(1000, 10)).map((o) => o.key)).toEqual([2, 3]);
      expect((await ops().listDue(1000, 1)).map((o) => o.key)).toEqual([2]);
      expect((await ops().listDue(999, 10)).map((o) => o.key)).toEqual([]);
      expect((await ops().listDue(5000, 10)).map((o) => o.key)).toEqual([2, 3, 1]);
    });

    it("takes back an action only while all of it is inside its window", async () => {
      await ops().put([op(1), op(2), op(3, { operationId: "b" })]);
      const late = await ops().cancel("a", 1000);
      expect(late.late).toBe(true);
      expect(late.removed).toEqual([]);
      expect(await ops().listPending()).toHaveLength(3);

      const early = await ops().cancel("a", 999);
      expect(early.late).toBe(false);
      expect(early.removed.map((o) => o.key)).toEqual([1, 2]);
      expect((await ops().listPending()).map((o) => o.key)).toEqual([3]);
      expect(await ops().cancel("a", 0)).toEqual({ removed: [], late: false });
    });

    it("counts a row that was tried as late, whatever its time", async () => {
      await ops().put([op(1)]);
      const [row] = await ops().listPending();
      await ops().defer([{ operation: row as MoveOperation, nextAttemptMs: 9000 }]);
      expect((await ops().cancel("a", 0)).late).toBe(true);
    });

    it("deletes only the revision it is given", async () => {
      await ops().put([op(1), op(2)]);
      const [one, two] = await ops().listPending();
      await ops().put([op(1, { operationId: "b" })]);
      const deleted = await ops().settle([one as MoveOperation, two as MoveOperation]);
      expect(deleted.map((o) => o.key)).toEqual([2]);
      expect((await ops().listPending()).map((o) => o.key)).toEqual([1]);
    });

    it("counts a deferral against the revision it is given, and drops an account with its rows", async () => {
      await ops().put([op(1), op(2, { accountId: "acc2" })]);
      const [one] = await ops().listPending();
      await ops().put([op(1, { operationId: "b" })]);
      await ops().defer([{ operation: one as MoveOperation, nextAttemptMs: 7000 }]);
      expect((await ops().listPending("acc1"))[0]).toMatchObject({
        attempts: 0,
        nextAttemptMs: 1000,
      });
      await ops().discardAccount("acc1");
      expect((await ops().listPending()).map((o) => o.key)).toEqual([2]);
    });
  });
}

const analysis = (over: Partial<ThreadAnalysis> = {}): ThreadAnalysis => ({
  threadId: "t1",
  lastMessageKey: 10,
  analyzerVersion: 1,
  state: "onYou",
  headline: "Send the offer",
  facts: [
    {
      kind: "promise",
      who: "you",
      dueMs: Date.UTC(2024, 2, 5),
      evidence: { quote: "I will send it by Tuesday", messageKey: 9 },
    },
  ],
  stakes: "money",
  confidence: 0.9,
  analyzedAtMs: 1000,
  ...over,
});

/** ADR 0051, 0052. Analyses are keyed by thread, last message and analyzer version. */
export function describeAgentInsightStoreContract(
  name: string,
  factory: Factory<AgentInsightStorePort>,
) {
  describe(`AgentInsightStorePort contract: ${name}`, () => {
    const store = useFixture(factory);

    it("round-trips an analysis with every field", async () => {
      const a = analysis();
      await store().putAnalysis([a]);
      expect(await store().getAnalysis("t1", 10, 1)).toEqual(a);
    });

    it("round-trips the reading of ADR 0066: intent, its passage, amount, window, personal passage, status", async () => {
      const a = analysis({
        intent: "decide",
        intentEvidence: { quote: "You may sign up until 10 December", messageKey: 9 },
        amount: {
          value: 1090,
          currency: "PLN",
          role: "price",
          evidence: { quote: "1090 PLN", messageKey: 9 },
        },
        windowEndMs: Date.UTC(2024, 11, 10),
        forYouEvidence: { quote: "your 2023 return", messageKey: 9 },
        status: "unknown",
      });
      await store().putAnalysis([a]);
      expect(await store().getAnalysis("t1", 10, 1)).toEqual(a);
      expect(await store().listAnalyses(1)).toEqual([a]);
    });

    it("leaves the reading out when the analysis has none, so an older one reads as it was", async () => {
      const a = analysis();
      await store().putAnalysis([a]);
      const got = await store().getAnalysis("t1", 10, 1);
      for (const key of [
        "intent",
        "intentEvidence",
        "amount",
        "windowEndMs",
        "forYouEvidence",
        "status",
      ]) {
        expect(got && key in got, key).toBe(false);
      }
    });

    it("finds nothing for another thread, last message or version", async () => {
      await store().putAnalysis([analysis()]);
      expect(await store().getAnalysis("t2", 10, 1)).toBeNull();
      expect(await store().getAnalysis("t1", 11, 1)).toBeNull();
      expect(await store().getAnalysis("t1", 10, 2)).toBeNull();
    });

    it("keeps a fact without a date and an empty list of facts", async () => {
      const a = analysis({
        state: "none",
        facts: [{ kind: "ask", who: "them", evidence: { quote: "Any news?", messageKey: 3 } }],
      });
      const b = analysis({ threadId: "t2", state: "fyi", facts: [] });
      await store().putAnalysis([a, b]);
      expect(await store().getAnalysis("t1", 10, 1)).toEqual(a);
      expect(await store().getAnalysis("t2", 10, 1)).toEqual(b);
    });

    it("replaces an analysis with the same thread, last message and version", async () => {
      await store().putAnalysis([analysis()]);
      await store().putAnalysis([analysis({ headline: "Changed", confidence: 0.5 })]);
      expect(await store().getAnalysis("t1", 10, 1)).toMatchObject({
        headline: "Changed",
        confidence: 0.5,
      });
      expect(await store().listAnalyses(1)).toHaveLength(1);
    });

    it("lists the latest analysis of each thread for a version", async () => {
      await store().putAnalysis([
        analysis({ lastMessageKey: 5, headline: "old" }),
        analysis({ lastMessageKey: 10, headline: "new" }),
        analysis({ threadId: "t2", lastMessageKey: 7 }),
        analysis({ threadId: "t3", analyzerVersion: 2 }),
      ]);
      const list = await store().listAnalyses(1);
      expect(list.map((a) => `${a.threadId}:${a.headline}`).sort()).toEqual([
        "t1:new",
        "t2:Send the offer",
      ]);
      expect((await store().listAnalyses(2)).map((a) => a.threadId)).toEqual(["t3"]);
    });

    it("limits the list to the threads asked for", async () => {
      await store().putAnalysis([analysis(), analysis({ threadId: "t2" })]);
      expect((await store().listAnalyses(1, ["t2"])).map((a) => a.threadId)).toEqual(["t2"]);
      expect(await store().listAnalyses(1, [])).toEqual([]);
    });

    it("keeps prepared work per thread and last message, drafts and questions alike", async () => {
      const draft: PreparedRecord = {
        threadId: "t1",
        lastMessageKey: 10,
        work: { kind: "draft", body: "Hi,\n\nHere it is.", nudge: false },
        preparedAtMs: 5,
      };
      const needs: PreparedRecord = {
        threadId: "t1",
        lastMessageKey: 11,
        work: { kind: "needs", missing: "The price", directions: ["Ask Anna", "Wait"] },
        preparedAtMs: 6,
      };
      await store().putPrepared([draft, needs]);
      expect(await store().getPrepared("t1", 10)).toEqual(draft);
      expect(await store().getPrepared("t1", 11)).toEqual(needs);
      expect(await store().getPrepared("t1", 12)).toBeNull();
      await store().putPrepared([{ ...draft, preparedAtMs: 9 }]);
      expect(await store().getPrepared("t1", 10)).toMatchObject({ preparedAtMs: 9 });
    });

    it("lists feedback in the order it was recorded", async () => {
      const first: ThingFeedback = {
        threadId: "t1",
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        kind: "notImportant",
        atMs: 5,
      };
      const second: ThingFeedback = {
        threadId: "t2",
        lastMessageKey: 4,
        senderAddress: "bob@example.com",
        kind: "later",
        atMs: 3,
        untilMs: 99,
      };
      expect(await store().listFeedback()).toEqual([]);
      await store().recordFeedback(first);
      await store().recordFeedback(second);
      expect(await store().listFeedback()).toEqual([first, second]);
    });

    it("keeps what a closing meant, and for a decline the matter and amount (ADR 0066, rule 7)", async () => {
      const declined: ThingFeedback = {
        threadId: "t1",
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        kind: "closed",
        atMs: 5,
        outcome: "declined",
        caseKey: "oferta ksiegowosci",
        amountValue: 1090,
      };
      const plain: ThingFeedback = { ...declined, threadId: "t2" };
      delete (plain as { outcome?: string }).outcome;
      delete (plain as { caseKey?: string }).caseKey;
      delete (plain as { amountValue?: number }).amountValue;
      await store().recordFeedback(declined);
      await store().recordFeedback(plain);
      const listed = await store().listFeedback();
      expect(listed).toEqual([declined, plain]);
      expect("outcome" in (listed[1] as object)).toBe(false);
      await store().withdrawFeedback("t1", "closed");
      expect((await store().listFeedback()).map((f) => f.threadId)).toEqual(["t2"]);
    });

    it("keeps the reason of a closed entry, and leaves the key out when there is none", async () => {
      const withReason: ThingFeedback = {
        threadId: "t1",
        lastMessageKey: 10,
        senderAddress: "noreply@northwind.example",
        kind: "closed",
        atMs: 5,
        reason: "An automatic notification",
      };
      const without: ThingFeedback = { ...withReason, threadId: "t2", atMs: 6 };
      delete (without as { reason?: string }).reason;
      await store().recordFeedback(withReason);
      await store().recordFeedback(without);
      const listed = await store().listFeedback();
      expect(listed).toEqual([withReason, without]);
      expect("reason" in (listed[1] as object)).toBe(false);
      await store().withdrawFeedback("t1", "closed");
      expect((await store().listFeedback()).map((f) => f.threadId)).toEqual(["t2"]);
    });

    it("takes back only the newest feedback of that kind for that thread", async () => {
      const fb = (threadId: string, kind: ThingFeedback["kind"], atMs: number): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        kind,
        atMs,
      });
      await store().recordFeedback(fb("t1", "notImportant", 1));
      await store().recordFeedback(fb("t1", "later", 2));
      await store().recordFeedback(fb("t1", "notImportant", 3));
      await store().recordFeedback(fb("t2", "notImportant", 4));
      await store().withdrawFeedback("t1", "notImportant");
      expect((await store().listFeedback()).map((f) => [f.threadId, f.kind, f.atMs])).toEqual([
        ["t1", "notImportant", 1],
        ["t1", "later", 2],
        ["t2", "notImportant", 4],
      ]);
      await store().withdrawFeedback("t9", "later");
      expect(await store().listFeedback()).toHaveLength(3);
    });

    // Rule lines have no thread; these tests are about the lines of feedback.
    const feedbackJournal = async (limit: number): Promise<FeedbackJournalEntry[]> =>
      (await store().listJournal(limit)).filter(
        (j): j is FeedbackJournalEntry =>
          j.action !== "ruleAdded" && j.action !== "instructionAdded",
      );

    it("keeps how many older threads a feedback also covered, and nothing when none", async () => {
      const fb = (threadId: string, atMs: number): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        kind: "closed",
        atMs,
      });
      await store().recordFeedback(fb("t1", 1), { actor: "person", alsoCovers: 8 });
      await store().recordFeedback(fb("t2", 2), { actor: "person" });
      const [second, first] = await feedbackJournal(2);
      expect(first?.alsoCovers).toBe(8);
      expect(second).not.toHaveProperty("alsoCovers");
    });

    it("journals each feedback with who decided, in the same write, newest first", async () => {
      const fb = (
        threadId: string,
        kind: ThingFeedback["kind"],
        atMs: number,
        extra: Partial<ThingFeedback> = {},
      ): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        kind,
        atMs,
        ...extra,
      });
      await store().recordFeedback(fb("t1", "notImportant", 1));
      await store().recordFeedback(fb("t2", "later", 2, { untilMs: 99 }), {
        actor: "person",
        headline: "Pay it",
      });
      await store().recordFeedback(fb("t3", "closed", 3, { reason: "Nothing to answer" }), {
        actor: "agent",
        headline: "Notice",
        words: "nie odpisuj",
      });
      const lines = await feedbackJournal(10);
      expect(lines.map((j) => [j.threadId, j.action, j.actor])).toEqual([
        ["t3", "closed", "agent"],
        ["t2", "later", "person"],
        ["t1", "notImportant", "person"],
      ]);
      expect(lines[0]).toMatchObject({
        lastMessageKey: 10,
        senderAddress: "anna@northwind.example",
        headline: "Notice",
        words: "nie odpisuj",
        reason: "Nothing to answer",
        atMs: 3,
      });
      expect(lines[0]?.undoneAtMs).toBeUndefined();
      expect(lines[1]).toMatchObject({ untilMs: 99, headline: "Pay it" });
      expect(lines[2]?.headline).toBeUndefined();
      expect(lines[2]?.words).toBeUndefined();
      expect(new Set(lines.map((j) => j.id)).size).toBe(3);
      expect((await feedbackJournal(2)).map((j) => j.threadId)).toEqual(["t3", "t2"]);
      expect(await feedbackJournal(0)).toEqual([]);
      // The feedback of the same writes is there too.
      expect(await store().listFeedback()).toHaveLength(3);
    });

    it("marks only the newest line of that thread and action undone, and leaves it listed", async () => {
      const fb = (threadId: string, kind: ThingFeedback["kind"], atMs: number): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "a@example.com",
        kind,
        atMs,
      });
      await store().recordFeedback(fb("t1", "notImportant", 1));
      await store().recordFeedback(fb("t1", "later", 2));
      await store().recordFeedback(fb("t1", "notImportant", 3));
      await store().recordFeedback(fb("t2", "notImportant", 4));
      await store().withdrawFeedback("t1", "notImportant", 500);
      const undone = (await feedbackJournal(10)).map((j) => [j.threadId, j.atMs, j.undoneAtMs]);
      expect(undone).toEqual([
        ["t2", 4, undefined],
        ["t1", 3, 500],
        ["t1", 2, undefined],
        ["t1", 1, undefined],
      ]);
      // Again: the next newest not yet undone line is the one marked.
      await store().withdrawFeedback("t1", "notImportant", 600);
      expect(
        (await feedbackJournal(10)).filter((j) => j.threadId === "t1" && j.undoneAtMs === 600),
      ).toHaveLength(1);
      expect(
        (await feedbackJournal(10)).find((j) => j.threadId === "t1" && j.atMs === 1)?.undoneAtMs,
      ).toBe(600);
      // No such line: nothing changes and nothing fails.
      await store().withdrawFeedback("t9", "later", 700);
      await store().withdrawFeedback("t1", "closed", 700);
      expect(await feedbackJournal(10)).toHaveLength(4);
      expect((await feedbackJournal(10)).filter((j) => j.undoneAtMs === 700)).toEqual([]);
    });

    it("forgets the journal lines of removed threads", async () => {
      const fb = (threadId: string): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "a@example.com",
        kind: "closed",
        atMs: 1,
        reason: "r",
      });
      await store().recordFeedback(fb("t1"), { actor: "agent" });
      await store().recordFeedback(fb("t2"), { actor: "agent" });
      await store().recordFeedback(fb("t3"));
      await store().removeForThreads(["t1", "t3", "unknown"]);
      expect((await feedbackJournal(10)).map((j) => j.threadId)).toEqual(["t2"]);
    });

    it("adds a rule with its journal line, and adding it again changes nothing", async () => {
      const input = {
        scope: "sender",
        subject: "alerts@x.com",
        action: "noReply",
        actor: "person",
      } as const;
      const rule = await store().addRule(input, 10);
      expect(rule).toMatchObject({ scope: "sender", subject: "alerts@x.com", actor: "person" });
      expect(rule.atMs).toBe(10);
      const again = await store().addRule({ ...input, words: "other" }, 20);
      expect(again).toEqual(rule);
      expect(await store().listRules()).toEqual([rule]);
      const lines = await store().listJournal(10);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        action: "ruleAdded",
        ruleId: rule.id,
        scope: "sender",
        subject: "alerts@x.com",
        actor: "person",
        atMs: 10,
      });
      expect(lines[0]?.undoneAtMs).toBeUndefined();
    });

    it("keeps the words of a rule, and lists only active rules in id order", async () => {
      const a = await store().addRule(
        { scope: "domain", subject: "x.com", action: "noReply", actor: "agent", words: "no" },
        1,
      );
      const b = await store().addRule(
        { scope: "type", subject: "programLike", action: "noReply", actor: "person" },
        2,
      );
      const c = await store().addRule(
        { scope: "sender", subject: "a@y.com", action: "noReply", actor: "person" },
        3,
      );
      expect(a.words).toBe("no");
      expect((await store().listJournal(10))[2]).toMatchObject({
        ruleId: a.id,
        scope: "domain",
        words: "no",
        actor: "agent",
      });
      await store().removeRule(b.id, 4);
      expect((await store().listRules()).map((r) => r.id)).toEqual([a.id, c.id]);
      expect((await store().listRules())[0]?.words).toBe("no");
    });

    it("marks the line of a removed rule undone, and the rule can be added again", async () => {
      const input = {
        scope: "sender",
        subject: "alerts@x.com",
        action: "noReply",
        actor: "person",
      } as const;
      const first = await store().addRule(input, 1);
      await store().removeRule(first.id, 50);
      expect(await store().listRules()).toEqual([]);
      expect((await store().listJournal(10))[0]?.undoneAtMs).toBe(50);
      // Removing again, or an unknown id, changes nothing.
      await store().removeRule(first.id, 60);
      await store().removeRule(9999, 60);
      expect((await store().listJournal(10))[0]?.undoneAtMs).toBe(50);
      const second = await store().addRule(input, 100);
      expect(second.id).not.toBe(first.id);
      expect(await store().listRules()).toEqual([second]);
      const lines = await store().listJournal(10);
      expect(lines.map((j) => [j.action === "ruleAdded" ? j.ruleId : 0, j.undoneAtMs])).toEqual([
        [second.id, undefined],
        [first.id, 50],
      ]);
    });

    it("leaves rules and their lines when threads are removed", async () => {
      await store().addRule(
        { scope: "sender", subject: "a@x.com", action: "noReply", actor: "person" },
        1,
      );
      await store().recordFeedback({
        threadId: "t1",
        lastMessageKey: 1,
        senderAddress: "a@x.com",
        kind: "closed",
        atMs: 2,
      });
      await store().removeForThreads(["t1"]);
      expect(await store().listRules()).toHaveLength(1);
      expect((await store().listJournal(10)).map((j) => j.action)).toEqual(["ruleAdded"]);
    });

    it("adds an instruction with its journal line, and adding it again changes nothing", async () => {
      const input = { scope: "write", text: "Write briefly", actor: "person" } as const;
      const kept = await store().addInstruction(input, 10);
      expect(kept).toMatchObject({
        scope: "write",
        text: "Write briefly",
        actor: "person",
        atMs: 10,
      });
      expect(kept.threadId).toBeUndefined();
      expect(kept.words).toBeUndefined();
      expect(
        await store().addInstruction({ ...input, actor: "agent", words: "other" }, 20),
      ).toEqual(kept);
      expect(await store().listInstructions()).toEqual([kept]);
      const lines = await store().listJournal(10);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({
        action: "instructionAdded",
        instructionId: kept.id,
        scope: "write",
        text: "Write briefly",
        actor: "person",
        atMs: 10,
      });
      expect(lines[0]?.undoneAtMs).toBeUndefined();
    });

    it("keeps the words and thread of an instruction, and tells one thread's text from another's", async () => {
      const a = await store().addInstruction(
        {
          scope: "thread",
          threadId: "t1",
          text: "For the board",
          actor: "agent",
          words: "to dla zarządu",
        },
        1,
      );
      const b = await store().addInstruction(
        { scope: "thread", threadId: "t2", text: "For the board", actor: "agent" },
        2,
      );
      const c = await store().addInstruction(
        { scope: "general", text: "For the board", actor: "person" },
        3,
      );
      expect(new Set([a.id, b.id, c.id]).size).toBe(3);
      expect(a).toMatchObject({ threadId: "t1", words: "to dla zarządu", actor: "agent" });
      expect((await store().listInstructions()).map((i) => i.id)).toEqual([a.id, b.id, c.id]);
      expect((await store().listJournal(10))[2]).toMatchObject({
        action: "instructionAdded",
        instructionId: a.id,
        scope: "thread",
        threadId: "t1",
        words: "to dla zarządu",
        actor: "agent",
      });
      // The thread id means something for `thread` only.
      const plain = await store().addInstruction(
        { scope: "write", threadId: "t9", text: "Elsewhere", actor: "person" },
        4,
      );
      expect(plain.threadId).toBeUndefined();
    });

    it("marks the line of a removed instruction undone, and it can be added again", async () => {
      const input = { scope: "general", text: "Answer briefly", actor: "person" } as const;
      const first = await store().addInstruction(input, 1);
      await store().removeInstruction(first.id, 50);
      expect(await store().listInstructions()).toEqual([]);
      expect((await store().listJournal(10))[0]?.undoneAtMs).toBe(50);
      await store().removeInstruction(first.id, 60);
      await store().removeInstruction(9999, 60);
      expect((await store().listJournal(10))[0]?.undoneAtMs).toBe(50);
      const second = await store().addInstruction(input, 100);
      expect(second.id).not.toBe(first.id);
      expect(await store().listInstructions()).toEqual([second]);
      expect((await store().listJournal(10)).map((j) => j.undoneAtMs)).toEqual([undefined, 50]);
    });

    it("forgets the instructions of a thread, with their lines, and keeps the rest", async () => {
      await store().addInstruction(
        { scope: "general", text: "Answer briefly", actor: "person" },
        1,
      );
      await store().addInstruction(
        { scope: "thread", threadId: "t1", text: "About t1", actor: "agent" },
        2,
      );
      await store().addInstruction(
        { scope: "thread", threadId: "t2", text: "About t2", actor: "agent" },
        3,
      );
      await store().removeForThreads(["t1", "unknown"]);
      expect((await store().listInstructions()).map((i) => i.text)).toEqual([
        "Answer briefly",
        "About t2",
      ]);
      expect(
        (await store().listJournal(10)).map((j) => (j.action === "instructionAdded" ? j.text : "")),
      ).toEqual(["About t2", "Answer briefly"]);
      // A removed one that belonged to the thread goes too, so nothing of it stays behind.
      const gone = await store().addInstruction(
        { scope: "thread", threadId: "t3", text: "Gone", actor: "agent" },
        4,
      );
      await store().removeInstruction(gone.id, 5);
      await store().removeForThreads(["t3"]);
      expect(
        (await store().listJournal(10)).some(
          (j) => j.action === "instructionAdded" && j.text === "Gone",
        ),
      ).toBe(false);
    });

    it("keeps a ledger line of the turn that remembers", async () => {
      await store().appendLedger([
        { atMs: 1, runtimeId: "r", accountId: "a", purpose: "remember", threads: 0 },
      ]);
      expect(await store().listLedger(10)).toEqual([
        { atMs: 1, runtimeId: "r", accountId: "a", purpose: "remember", threads: 0 },
      ]);
    });

    it("lists the ledger newest first, up to the limit", async () => {
      const entry = (atMs: number, threads: number): LedgerEntry => ({
        atMs,
        runtimeId: "r",
        accountId: "a",
        purpose: "analysis",
        threads,
      });
      await store().appendLedger([entry(1, 1), entry(3, 3)]);
      await store().appendLedger([entry(2, 2)]);
      expect((await store().listLedger(10)).map((e) => e.threads)).toEqual([3, 2, 1]);
      expect((await store().listLedger(2)).map((e) => e.threads)).toEqual([3, 2]);
      expect(await store().listLedger(0)).toEqual([]);
    });

    it("forgets the readings, prepared work and feedback of removed threads, and keeps the ledger", async () => {
      await store().putAnalysis([
        analysis(),
        analysis({ threadId: "t2" }),
        analysis({ threadId: "t3" }),
      ]);
      await store().putPrepared([
        {
          threadId: "t1",
          lastMessageKey: 10,
          work: { kind: "draft", body: "x", nudge: false },
          preparedAtMs: 1,
        },
        {
          threadId: "t2",
          lastMessageKey: 10,
          work: { kind: "draft", body: "y", nudge: false },
          preparedAtMs: 1,
        },
      ]);
      const fb = (threadId: string): ThingFeedback => ({
        threadId,
        lastMessageKey: 10,
        senderAddress: "a@example.com",
        kind: "notImportant",
        atMs: 1,
      });
      await store().recordFeedback(fb("t1"));
      await store().recordFeedback(fb("t2"));
      await store().appendLedger([
        { atMs: 1, runtimeId: "r", accountId: "a", purpose: "analysis", threads: 3 },
      ]);
      await store().removeForThreads(["t1", "t2", "unknown"]);
      expect((await store().listAnalyses(1)).map((a) => a.threadId)).toEqual(["t3"]);
      expect(await store().getPrepared("t1", 10)).toBeNull();
      expect(await store().getPrepared("t2", 10)).toBeNull();
      expect(await store().listFeedback()).toEqual([]);
      expect(await store().listLedger(5)).toHaveLength(1);
      await store().removeForThreads([]);
    });

    it("keeps the person's choices in the ledger beside what was sent", async () => {
      const choice = (
        atMs: number,
        purpose: LedgerEntry["purpose"],
        threads: number,
      ): LedgerEntry => ({
        atMs,
        runtimeId: "r",
        accountId: "a",
        purpose,
        threads,
      });
      await store().appendLedger([choice(1, "consent", 42), choice(2, "revoke", 0)]);
      expect((await store().listLedger(5)).map((e) => [e.purpose, e.threads])).toEqual([
        ["revoke", 0],
        ["consent", 42],
      ]);
    });

    describe("the talk with the agent (ADR 0064)", () => {
      const you = (threadId: string | null, atMs: number, text: string) =>
        ({ threadId, atMs, role: "you", text }) as const;
      const agent = (threadId: string | null, atMs: number, text: string) =>
        ({
          threadId,
          atMs,
          role: "agent",
          kind: "answer",
          text,
          quotes: [{ text: "by Friday", from: "Anna", dateMs: 5, messageKey: 10 }],
          runtimeName: "Claude Code",
          model: "sonnet",
          threads: 1,
        }) as const;

      it("keeps entries in the order given, with ids that grow, and every field", async () => {
        const added = await store().appendTalk([
          you("t1", 1, "What does she want?"),
          agent("t1", 2, "The offer."),
        ]);
        expect(added.map((e) => e.role)).toEqual(["you", "agent"]);
        expect(added[1]?.id).toBeGreaterThan(added[0]?.id ?? Number.POSITIVE_INFINITY);
        expect(await store().listTalk("t1", 10)).toEqual(added);
        expect(await store().listTalk("t1", 10)).toEqual([
          { ...you("t1", 1, "What does she want?"), id: added[0]?.id },
          { ...agent("t1", 2, "The offer."), id: added[1]?.id },
        ]);
      });

      it("lists one thread's talk, the newest `limit` of it, oldest first", async () => {
        await store().appendTalk([you("t1", 1, "one"), you("t2", 2, "other")]);
        await store().appendTalk([you("t1", 3, "two"), you("t1", 4, "three")]);
        expect(
          (await store().listTalk("t1", 10)).map((e) => (e.role === "you" ? e.text : "")),
        ).toEqual(["one", "two", "three"]);
        expect(
          (await store().listTalk("t1", 2)).map((e) => (e.role === "you" ? e.text : "")),
        ).toEqual(["two", "three"]);
        expect(await store().listTalk("t1", 0)).toEqual([]);
        expect(await store().listTalk("nobody", 5)).toEqual([]);
        expect(await store().appendTalk([])).toEqual([]);
      });

      it("forgets a thread's talk with the thread, and keeps the others", async () => {
        await store().appendTalk([you("t1", 1, "a"), you("t2", 2, "b")]);
        await store().removeForThreads(["t1", "unknown"]);
        expect(await store().listTalk("t1", 5)).toEqual([]);
        expect(await store().listTalk("t2", 5)).toHaveLength(1);
      });

      describe("the talk across all mail", () => {
        const found = (atMs: number) =>
          ({
            threadId: null,
            atMs,
            role: "agent",
            kind: "found",
            text: "Two people.",
            quotes: [
              { text: "one", from: "Anna", dateMs: 5, messageKey: 10, threadId: "t1" },
              { text: "two", from: "Tom", dateMs: 6, messageKey: 20, threadId: "t2" },
            ],
            runtimeName: "Claude Code",
            model: "sonnet",
            threads: 2,
            query: "from:anna OR from:tom",
            hits: [
              {
                threadId: "t1",
                who: "Anna",
                subject: "Quote",
                note: "waits",
                lastMessageMs: 5,
                state: "waiting",
              },
              {
                threadId: "t2",
                who: "Tom",
                subject: "Deck",
                note: "asks",
                lastMessageMs: 6,
                state: null,
              },
            ],
          }) as const;

        it("keeps the query and the hits, apart from every thread's talk", async () => {
          await store().appendTalk([you("t1", 1, "thread words")]);
          const added = await store().appendTalk([you(null, 2, "all words"), found(3)]);
          const all = await store().listTalk(null, 10);
          expect(all).toEqual(added);
          expect(all[1]).toMatchObject({ kind: "found", query: "from:anna OR from:tom" });
          expect(await store().listTalk("t1", 10)).toHaveLength(1);
        });

        it("keeps the offers and the facts of an answer, as given, each of its kind (ADR 0102)", async () => {
          const offers = [
            {
              kind: "view",
              name: "Invoices",
              query: "subject:invoice",
              why: "Every bill in one place.",
              notify: true,
              matches: 128,
              matchesCapped: false,
              unread: 12,
            },
            {
              kind: "act",
              action: "archive",
              query: "from:news.example",
              why: "Old newsletters.",
              matches: 40,
              matchesCapped: false,
              unread: 0,
            },
            {
              kind: "message",
              to: ["anna@northwind.example"],
              unknownTo: ["x@elsewhere.example"],
              subject: "Late",
              body: "I will be late.",
              why: "You asked to tell Anna.",
            },
          ] as const;
          const facts = [
            { kind: "count", query: "from:anna", matches: 500, capped: true, unread: 3 },
            {
              kind: "overview",
              months: 3,
              senders: [{ key: "anna@northwind.example", name: "Anna", messages: 9, unread: 1 }],
              domains: [{ key: "northwind.example", messages: 9, unread: 1 }],
            },
          ] as const;
          const added = await store().appendTalk([
            you(null, 2, "help"),
            {
              ...found(3),
              offers,
              facts,
              loop: { searches: 1, read: 0, counts: 2, views: true },
            },
          ]);
          const all = await store().listTalk(null, 10);
          expect(all).toEqual(added);
          expect(all[1]).toMatchObject({ offers, facts, loop: { counts: 2, views: true } });
        });

        it("drops the hits and quotes of a removed thread, and keeps the rest of the talk", async () => {
          await store().appendTalk([found(1)]);
          await store().removeForThreads(["t1"]);
          const [entry] = await store().listTalk(null, 10);
          expect(entry).toMatchObject({ kind: "found", text: "Two people." });
          if (entry?.role !== "agent") throw new Error("expected an agent entry");
          expect(entry.hits?.map((h) => h.threadId)).toEqual(["t2"]);
          expect(entry.quotes.map((q) => q.threadId)).toEqual(["t2"]);
        });
      });

      describe("talks across all mail (ADR 0086)", () => {
        const say = (talkId: number, atMs: number, text: string) =>
          ({ threadId: null, talkId, atMs, role: "you", text }) as const;
        const texts = (entries: readonly { role: string; text?: string }[]) =>
          entries.map((e) => (e.role === "you" ? e.text : ""));

        it("starts an empty talk, and keeps at most one empty", async () => {
          const a = await store().createTalk(10);
          expect(a).toMatchObject({ startedAtMs: 10, lastAtMs: 10, firstWords: "", entries: 0 });
          expect(a.title).toBeUndefined();
          const b = await store().createTalk(20);
          expect((await store().listTalks()).map((t) => t.id)).toEqual([b.id]);
          await store().appendTalk([say(b.id, 30, "first")]);
          const c = await store().createTalk(40);
          expect((await store().listTalks()).map((t) => t.id)).toEqual([c.id, b.id]);
        });

        it("keeps each talk's entries apart, with the talk on every entry", async () => {
          const a = await store().createTalk(1);
          await store().appendTalk([say(a.id, 2, "about Anna")]);
          const b = await store().createTalk(3);
          await store().appendTalk([say(b.id, 4, "about Tom"), say(b.id, 5, "and his deck")]);
          expect(texts(await store().listTalk(null, 10, { talkId: a.id }))).toEqual(["about Anna"]);
          const ofB = await store().listTalk(null, 10, { talkId: b.id });
          expect(texts(ofB)).toEqual(["about Tom", "and his deck"]);
          expect(ofB.every((e) => e.talkId === b.id)).toBe(true);
          expect(await store().listTalk(null, 10)).toHaveLength(3);
        });

        it("lists talks by their latest entry, with the first words and a count", async () => {
          const a = await store().createTalk(1);
          await store().appendTalk([say(a.id, 2, "old question")]);
          const b = await store().createTalk(3);
          await store().appendTalk([say(b.id, 4, "newer question")]);
          await store().appendTalk([say(a.id, 9, "back to the old one")]);
          const talks = await store().listTalks();
          expect(talks.map((t) => t.id)).toEqual([a.id, b.id]);
          expect(talks[0]).toMatchObject({
            startedAtMs: 1,
            lastAtMs: 9,
            firstWords: "old question",
            entries: 2,
          });
          expect(await store().getTalk(b.id)).toMatchObject({ firstWords: "newer question" });
          expect(await store().getTalk(999_999)).toBeNull();
        });

        it("loads older entries upward, before an id", async () => {
          const a = await store().createTalk(1);
          const added = await store().appendTalk([
            say(a.id, 1, "one"),
            say(a.id, 2, "two"),
            say(a.id, 3, "three"),
          ]);
          const third = added[2]?.id ?? 0;
          expect(texts(await store().listTalk(null, 1, { talkId: a.id, beforeId: third }))).toEqual(
            ["two"],
          );
          await store().appendTalk([you("t1", 4, "x"), you("t1", 5, "y")]);
          const [x, y] = await store().listTalk("t1", 5);
          expect(texts(await store().listTalk("t1", 5, { beforeId: y?.id ?? 0 }))).toEqual(["x"]);
          expect(x).toBeDefined();
        });

        it("never lets the model replace a name the person gave", async () => {
          const a = await store().createTalk(1);
          expect(await store().nameTalk(a.id, "Job change", "model")).toBe(true);
          expect(await store().getTalk(a.id)).toMatchObject({
            title: "Job change",
            titleBy: "model",
          });
          expect(await store().nameTalk(a.id, "My move", "person")).toBe(true);
          expect(await store().nameTalk(a.id, "Something else", "model")).toBe(false);
          expect(await store().getTalk(a.id)).toMatchObject({
            title: "My move",
            titleBy: "person",
          });
          expect(await store().nameTalk(a.id, "  ", "person")).toBe(true);
          const cleared = await store().getTalk(a.id);
          expect(cleared?.title).toBeUndefined();
          expect(cleared?.titleBy).toBeUndefined();
          expect(await store().nameTalk(a.id, "", "model")).toBe(false);
          expect(await store().nameTalk(999_999, "Nobody", "person")).toBe(false);
        });

        it("cuts a long name to 60 characters", async () => {
          const a = await store().createTalk(1);
          await store().nameTalk(a.id, "word ".repeat(30), "model");
          expect((await store().getTalk(a.id))?.title?.length).toBeLessThanOrEqual(60);
        });

        it("deletes one talk with its entries, and leaves the rest", async () => {
          const a = await store().createTalk(1);
          await store().appendTalk([say(a.id, 2, "keep")]);
          const b = await store().createTalk(3);
          await store().appendTalk([say(b.id, 4, "drop")]);
          await store().appendTalk([you("t1", 5, "thread")]);
          await store().deleteTalk(b.id);
          await store().deleteTalk(999_999);
          expect((await store().listTalks()).map((t) => t.id)).toEqual([a.id]);
          expect(texts(await store().listTalk(null, 10))).toEqual(["keep"]);
          expect(await store().listTalk("t1", 10)).toHaveLength(1);
        });

        it("deletes every talk of all mail, and no talk of a thread", async () => {
          const a = await store().createTalk(1);
          await store().appendTalk([say(a.id, 2, "a")]);
          const b = await store().createTalk(3);
          await store().appendTalk([say(b.id, 4, "b")]);
          await store().appendTalk([you("t1", 5, "thread")]);
          expect(await store().deleteAllTalks()).toBe(2);
          expect(await store().listTalks()).toEqual([]);
          expect(await store().listTalk(null, 10)).toEqual([]);
          expect(await store().listTalk("t1", 10)).toHaveLength(1);
          expect(await store().deleteAllTalks()).toBe(0);
        });
      });

      it("takes the purpose `talk` in the ledger", async () => {
        await store().appendLedger([
          { atMs: 1, runtimeId: "r", accountId: "a", purpose: "talk", threads: 1 },
        ]);
        expect((await store().listLedger(5)).map((e) => e.purpose)).toEqual(["talk"]);
      });
    });
  });
}

/** ADR 0051, rule 6: AI is off until the person turns it on, and consent is per account and runtime. */
export function describeAgentSettingsContract(name: string, factory: Factory<AgentSettingsPort>) {
  describe(`AgentSettingsPort contract: ${name}`, () => {
    const settings = useFixture(factory);

    it("starts with AI off and the defaults", async () => {
      expect(await settings().get()).toEqual({
        enabled: false,
        models: {
          understand: "haiku",
          draftAhead: "haiku",
          write: "sonnet",
          answer: "sonnet",
          titles: "haiku",
        },
        windowDays: 30,
        weekSharePercent: 10,
        usedByUsPercent: 0,
      });
    });

    it("changes only the fields given, and returns the result", async () => {
      const next = await settings().update({
        enabled: true,
        runtimeId: "claude-code",
        windowDays: 14,
      });
      expect(next).toMatchObject({
        enabled: true,
        runtimeId: "claude-code",
        windowDays: 14,
        weekSharePercent: 10,
      });
      expect(await settings().get()).toEqual(next);
      await settings().update({ weekSharePercent: 25 });
      expect(await settings().get()).toMatchObject({
        enabled: true,
        windowDays: 14,
        weekSharePercent: 25,
      });
    });

    it("keeps the person's pause, and reads settings stored before it as not paused", async () => {
      expect((await settings().get()).readingPaused).toBeUndefined();
      await settings().update({ readingPaused: true });
      expect((await settings().get()).readingPaused).toBe(true);
      await settings().update({ windowDays: 14 });
      expect((await settings().get()).readingPaused).toBe(true);
      await settings().update({ readingPaused: false });
      expect((await settings().get()).readingPaused).toBe(false);
    });

    it("keeps the models as a whole and 'off' for drafting ahead and for titles", async () => {
      await settings().update({
        models: {
          understand: "sonnet",
          draftAhead: "off",
          write: "opus",
          answer: "sonnet",
          titles: "off",
        },
      });
      expect((await settings().get()).models).toEqual({
        understand: "sonnet",
        draftAhead: "off",
        write: "opus",
        answer: "sonnet",
        titles: "off",
      });
    });

    it("names talks with haiku by default (ADR 0086, rule 8)", async () => {
      expect((await settings().get()).models.titles).toBe("haiku");
    });

    it("round-trips the plan's limits and clears them with null", async () => {
      const limits = {
        session: { usedPercent: 12.5, resetsAtMs: 1000 },
        week: { usedPercent: 40, resetsAtMs: 2000 },
        usingOverage: false,
        seenAtMs: 500,
      };
      await settings().update({ limits, usedByUsPercent: 3.5, usedWeekResetsAtMs: 2000 });
      expect(await settings().get()).toMatchObject({
        limits,
        usedByUsPercent: 3.5,
        usedWeekResetsAtMs: 2000,
      });
      const partial = { usingOverage: true, seenAtMs: 9 };
      await settings().update({ limits: partial });
      expect((await settings().get()).limits).toEqual(partial);
      await settings().update({ limits: null, usedWeekResetsAtMs: null });
      const cleared = await settings().get();
      expect("limits" in cleared).toBe(false);
      expect("usedWeekResetsAtMs" in cleared).toBe(false);
    });

    it("records consent per account and runtime, and keeps the first time", async () => {
      expect(await settings().listConsents()).toEqual([]);
      await settings().grantConsent("b", "claude-code", 20);
      await settings().grantConsent("a", "claude-code", 10);
      await settings().grantConsent("a", "other", 11);
      await settings().grantConsent("a", "claude-code", 99);
      expect(await settings().listConsents()).toEqual([
        { accountId: "a", runtimeId: "claude-code", grantedAtMs: 10 },
        { accountId: "a", runtimeId: "other", grantedAtMs: 11 },
        { accountId: "b", runtimeId: "claude-code", grantedAtMs: 20 },
      ]);
    });

    it("revokes one runtime of an account, or all of its runtimes", async () => {
      await settings().grantConsent("a", "r1", 1);
      await settings().grantConsent("a", "r2", 2);
      await settings().grantConsent("b", "r1", 3);
      await settings().revokeConsent("a", "r1");
      expect((await settings().listConsents()).map((c) => `${c.accountId}:${c.runtimeId}`)).toEqual(
        ["a:r2", "b:r1"],
      );
      await settings().revokeConsent("a");
      await settings().revokeConsent("unknown", "r1");
      expect((await settings().listConsents()).map((c) => `${c.accountId}:${c.runtimeId}`)).toEqual(
        ["b:r1"],
      );
    });

    it("keeps what the test of a runtime found, per runtime", async () => {
      expect(await settings().getRuntimeRecord("claude-code")).toBeNull();
      await settings().putRuntimeRecord({
        runtimeId: "claude-code",
        status: "ready",
        plan: "pro",
        testedAtMs: 5,
      });
      await settings().putRuntimeRecord({
        runtimeId: "other",
        status: "failed",
        problem: "It broke.",
        testedAtMs: 6,
      });
      expect(await settings().getRuntimeRecord("claude-code")).toEqual({
        runtimeId: "claude-code",
        status: "ready",
        plan: "pro",
        testedAtMs: 5,
      });
      await settings().putRuntimeRecord({
        runtimeId: "claude-code",
        status: "failed",
        testedAtMs: 7,
      });
      expect(await settings().getRuntimeRecord("claude-code")).toEqual({
        runtimeId: "claude-code",
        status: "failed",
        testedAtMs: 7,
      });
      expect(await settings().getRuntimeRecord("other")).toMatchObject({ problem: "It broke." });
    });
  });
}

/** What the file search contract needs: the store that holds the files, and the search over them. */
export interface FileSearchHarness {
  readonly store: MessageStorePort;
  readonly files: FilesPort;
}

/** ADR 0074. Files found by name: matching, order, dedupe, limits, and what leaves with a message. */
export function describeFileSearchContract(name: string, factory: Factory<FileSearchHarness>) {
  describe(`FilesPort contract: ${name}`, () => {
    const harness = useFixture(factory);
    let uid = 0;
    const file = (partId: string, fileName: string, over: Partial<ReceivedAttachment> = {}) => ({
      partId,
      name: fileName,
      mimeType: "application/pdf",
      size: 1000,
      inline: false,
      ...over,
    });
    /** A message with these files, stored and answered, at day `n`. */
    async function mail(
      n: number,
      files: ReceivedAttachment[],
      over: Partial<Message> = {},
    ): Promise<Message> {
      const { store } = harness();
      const location = makeLocation(++uid, "INBOX", "1", over.accountId ?? "acc1");
      const m = makeMessage({
        dateMs: day(n),
        providerId: `fp${uid}`,
        threadId: `ft${uid}`,
        hasAttachments: files.length > 0,
        ...over,
      });
      const { keys } = await store.upsertMessages([m]);
      await store.addLocations([{ key: keys[0] as number, location }]);
      await store.setAttachments([{ location, attachments: files }]);
      return { ...m, key: keys[0] as number };
    }
    const names = async (text: string, limit = 5, accountId?: string) =>
      (await harness().files.searchFiles(text, limit, accountId)).map((h) => h.fileName);

    it("describes the file and its message", async () => {
      const m = await mail(3, [file("2", "Aneks_651_2026.pdf", { size: 4242 })], {
        from: person("Jan Kowalski", "jan@example.com"),
        threadId: "tx",
      });
      expect(await harness().files.searchFiles("aneks", 5)).toEqual([
        {
          messageKey: m.key,
          partId: "2",
          fileName: "Aneks_651_2026.pdf",
          sizeBytes: 4242,
          contentType: "application/pdf",
          threadId: "tx",
          accountId: "acc1",
          sender: person("Jan Kowalski", "jan@example.com"),
          dateMs: day(3),
        },
      ]);
    });

    it("ignores case and diacritics, in the text and in the name", async () => {
      await mail(1, [file("2", "Załącznik Łódź.pdf")]);
      for (const text of ["zalacznik", "ZAŁĄCZNIK", "lodz", "Łódź", "znik łó"]) {
        expect(await names(text), text).toEqual(["Załącznik Łódź.pdf"]);
      }
    });

    it("finds the text anywhere in the name, after separators too", async () => {
      await mail(1, [file("2", "Aneks_651_2026.pdf")]);
      for (const text of ["aneks", "651", "_651_", "651_2026", "2026.pdf", "ks_6", "pdf"]) {
        expect(await names(text), text).toEqual(["Aneks_651_2026.pdf"]);
      }
      expect(await names("aneks 651")).toEqual([]);
      expect(await names("6512")).toEqual([]);
    });

    it("matches the start of a word for one or two characters", async () => {
      await mail(1, [file("2", "Aneks_651_2026.pdf")]);
      for (const text of ["a", "A", "an", "6", "65", "2", "20", "p", "pd"]) {
        expect(await names(text), text).toEqual(["Aneks_651_2026.pdf"]);
      }
      for (const text of ["n", "ne", "1", "51", "df", "_6", "a_"]) {
        expect(await names(text), text).toEqual([]);
      }
    });

    it("gives nothing for blank text or a zero limit", async () => {
      await mail(1, [file("2", "a.pdf")]);
      expect(await names("")).toEqual([]);
      expect(await names("   ")).toEqual([]);
      expect(await names("pdf", 0)).toEqual([]);
    });

    it("lists the newest message first and stops at the limit", async () => {
      await mail(2, [file("2", "report-b.pdf")]);
      await mail(5, [file("2", "report-e.pdf")]);
      await mail(1, [file("2", "report-a.pdf")]);
      await mail(4, [file("2", "report-d.pdf")]);
      expect(await names("report")).toEqual([
        "report-e.pdf",
        "report-d.pdf",
        "report-b.pdf",
        "report-a.pdf",
      ]);
      expect(await names("report", 2)).toEqual(["report-e.pdf", "report-d.pdf"]);
      expect(await names("re", 1)).toEqual(["report-e.pdf"]);
    });

    it("keeps the files of one message in their order", async () => {
      await mail(1, [file("3", "scan-2.pdf"), file("4", "scan-1.pdf")]);
      expect(await names("scan")).toEqual(["scan-2.pdf", "scan-1.pdf"]);
    });

    it("lists the same name in the same thread once, the newest, but not across threads", async () => {
      await mail(1, [file("2", "Faktura 1.pdf")], { threadId: "t" });
      const newest = await mail(3, [file("2", "FAKTURA 1.pdf")], { threadId: "t" });
      await mail(2, [file("2", "Faktura 1.pdf")], { threadId: "other" });
      const found = await harness().files.searchFiles("faktura", 5);
      expect(found.map((h) => [h.threadId, h.messageKey])).toEqual([
        ["t", newest.key],
        ["other", expect.any(Number)],
      ]);
      // Two parts of one message with one name are one file.
      await mail(4, [file("2", "dup.pdf"), file("3", "dup.pdf")]);
      expect(await names("dup")).toEqual(["dup.pdf"]);
    });

    it("leaves out inline parts and messages in Trash and Spam", async () => {
      await mail(1, [file("1.2", "logo-card.png", { inline: true }), file("2", "card.pdf")]);
      await mail(2, [file("2", "card-trash.pdf")], { labelIds: ["trash"] });
      await mail(3, [file("2", "card-spam.pdf")], { labelIds: ["spam"] });
      expect(await names("card")).toEqual(["card.pdf"]);
      expect(await names("lo")).toEqual([]);
    });

    it("narrows to one account", async () => {
      await mail(1, [file("2", "plan.pdf")]);
      await mail(2, [file("2", "plan-b.pdf")], { accountId: "acc2" });
      expect(await names("plan")).toEqual(["plan-b.pdf", "plan.pdf"]);
      expect(await names("plan", 5, "acc2")).toEqual(["plan-b.pdf"]);
      expect(await names("plan", 5, "acc3")).toEqual([]);
    });

    it("follows the files of a message when they are answered again", async () => {
      const m = await mail(1, [file("2", "old-name.pdf"), file("3", "keep.pdf")]);
      const { store } = harness();
      const location = makeLocation(uid, "INBOX", "1", "acc1");
      await store.setAttachments([{ location, attachments: [file("3", "new-name.pdf")] }]);
      expect(await names("old-name")).toEqual([]);
      expect(await names("new-name")).toEqual(["new-name.pdf"]);
      expect(await names("ol")).toEqual([]);
      expect(await names("ne")).toEqual(["new-name.pdf"]);
      await store.setAttachments([{ location, attachments: [] }]);
      expect(await names("name")).toEqual([]);
      expect(m.key).toBeGreaterThan(0);
    });

    it("forgets the files of a message that is removed, and of a removed account", async () => {
      const a = await mail(1, [file("2", "gone-a.pdf")]);
      await mail(2, [file("2", "gone-b.pdf")], { accountId: "acc2" });
      await mail(3, [file("2", "gone-c.pdf")], { accountId: "acc2" });
      const { store } = harness();
      await store.removeByProviderIds("acc1", [a.providerId]);
      expect(await names("gone")).toEqual(["gone-c.pdf", "gone-b.pdf"]);
      expect(await names("go")).toEqual(["gone-c.pdf", "gone-b.pdf"]);
      await store.removeAccountMessages("acc2");
      expect(await names("gone")).toEqual([]);
      expect(await names("go")).toEqual([]);
    });

    it("does not read text as search syntax", async () => {
      await mail(1, [file("2", 'say "hi" (1) * OR NOT.txt')]);
      for (const text of ['"hi"', "(1)", "* or", "OR NOT", '"']) {
        await expect(harness().files.searchFiles(text, 5)).resolves.toBeDefined();
      }
      expect(await names('"hi"')).toEqual(['say "hi" (1) * OR NOT.txt']);
      expect(await names("* or")).toEqual(['say "hi" (1) * OR NOT.txt']);
    });
  });
}
