// ADR 0133 end to end below the window: main's sign-in service against a stand-in authorization
// server, the renewing vault served to the backend over the credential RPC, and the backend's
// account commands with fake mail servers.
import { BrowserOAuth } from "@matters/adapter-oauth";
import {
  type OAuthCredential,
  RemoteCredentialPort,
  RenewingCredentialStore,
  type RpcPort,
  serveCredentials,
} from "@matters/adapter-secrets";
import type { BackendResponse } from "@matters/contracts";
import {
  type OutgoingCheck,
  RejectedPasswords,
  SyncScheduler,
  type SyncStatus,
} from "@matters/core";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeMailConnector,
  FakeMailSync,
  InMemoryCredentialStore,
  ManualClock,
  type StandInAuthServer,
  settle,
  startStandInAuthServer,
} from "@matters/testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../src/backend/accounts.ts";
import { handle } from "../src/backend/handler.ts";
import { SignInService } from "../src/main/browserSignIn.ts";
import { signInEnded } from "../src/renderer/newPassword.ts";
import { describeStatus } from "../src/renderer/status.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const ADDRESS = "me@outlook.example";
const IMAP = {
  host: "outlook.office365.com",
  port: 993,
  security: "tls" as const,
  username: ADDRESS,
};
const SMTP = {
  host: "smtp.office365.com",
  port: 587,
  security: "starttls" as const,
  username: ADDRESS,
};
const HOUR = 3600_000;

const servers: StandInAuthServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Two ends of a message port in one process, each message cloned as it would be. */
function portPair(): [RpcPort, RpcPort] {
  const handlers: [((d: unknown) => void)[], ((d: unknown) => void)[]] = [[], []];
  const end = (mine: 0 | 1): RpcPort => ({
    postMessage: (m) => {
      const copy = structuredClone(m);
      queueMicrotask(() => {
        for (const h of handlers[mine === 0 ? 1 : 0]) h(copy);
      });
    },
    onMessage: (h) => handlers[mine].push(h),
  });
  return [end(0), end(1)];
}

async function setup() {
  const auth = await startStandInAuthServer();
  servers.push(auth);
  let nowMs = 1_000_000;
  const now = () => nowMs;
  // Main: the adapter, the vault in its file (here in memory) and the renewing store over it.
  const oauth = new BrowserOAuth({
    clientIds: { microsoft: auth.clientId },
    authority: auth.authority,
    now,
    openBrowser: (url) => auth.browse(url),
  });
  const vault = new InMemoryCredentialStore();
  const renewing = new RenewingCredentialStore({ vault, renewal: oauth, now });
  const signIns = new SignInService({ oauth, hold: (s) => renewing.hold(s) });
  // The backend: what main serves, over the credential port.
  const [mainEnd, backendEnd] = portPair();
  serveCredentials(mainEnd, renewing);
  const credentials = new RemoteCredentialPort(backendEnd);

  const storage = createInMemoryStorage();
  const server = new FakeMailSync(["INBOX"]);
  const connector = new FakeMailConnector(server);
  const clock = new ManualClock();
  const rejected = new RejectedPasswords();
  const statuses: SyncStatus[] = [];
  const outgoingTokens: string[] = [];
  let outgoing: () => OutgoingCheck = () => ({ ok: true });
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials,
    sync: storage,
    clock,
    onStatus: (_id, status) => {
      rejected.note(_id, status);
      statuses.push(status);
    },
  });
  const accounts = new AccountService({
    accounts: storage.accounts,
    add: {
      accounts: storage.accounts,
      credentials,
      connector,
      outgoing: {
        verify: async (target) => {
          if (target.credential.kind === "oauth2")
            outgoingTokens.push(target.credential.accessToken);
          return outgoing();
        },
      },
      newId: () => "acc1",
      now,
    },
    remove: { ...storage, credentials },
    discovery: { discover: async () => ({ servers: null }) },
    scheduler,
    rejected,
    onChanged: () => {},
  });
  const deps = {
    ...storage,
    accountStore: storage.accounts,
    renderer: new FakeComposeRenderer(),
    send: noSend,
    savedViews: { list: async () => [], recentSearches: async () => [] },
    viewWrites: noViewWrites,
    counts: noCounts,
    ...imageDeps,
    accounts,
  };
  const call = (request: object): Promise<BackendResponse> =>
    handle(deps, { requestId: "r", ...request });
  /** The renderer's part: a sign-in in main, then the handle to the backend. */
  async function signIn(owner = 1) {
    const answer = await signIns.start(owner, "microsoft", ADDRESS);
    if (!answer.ok) throw new Error(`sign-in failed: ${answer.reason}`);
    return answer;
  }
  const stored = async () => (await vault.get("acc1")) as OAuthCredential | null;
  return {
    auth,
    vault,
    renewing,
    signIns,
    credentials,
    connector,
    clock,
    scheduler,
    rejected,
    statuses,
    outgoingTokens,
    call,
    signIn,
    stored,
    advance: (ms: number) => {
      nowMs += ms;
    },
    setOutgoing: (fn: () => OutgoingCheck) => {
      outgoing = fn;
    },
  };
}

const addWith = (signIn: string, smtp = true) => ({
  type: "addAccount",
  address: ADDRESS,
  signIn,
  imap: IMAP,
  ...(smtp ? { smtp: SMTP } : {}),
});

describe("main's sign-in service (ADR 0133, rules 2, 5, 6)", () => {
  it("answers a handle and the address, never a token", async () => {
    const t = await setup();
    const answer = await t.signIn();
    expect(answer.handle).toMatch(/^signin-[0-9a-f]{32}$/);
    expect(answer.address).toBe(ADDRESS);
    const json = JSON.stringify(answer);
    for (const token of [...t.auth.accessTokens, ...t.auth.validRefreshTokens]) {
      expect(json).not.toContain(token);
    }
    // The handle holds the sign-in in main; the backend reads its access token only.
    const held = await t.credentials.get(answer.handle);
    expect(held).toMatchObject({ kind: "oauth2", provider: "microsoft" });
    expect(held && "refreshToken" in held).toBe(false);
  });

  it("is ended by the window that asked, not by another window", async () => {
    const t = await setup();
    t.auth.signInAs = null; // the browser page stays open: nothing comes back
    const waiting = t.signIns.start(7, "microsoft", ADDRESS);
    await vi.waitFor(() => expect(t.auth.requests.length).toBeGreaterThan(0));
    expect(t.signIns.waiting(7)).toBe(true);
    t.signIns.cancel(8);
    expect(t.signIns.waiting(7)).toBe(true);
    t.signIns.cancel(7);
    expect(await waiting).toEqual({ ok: false, reason: "notFinished" });
    expect(t.signIns.waiting(7)).toBe(false);
  });

  it("ends the first sign-in when a second one starts", async () => {
    const t = await setup();
    t.auth.signInAs = null;
    const first = t.signIns.start(1, "microsoft", ADDRESS);
    await vi.waitFor(() => expect(t.auth.requests.length).toBe(1));
    t.auth.signInAs = { email: ADDRESS };
    const second = t.signIns.start(2, "microsoft", ADDRESS);
    expect(await first).toEqual({ ok: false, reason: "notFinished" });
    expect(await second).toMatchObject({ ok: true });
  });

  it("passes the provider's refusal on as a reason, holding nothing", async () => {
    const t = await setup();
    t.auth.signInAs = { email: "someone@else.example" };
    expect(await t.signIns.start(1, "microsoft", ADDRESS)).toEqual({
      ok: false,
      reason: "wrongAccount",
      signedIn: "someone@else.example",
      asked: ADDRESS,
    });
    t.auth.authorizeError = { error: "access_denied", description: "AADSTS65001: no consent" };
    expect(await t.signIns.start(1, "microsoft", ADDRESS)).toMatchObject({
      ok: false,
      reason: "adminApproval",
    });
  });

  it("says when the browser answered, so the window comes back to the front (rule 2)", async () => {
    const answers = [
      { ok: true, provider: "microsoft", address: ADDRESS, tokens: TOKENS },
      { ok: false, reason: "adminApproval" },
      { ok: false, reason: "notFinished" },
    ] as const;
    const returned: number[] = [];
    let next = 0;
    const service = new SignInService({
      oauth: { offers: () => true, signIn: async () => answers[next++] ?? answers[2] },
      hold: () => "signin-held",
      returned: (owner) => returned.push(owner),
    });
    await service.start(7, "microsoft", ADDRESS);
    await service.start(8, "microsoft", ADDRESS);
    // Cancelled or out of time: the person is not waiting in the browser.
    await service.start(9, "microsoft", ADDRESS);
    expect(returned).toEqual([7, 8]);
  });

  it("is not offered without a client id (rule 4)", async () => {
    const service = new SignInService({
      oauth: new BrowserOAuth({ clientIds: {}, openBrowser: async () => {} }),
      hold: () => "never",
    });
    expect(service.offered("microsoft")).toBe(false);
    expect(await service.start(1, "microsoft", ADDRESS)).toEqual({
      ok: false,
      reason: "notOffered",
    });
  });
});

const TOKENS = { accessToken: "a", refreshToken: "r", expiresAtMs: 1 };

describe("an account added with a browser sign-in (ADR 0133, rules 5 to 9)", () => {
  it("tests both servers with the token, then moves the sign-in to the account", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    const token = t.auth.accessTokens[0] ?? "";
    t.connector.acceptedTokens.add(token);
    const added = await t.call(addWith(h));
    expect(added).toMatchObject({ type: "addAccount", ok: true, account: { address: ADDRESS } });
    expect(t.outgoingTokens).toEqual([token]);
    // In the vault: the account's entry, refresh token and all; the handle holds nothing now.
    const entry = await t.stored();
    expect(entry).toMatchObject({ kind: "oauth2", provider: "microsoft", accessToken: token });
    expect(t.auth.validRefreshTokens.has(entry?.refreshToken ?? "")).toBe(true);
    expect(await t.credentials.get(h)).toBeNull();
    // The backend's view of it has no refresh token (rule 5).
    const seen = await t.credentials.get("acc1");
    expect(seen).toMatchObject({ kind: "oauth2", accessToken: token });
    expect(seen && "refreshToken" in seen).toBe(false);
    // Nothing the window got back holds a token.
    expect(JSON.stringify(added)).not.toContain(token);
    await t.scheduler.stop();
  });

  it("is renewed when its access token ends soon, and the new refresh token is kept", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    expect(await t.call(addWith(h))).toMatchObject({ ok: true });
    const before = await t.stored();
    t.advance(HOUR - 4 * 60_000); // within 5 minutes of the end
    const renewed = await t.credentials.get("acc1");
    expect(t.auth.requests.filter((r) => r.params.grant_type === "refresh_token")).toHaveLength(1);
    const after = await t.stored();
    expect(renewed).toMatchObject({ kind: "oauth2", accessToken: t.auth.accessTokens.at(-1) });
    expect(after?.accessToken).not.toBe(before?.accessToken);
    expect(after?.refreshToken).not.toBe(before?.refreshToken);
    expect(t.auth.validRefreshTokens.has(after?.refreshToken ?? "")).toBe(true);
    expect(renewed && "refreshToken" in renewed).toBe(false);
    await t.scheduler.stop();
  });

  it("says signInAgain on the account when the refresh token was withdrawn (rule 8)", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    expect(await t.call(addWith(h))).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(t.scheduler.status("acc1")).toMatchObject({ state: "idle" }));
    t.auth.validRefreshTokens.clear(); // withdrawn at Microsoft
    t.advance(2 * HOUR);
    t.scheduler.syncNow("acc1");
    await vi.waitFor(() =>
      expect(t.scheduler.status("acc1")).toMatchObject({
        state: "error",
        kind: "auth",
        detail: { refusal: "signInAgain" },
      }),
    );
    const status = t.scheduler.status("acc1") as SyncStatus;
    // Marked like the other lasting refusals: work that logs in on its own stays away.
    expect(t.rejected.has("acc1")).toBe(true);
    expect(signInEnded(status)).toBe(true);
    expect(describeStatus(status)).toEqual({ tone: "error", text: "Sign-in ended" });
    // And the sync does not try again on its own.
    const refreshes = t.auth.requests.length;
    await t.clock.advance(6 * HOUR);
    await settle();
    expect(t.auth.requests.length).toBe(refreshes);

    // Sign in again: verified on both servers, stored, the mark gone, the sync back.
    const again = await t.signIn();
    const response = await t.call({ type: "signInAgain", accountId: "acc1", signIn: again.handle });
    expect(response).toMatchObject({ type: "signInAgain", ok: true, outgoing: "verified" });
    expect(t.rejected.has("acc1")).toBe(false);
    expect(t.auth.validRefreshTokens.has((await t.stored())?.refreshToken ?? "")).toBe(true);
    await vi.waitFor(() => expect(t.scheduler.status("acc1")).toMatchObject({ state: "idle" }));
    await t.scheduler.stop();
  });

  it("drops the sign-in when a server refuses its token, and keeps nothing", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    t.connector.acceptedTokens.add("some-other-token");
    t.connector.refusal = { refusal: "notAllowed" };
    const refused = await t.call(addWith(h));
    expect(refused).toMatchObject({
      type: "error",
      code: "authFailed",
      detail: { refusal: "notAllowed" },
    });
    expect(await t.credentials.get(h)).toBeNull();
    expect(await t.stored()).toBeNull();
    expect(JSON.stringify(refused)).not.toContain(t.auth.accessTokens[0] ?? "-");
  });

  it("keeps the stored sign-in when sign in again is refused by the outgoing server", async () => {
    const t = await setup();
    const first = await t.signIn();
    expect(await t.call(addWith(first.handle))).toMatchObject({ ok: true });
    const before = await t.stored();
    const again = await t.signIn();
    t.setOutgoing(() => ({
      ok: false,
      kind: "auth",
      reason: "535 5.7.139 Authentication unsuccessful",
    }));
    expect(
      await t.call({ type: "signInAgain", accountId: "acc1", signIn: again.handle }),
    ).toMatchObject({ type: "error", code: "outgoingAuthFailed" });
    expect(await t.stored()).toEqual(before);
    expect(await t.credentials.get(again.handle)).toBeNull();
    await t.scheduler.stop();
  });

  it("takes only a handle of main's shape, never another account's id", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    expect(await t.call(addWith(h))).toMatchObject({ ok: true });
    expect(await t.call(addWith("acc1"))).toMatchObject({ code: "invalidRequest" });
    expect(await t.call({ type: "signInAgain", accountId: "acc1", signIn: "acc1" })).toMatchObject({
      code: "invalidRequest",
    });
    // A password and a handle together, or neither, is refused too.
    expect(await t.call({ ...addWith(h), password: "x" })).toMatchObject({
      code: "invalidRequest",
    });
    const { signIn: _gone, ...neither } = addWith(h);
    expect(await t.call(neither)).toMatchObject({ code: "invalidRequest" });
    await t.scheduler.stop();
  });

  it("says the sign-in ended when its handle was held past its 10 minutes", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    t.advance(11 * 60_000);
    expect(await t.call(addWith(h))).toMatchObject({
      type: "error",
      code: "authFailed",
      detail: { refusal: "signInAgain" },
    });
  });

  it("answers notFound for sign in again on an account that is gone, and drops the handle", async () => {
    const t = await setup();
    const { handle: h } = await t.signIn();
    expect(await t.call({ type: "signInAgain", accountId: "acc-gone", signIn: h })).toMatchObject({
      code: "notFound",
    });
    expect(await t.credentials.get(h)).toBeNull();
  });
});
