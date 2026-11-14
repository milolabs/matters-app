// ADR 0136 end to end below the window: a Microsoft mailbox added over Microsoft Graph. Main's
// sign-in service against the stand-in authorization server with the Graph entry, the renewing
// vault served over the credential RPC, and the sync runtime with the real Graph adapters picked
// by transport, against the stand-in Graph service. Real SQLite; no Microsoft server is asked.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { GraphConnector, GraphSubmitter, RefusedTokens } from "@matters/adapter-graph";
import { PostalMimeParser } from "@matters/adapter-mime";
import { BrowserOAuth } from "@matters/adapter-oauth";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import {
  type OAuthCredential,
  RenewingCredentialStore,
  type RpcPort,
  serveCredentials,
} from "@matters/adapter-secrets";
import { NodemailerComposer } from "@matters/adapter-smtp";
import { createSqliteStorage, type SqliteStorage } from "@matters/adapter-sqlite";
import type { MailConnectorPort, MailSubmitPort, SyncStatus } from "@matters/core";
import {
  FakeFileWork,
  InMemoryCredentialStore,
  type StandInAuthServer,
  type StandInGraphServer,
  startStandInAuthServer,
  startStandInGraphServer,
} from "@matters/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  CommandResult,
  FromWorker,
  ToWorker,
  WorkerChannel,
  WorkerCommand,
} from "../src/backend/protocol.ts";
import { startSyncRuntime, systemClock } from "../src/backend/syncRuntime.ts";
import { ConnectorByTransport, SubmitByTransport } from "../src/backend/transports.ts";
import { SignInService } from "../src/main/browserSignIn.ts";

const ADDRESS = "me@outlook.example";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function mime(id: string, subject: string): string {
  return [
    "From: Anna <anna@northwind.example>",
    `To: ${ADDRESS}`,
    `Subject: ${subject}`,
    "Date: Tue, 03 Nov 2026 10:00:00 +0000",
    `Message-ID: <${id}@northwind.example>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    `Body of ${subject}`,
    "",
  ].join("\r\n");
}

/** No IMAP account here: anything that reaches the IMAP side is a wrong pick. */
const noImap: MailConnectorPort = {
  connect: async () => {
    throw new Error("An IMAP connection was opened for a Graph account");
  },
  watchInbox: async () => {
    throw new Error("An IMAP watch was opened for a Graph account");
  },
};
const noSmtp: MailSubmitPort = {
  submit: async () => {
    throw new Error("SMTP was used for a Graph account");
  },
  verify: async () => ({ ok: false, kind: "other", reason: "SMTP was used for a Graph account" }),
};

interface Rig {
  readonly auth: StandInAuthServer;
  readonly graph: StandInGraphServer;
  readonly storage: SqliteStorage;
  readonly vault: InMemoryCredentialStore;
  readonly signIns: SignInService;
  readonly messages: FromWorker[];
  /** Tokens the stand-in Graph service no longer takes. */
  readonly revoked: Set<string>;
  call<C extends WorkerCommand>(command: C): Promise<CommandResult<C>>;
  statuses(accountId: string): SyncStatus[];
  signIn(): Promise<string>;
}

async function open(): Promise<Rig> {
  const auth = await startStandInAuthServer();
  cleanups.push(() => auth.stop());
  const revoked = new Set<string>();
  // The stand-in takes what the stand-in sign-in issued, as Graph takes Microsoft's tokens.
  const graph = await startStandInGraphServer({
    accepts: (token) => auth.accessTokens.includes(token) && !revoked.has(token),
  });
  cleanups.push(() => graph.stop());

  // Main: the sign-in with the Graph entry (ADR 0136, rule 3), the vault and its renewal.
  const oauth = new BrowserOAuth({
    clientIds: { microsoft: auth.clientId, microsoftGraph: auth.clientId },
    authority: auth.authority,
    openBrowser: (url) => auth.browse(url),
  });
  const vault = new InMemoryCredentialStore();
  const renewing = new RenewingCredentialStore({ vault, renewal: oauth });
  const signIns = new SignInService({ oauth, hold: (s) => renewing.hold(s) });

  // The worker: the sync runtime over an in-process channel, the adapters by transport.
  const dir = mkdtempSync(join(tmpdir(), "matters-graph-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const storage = createSqliteStorage(join(dir, "matters.db"), { reader: false });
  const handlers: ((m: ToWorker) => void)[] = [];
  const messages: FromWorker[] = [];
  const waiting = new Map<number, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  let nextId = 0;
  let vaultHandler: (data: unknown) => void = () => {};
  const rpc: RpcPort = {
    postMessage: (data) => {
      for (const h of handlers) h({ type: "credentials", data: structuredClone(data) });
    },
    onMessage: (h) => {
      vaultHandler = h;
    },
  };
  serveCredentials(rpc, renewing);
  const channel: WorkerChannel = {
    post(message) {
      messages.push(message);
      if (message.type === "credentials") vaultHandler(structuredClone(message.data));
      if (message.type === "result") {
        const w = waiting.get(message.id);
        waiting.delete(message.id);
        if (message.ok) w?.ok(message.value);
        else
          w?.fail(
            Object.assign(new Error(message.error.message), {
              name: message.error.name,
              ...(message.error.kind === undefined ? {} : { kind: message.error.kind }),
              ...(message.error.detail === undefined ? {} : { detail: message.error.detail }),
            }),
          );
      }
    },
    onMessage: (h) => handlers.push(h),
  };
  const parser = new PostalMimeParser({ registrableDomain });
  const refusedTokens = new RefusedTokens({ renewedByVault: true });
  const runtime = await startSyncRuntime({
    storage,
    connector: new ConnectorByTransport({
      imap: noImap,
      graph: new GraphConnector({ parser, refusedTokens, baseUrl: graph.baseUrl }),
    }),
    refusedTokens,
    channel,
    discovery: { discover: async () => ({ servers: null }) },
    registrableDomain,
    clock: systemClock,
    undoWindowMs: 50,
    files: new FakeFileWork(),
    sending: {
      renderer: new MarkdownComposeRenderer(),
      composer: new NodemailerComposer(),
      submit: new SubmitByTransport({
        smtp: noSmtp,
        graph: new GraphSubmitter({ refusedTokens, baseUrl: graph.baseUrl }),
      }),
      sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    },
  });
  cleanups.push(() => runtime.stop().catch(() => {}));

  return {
    auth,
    graph,
    storage,
    vault,
    signIns,
    messages,
    revoked,
    call: <C extends WorkerCommand>(command: C) =>
      new Promise<CommandResult<C>>((ok, fail) => {
        const id = ++nextId;
        waiting.set(id, { ok: ok as (v: unknown) => void, fail });
        for (const h of handlers) h({ type: "command", id, command });
      }),
    statuses: (accountId) =>
      messages.flatMap((m) => (m.type === "status" && m.accountId === accountId ? [m.status] : [])),
    async signIn() {
      const answer = await signIns.start(1, "microsoftGraph", ADDRESS);
      if (!answer.ok) throw new Error(`sign-in failed: ${answer.reason}`);
      return answer.handle;
    },
  };
}

const lastStatus = (rig: Rig, id: string) => rig.statuses(id).at(-1);
const idle = (rig: Rig, id: string) =>
  vi.waitFor(() => expect(lastStatus(rig, id)).toMatchObject({ state: "idle" }), {
    timeout: 10_000,
    interval: 20,
  });
const all = async (rig: Rig) =>
  rig.storage.store.getByKeys((await rig.storage.store.changesSince(0)).changedKeys);

async function addGraphAccount(rig: Rig) {
  const handle = await rig.signIn();
  const added = await rig.call({
    name: "addAccount",
    transport: "graph",
    address: ADDRESS,
    displayName: "",
    signIn: handle,
  });
  return added.account.id;
}

describe("a Microsoft mailbox added over Graph (ADR 0136, rules 2 to 4, 13)", () => {
  it("signs in with Graph's scopes, is stored with no servers, syncs, sends, moves and marks read", async () => {
    const rig = await open();
    const inbox = rig.graph.addMessage("inbox", mime("m1", "Quarterly numbers"));
    rig.graph.addMessage("inbox", mime("m2", "Lunch"), { isRead: true });

    const id = await addGraphAccount(rig);
    // The sign-in asked for Graph's mail scopes and nothing of outlook.office.com (rule 3).
    const authorize = rig.auth.requests.find((r) => r.path.endsWith("/authorize"));
    expect(authorize?.params.scope).toContain("Mail.ReadWrite");
    expect(authorize?.params.scope).toContain("Mail.Send");
    expect(authorize?.params.scope).not.toContain("outlook.office.com");

    // Stored with the transport and no server settings (rule 2); the vault holds Graph's entry.
    const stored = await rig.storage.accounts.get(id);
    expect(stored).toMatchObject({ transport: "graph", address: ADDRESS });
    expect(stored && "imap" in stored && stored.imap !== undefined).toBe(false);
    expect(stored && "smtp" in stored && stored.smtp !== undefined).toBe(false);
    expect((await rig.vault.get(id)) as OAuthCredential).toMatchObject({
      kind: "oauth2",
      provider: "microsoftGraph",
    });

    // The first sync brings the stand-in's mail.
    await vi.waitFor(
      async () =>
        expect((await all(rig)).map((m) => m.subject).sort()).toEqual([
          "Lunch",
          "Quarterly numbers",
        ]),
      { timeout: 10_000, interval: 50 },
    );
    await idle(rig, id);
    const numbers = (await all(rig)).find((m) => m.subject === "Quarterly numbers");
    if (!numbers) throw new Error("not synced");

    // Read state: one PATCH to the message (rule 7).
    await rig.call({ name: "setSeen", keys: [numbers.key], seen: true });
    await vi.waitFor(() => expect(rig.graph.messages.get(inbox)?.isRead).toBe(true), {
      timeout: 10_000,
      interval: 20,
    });

    // A move: to the well-known archive folder, same immutable id (rule 7).
    await rig.call({ name: "moveThread", threadId: numbers.threadId, action: "archive" });
    await vi.waitFor(
      () => expect(rig.graph.messages.get(inbox)?.folderId).toBe(rig.graph.wellKnown.archive),
      { timeout: 10_000, interval: 20 },
    );

    // A send goes to sendMail, and no copy is appended: Microsoft keeps it (rule 9).
    const draft = await rig.call({
      name: "saveDraft",
      content: {
        accountId: id,
        from: { address: ADDRESS },
        to: [{ address: "anna@northwind.example" }],
        cc: [],
        bcc: [{ address: "boss@northwind.example" }],
        subject: "Re: Quarterly numbers",
        bodyMarkdown: "Thanks, looks good.",
        inReplyTo: "",
        references: [],
      },
    });
    await rig.call({ name: "requestSend", draftId: draft.id });
    await vi.waitFor(() => expect(rig.graph.sent).toHaveLength(1), {
      timeout: 10_000,
      interval: 20,
    });
    expect(rig.graph.sent[0]?.mime).toContain("Subject: Re: Quarterly numbers");
    expect(rig.graph.sent[0]?.bcc).toEqual(["boss@northwind.example"]);
    expect(rig.graph.requestsTo("/me/mailFolders/sentitems/messages").length).toBe(0);
    // No token ever reached what the window sees.
    const token = rig.auth.accessTokens[0] ?? "";
    expect(JSON.stringify(rig.messages)).not.toContain(token);
  });

  it("asks the vault for a renewed token after a 401, and says signInAgain when that one is refused too (rule 11)", async () => {
    const rig = await open();
    rig.graph.addMessage("inbox", mime("m1", "Hello"));
    const id = await addGraphAccount(rig);
    await idle(rig, id);
    const refreshes = () =>
      rig.auth.requests.filter((r) => r.params.grant_type === "refresh_token").length;
    expect(refreshes()).toBe(0);

    // Graph stops taking the token, which is far from its end.
    const first = rig.auth.accessTokens.at(-1) ?? "";
    rig.revoked.add(first);
    const before = rig.statuses(id).length;
    await rig.call({ name: "syncNow", accountId: id });
    // The first 401 fails the run as a retryable failure, not a refused sign-in.
    await vi.waitFor(
      () =>
        expect(rig.statuses(id).slice(before)).toContainEqual(
          expect.objectContaining({ state: "error", kind: "other" }),
        ),
      { timeout: 10_000, interval: 20 },
    );
    // The retry gets a renewed token from the vault, and the sync goes through with it.
    await rig.call({ name: "syncNow", accountId: id });
    await vi.waitFor(() => expect(refreshes()).toBe(1), { timeout: 10_000, interval: 20 });
    await idle(rig, id);
    const second = rig.auth.accessTokens.at(-1) ?? "";
    expect(second).not.toBe(first);
    expect(((await rig.vault.get(id)) as OAuthCredential).accessToken).toBe(second);

    // A 401 on that fresh token is signInAgain, and nothing renews again by itself.
    rig.revoked.add(second);
    await rig.call({ name: "syncNow", accountId: id });
    await vi.waitFor(
      () =>
        expect(lastStatus(rig, id)).toMatchObject({
          state: "error",
          kind: "auth",
          detail: { refusal: "signInAgain" },
        }),
      { timeout: 15_000, interval: 20 },
    );
    expect(refreshes()).toBe(1);
  });

  it("signs in again with the Graph entry, and the mail moves again", async () => {
    const rig = await open();
    rig.graph.addMessage("inbox", mime("m1", "Hello"));
    const id = await addGraphAccount(rig);
    await idle(rig, id);
    const old = (await rig.vault.get(id)) as OAuthCredential;

    const handle = await rig.signIn();
    const changed = await rig.call({ name: "signInAgain", accountId: id, signIn: handle });
    expect(changed).toMatchObject({ outgoing: "verified", account: { transport: "graph" } });
    const now = (await rig.vault.get(id)) as OAuthCredential;
    expect(now.provider).toBe("microsoftGraph");
    expect(now.accessToken).not.toBe(old.accessToken);
    rig.graph.addMessage("inbox", mime("m2", "After the new sign-in"));
    await rig.call({ name: "syncNow", accountId: id });
    await vi.waitFor(
      async () => expect((await all(rig)).map((m) => m.subject)).toContain("After the new sign-in"),
      { timeout: 10_000, interval: 50 },
    );

    // A sign-in for IMAP's entry is not taken for a Graph account (ADR 0136, Context).
    const imapEntry = await rig.signIns.start(1, "microsoft", ADDRESS);
    if (!imapEntry.ok) throw new Error("sign-in failed");
    await expect(
      rig.call({ name: "signInAgain", accountId: id, signIn: imapEntry.handle }),
    ).rejects.toThrow("another kind of account");
  });
});
