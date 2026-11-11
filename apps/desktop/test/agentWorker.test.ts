import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleText } from "@matters/adapter-mime";
import { createSqliteReader, createSqliteStorage } from "@matters/adapter-sqlite";
import type { MailConnectorPort } from "@matters/core";
import {
  FakeComposeRenderer,
  FakeFileWork,
  FakeMailSubmit,
  FakeMessageComposer,
} from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { DemoAgentRuntime } from "../src/backend/demoAgent.ts";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { readsHere } from "../src/backend/heavyReads.ts";
import type {
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../src/backend/protocol.ts";
import { RemoteAgent } from "../src/backend/remoteAgent.ts";
import { seedDemoAccount, seedIfEmpty } from "../src/backend/seed.ts";
import type { SyncHost } from "../src/backend/syncHost.ts";
import { startSyncRuntime } from "../src/backend/syncRuntime.ts";
import { imageDeps } from "./support/noSend.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

/** The worker's runtime on a real database, and the router's side of it: a reader and a host. */
async function boot(options: { agent: boolean }) {
  const dir = mkdtempSync(join(tmpdir(), "matters-agentworker-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "matters.db");
  const storage = createSqliteStorage(dbPath, { reader: false });
  await seedIfEmpty(storage, { messages: 300, threads: 80 });
  await seedDemoAccount(storage.accounts);

  const handlers: ((m: ToWorker) => void)[] = [];
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  const posted: FromWorker[] = [];
  const channel: WorkerChannel = {
    post(message: FromWorker) {
      posted.push(message);
      if (message.type !== "result") return;
      const w = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.ok) w?.ok(message.value);
      else w?.fail(Object.assign(new Error(message.error.message), { name: message.error.name }));
    },
    onMessage: (h) => handlers.push(h),
  };
  const connector: MailConnectorPort = {
    connect: async () => {
      throw new Error("no server");
    },
    watchInbox: async () => ({ close: async () => {} }),
  };
  const runtime = await startSyncRuntime({
    storage,
    connector,
    channel,
    discovery: { discover: async () => null },
    registrableDomain: imageDeps.registrableDomain,
    files: new FakeFileWork(),
    sending: {
      renderer: new FakeComposeRenderer(),
      composer: new FakeMessageComposer(),
      submit: new FakeMailSubmit(),
      sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    },
    ...(options.agent
      ? { agent: { runtime: new DemoAgentRuntime(), visibleText, kickDebounceMs: 5 } }
      : {}),
  });
  cleanups.push(() => runtime.stop());

  const reader = createSqliteReader(dbPath);
  cleanups.push(() => reader.close());
  let nextId = 0;
  const commands: string[] = [];
  const host = {
    command: (command: WorkerCommand) =>
      new Promise((ok, fail) => {
        const id = ++nextId;
        commands.push(command.name);
        waiting.set(id, { ok, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
  } as unknown as SyncHost;
  const reads = {
    insights: reader.read.agentInsights,
    settings: reader.read.agentSettings,
    store: reader.read.store,
    accounts: reader.read.accounts,
  };
  const deps = {
    agent: new RemoteAgent(host, reads, readsHere(reads)),
  } as unknown as BackendDeps;
  const ask = (request: object) => handle(deps, { requestId: "r", ...request });
  return { storage, reader, posted, commands, ask };
}

async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** A thread of the demo account with mail from someone else in it, which a turn may read. */
async function someThread(storage: ReturnType<typeof createSqliteStorage>): Promise<string> {
  const own = new Set((await storage.accounts.list()).map((a) => a.address.toLowerCase()));
  const threads = await storage.store.listThreadsSince(0, 500);
  const found = threads.find(
    (t) =>
      t.accountId === "acc1" &&
      !t.lastFromOwn &&
      t.messages.some((m) => !own.has(m.from.toLowerCase()) && m.automated !== true),
  );
  if (found === undefined) throw new Error("no thread");
  return found.threadId;
}

describe("agents in the sync worker", () => {
  it("do nothing at all with AI off: nothing is asked, nothing is posted", async () => {
    const h = await boot({ agent: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(h.posted.filter((m) => m.type === "agent")).toEqual([]);
    expect(await h.ask({ type: "agentJournal" })).toMatchObject({ entries: [] });
    const threadId = await someThread(h.storage);
    expect(await h.ask({ type: "agentThread", threadId })).toMatchObject({
      view: { available: false, prepared: null },
    });
    expect(h.commands).toEqual([]);
  });

  it("turns on over the wire, tests the runtime by itself, tells the router, and reads from the reader", async () => {
    const h = await boot({ agent: true });
    const on = await h.ask({
      type: "agentSetEnabled",
      accountIds: ["acc1"],
      runtimeId: "claude-code",
    });
    expect(on).toMatchObject({
      type: "agentSetEnabled",
      ok: true,
      status: { settings: { enabled: true } },
    });

    await until(async () => {
      const r = (await h.ask({ type: "agentStatus" })) as unknown as {
        status: { progress: { state: string }; runtime: { status: string } | null };
      };
      return r.status.progress.state === "idle" && r.status.runtime?.status === "ready";
    }, "the runtime to be tested and the pass to end");
    expect(h.posted.some((m) => m.type === "agent")).toBe(true);

    const threadId = await someThread(h.storage);
    expect(await h.ask({ type: "agentThread", threadId })).toMatchObject({
      view: { available: true, prepared: null },
    });

    // The person asks for a draft, and sends it by the existing path: here only a draft is made.
    const prepared = await h.ask({ type: "agentPrepare", threadId, answer: "Piątek pasuje." });
    expect(prepared, JSON.stringify(prepared)).toMatchObject({
      type: "agentPrepare",
      prepared: { kind: "draft" },
    });
    // What was prepared is read back from the reader, under the thread's last message.
    expect(await h.ask({ type: "agentThread", threadId })).toMatchObject({
      view: { available: true, prepared: { kind: "draft" } },
    });
    const made = (await h.ask({
      type: "agentDraftFromPrepared",
      threadId,
      body: "Dzień dobry,\n\nPiątek pasuje.",
    })) as unknown as { draftId: string; existing: boolean };
    expect(made.existing).toBe(false);
    const draft = await h.storage.drafts.get(made.draftId);
    expect(draft?.bodyMarkdown.startsWith("Dzień dobry,\n\nPiątek pasuje.")).toBe(true);
    expect(draft?.to.length).toBeGreaterThan(0);
    // Nothing was queued for sending.
    expect(await h.storage.outbox.listVisible(0)).toEqual([]);

    const off = await h.ask({ type: "agentDisable" });
    expect(off).toMatchObject({ status: { settings: { enabled: false }, consents: [] } });
    expect(await h.ask({ type: "agentThread", threadId })).toMatchObject({
      view: { available: false, prepared: null },
    });
  });

  it("answers that agents are not available when no runtime was given", async () => {
    const h = await boot({ agent: false });
    expect(await h.ask({ type: "agentStatus" })).toMatchObject({ type: "error", code: "internal" });
    // The reads still work on the reader: AI is simply off.
    expect(await h.ask({ type: "agentJournal" })).toMatchObject({ entries: [] });
  });
});
