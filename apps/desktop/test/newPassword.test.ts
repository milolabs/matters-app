import type {
  Credential,
  CredentialPort,
  OutgoingCheck,
  SignInRefusal,
  SyncStatus,
} from "@matters/core";
import {
  MAX_PASSWORD_LENGTH,
  PasswordRejectedError,
  RejectedPasswords,
  SyncScheduler,
} from "@matters/core";
import {
  createInMemoryStorage,
  FakeComposeRenderer,
  FakeMailConnector,
  FakeMailSync,
  InMemoryCredentialStore,
  ManualClock,
  settle,
} from "@matters/testkit";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import { AccountService } from "../src/backend/accounts.ts";
import { handle } from "../src/backend/handler.ts";
import { BackendError } from "../src/renderer/client.ts";
import { refusalSentence, signInTrouble } from "../src/renderer/explain.ts";
import {
  createNewPassword,
  newPasswordFailure,
  newPasswordSaved,
  passwordRejected,
  signInStopped,
} from "../src/renderer/newPassword.ts";
import { describeStatus } from "../src/renderer/status.ts";
import { imageDeps, noCounts, noSend, noViewWrites } from "./support/noSend.ts";

const OLD = "old-Pa$$w0rd-1";
const NEW = "new-Pa$$w0rd-2";
const IMAP = { host: "imap.example.com", port: 993, security: "tls" as const, username: "me" };
const SMTP = { host: "smtp.example.com", port: 465, security: "tls" as const, username: "me" };

/** The vault, with a switch that makes its next write fail as a disk would. */
class FlakyVault implements CredentialPort {
  readonly inner = new InMemoryCredentialStore();
  failWrites = false;
  writes = 0;
  availability() {
    return this.inner.availability();
  }
  get(accountId: string) {
    return this.inner.get(accountId);
  }
  async set(accountId: string, credential: Credential) {
    this.writes++;
    if (this.failWrites) throw new Error(`could not write the vault file (${NEW} not saved)`);
    return this.inner.set(accountId, credential);
  }
  delete(accountId: string) {
    return this.inner.delete(accountId);
  }
}

function setup() {
  const storage = createInMemoryStorage();
  const server = new FakeMailSync(["INBOX"]);
  const connector = new FakeMailConnector(server);
  const credentials = new FlakyVault();
  const clock = new ManualClock();
  const statuses: { accountId: string; status: SyncStatus }[] = [];
  const rejected = new RejectedPasswords();
  // What the outgoing server answers, and the passwords it was asked with.
  let outgoing: (password: string) => OutgoingCheck = () => ({ ok: true });
  const verified: string[] = [];
  const scheduler = new SyncScheduler({
    connector,
    accounts: storage.accounts,
    credentials,
    sync: storage,
    clock,
    onStatus: (accountId, status) => {
      rejected.note(accountId, status);
      statuses.push({ accountId, status });
    },
  });
  let changes = 0;
  const accounts = new AccountService({
    accounts: storage.accounts,
    add: {
      accounts: storage.accounts,
      credentials,
      connector,
      outgoing: {
        verify: async (target) => {
          const password = target.credential.kind === "password" ? target.credential.password : "";
          verified.push(password);
          return outgoing(password);
        },
      },
      newId: () => "acc1",
      now: () => 1000,
    },
    remove: { ...storage, credentials },
    discovery: { discover: async () => null },
    scheduler,
    rejected,
    onChanged: () => changes++,
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
  const call = (request: object) => handle(deps, { requestId: "r", ...request });
  const change = (password: string, accountId = "acc1") =>
    call({ type: "changePassword", accountId, password });
  /** An account added with the old password, whose server now takes only the new one. */
  async function revoked(options: { smtp?: boolean; refusal?: SignInRefusal } = {}) {
    const added = await call({
      type: "addAccount",
      address: "me@example.com",
      password: OLD,
      imap: IMAP,
      ...(options.smtp ? { smtp: SMTP } : {}),
    });
    expect(added).toMatchObject({ ok: true });
    await settle();
    verified.length = 0;
    connector.acceptedPasswords.add(NEW);
    if (options.refusal) connector.refusal = { refusal: options.refusal };
    scheduler.syncNow("acc1");
    await settle();
    expect(scheduler.status("acc1")).toMatchObject({ state: "error", kind: "auth" });
  }
  const saved = async () => {
    const credential = await credentials.get("acc1");
    return credential?.kind === "password" ? credential.password : null;
  };
  return {
    storage,
    server,
    connector,
    credentials,
    clock,
    scheduler,
    rejected,
    statuses,
    verified,
    call,
    change,
    revoked,
    saved,
    setOutgoing: (fn: (password: string) => OutgoingCheck) => {
      outgoing = fn;
    },
    changes: () => changes,
  };
}

const noSecret = (value: unknown) => {
  expect(JSON.stringify(value)).not.toContain(NEW);
  expect(JSON.stringify(value)).not.toContain(OLD);
};

describe("a refused password before the new one", () => {
  it("is not tried again by the sync, however long the app runs", async () => {
    const t = setup();
    await t.revoked();
    const tries = t.connector.connects;
    await t.clock.advance(6 * 60 * 60_000);
    await settle();
    expect(t.connector.connects).toBe(tries);
    expect(t.clock.pendingDelays()).toEqual([]);
    await t.scheduler.stop();
  });

  it("is kept from work that logs in on its own", async () => {
    const t = setup();
    await t.revoked();
    expect(t.rejected.has("acc1")).toBe(true);
    const guarded = t.rejected.guard(t.credentials);
    await expect(guarded.get("acc1")).rejects.toBeInstanceOf(PasswordRejectedError);
    await expect(guarded.get("acc1")).rejects.toMatchObject({ kind: "auth" });
    // Other accounts, and the vault's other doors, are untouched.
    expect(await guarded.get("acc2")).toBeNull();
    expect(await guarded.availability()).toEqual({ available: true });
    await t.scheduler.stop();
  });

  it("is kept back for any refusal the person must end, and never for a temporary one", async () => {
    for (const refusal of [
      "imapOff",
      "webLogin",
      "notAllowed",
      "browserOnly",
      "expired",
    ] as const) {
      const t = setup();
      await t.revoked({ refusal });
      expect(t.rejected.has("acc1")).toBe(true);
      await expect(t.rejected.guard(t.credentials).get("acc1")).rejects.toMatchObject({
        kind: "auth",
        detail: { refusal },
      });
      await t.scheduler.stop();
    }
    for (const refusal of ["throttled", "unavailable"] as const) {
      const t = setup();
      await t.revoked({ refusal });
      expect(t.rejected.has("acc1")).toBe(false);
      expect(await t.rejected.guard(t.credentials).get("acc1")).toMatchObject({ password: OLD });
      // Tried again by itself, slowly; once the server takes it, the account syncs.
      const tries = t.connector.connects;
      t.connector.acceptedPasswords.add(OLD);
      await t.clock.advance(60_000);
      await settle();
      expect(t.connector.connects).toBe(tries + 1);
      expect(t.scheduler.status("acc1")).toMatchObject({ state: "idle" });
      await t.scheduler.stop();
    }
  });

  it("a settled sync without error opens the door again", () => {
    const r = new RejectedPasswords();
    r.note("a", { state: "error", kind: "auth", message: "no" });
    r.note("a", { state: "syncing", folder: "", done: 0 });
    expect(r.has("a")).toBe(true);
    r.note("a", { state: "error", kind: "unreachable", message: "offline" });
    expect(r.has("a")).toBe(true);
    r.note("a", { state: "idle" });
    expect(r.has("a")).toBe(false);
  });
});

describe("changePassword: verify, then replace", () => {
  it("logs in with the new password, replaces the saved one and syncs again at once", async () => {
    const t = setup();
    await t.revoked({ smtp: true });
    t.server.add("INBOX", "kept while the password was wrong");
    const before = await t.storage.store.listNewest({ limit: 10 });

    const r = await t.change(NEW);

    expect(r).toMatchObject({
      type: "changePassword",
      ok: true,
      outgoing: "verified",
      account: { id: "acc1", status: { state: "syncing" } },
    });
    noSecret(r);
    expect(t.verified).toEqual([NEW]);
    expect(await t.saved()).toBe(NEW);
    expect(t.rejected.has("acc1")).toBe(false);
    expect(t.changes()).toBeGreaterThan(0);

    await settle();
    expect(t.scheduler.status("acc1")).toMatchObject({ state: "idle" });
    expect(t.connector.watchesOpen).toBe(1);
    // Nothing local was lost; the mail that came meanwhile arrives.
    const after = await t.storage.store.listNewest({ limit: 10 });
    expect(after.length).toBe(before.length + 1);
    await t.scheduler.stop();
  });

  it("keeps the old password when the incoming server refuses the new one", async () => {
    const t = setup();
    await t.revoked({ smtp: true });
    const r = await t.change("still-wrong");
    expect(r).toMatchObject({ type: "error", code: "authFailed" });
    expect(JSON.stringify(r)).not.toContain("still-wrong");
    expect(await t.saved()).toBe(OLD);
    expect(t.credentials.writes).toBe(1);
    // The outgoing server is not asked with a password the incoming one refused.
    expect(t.verified).toEqual([]);
    expect(t.rejected.has("acc1")).toBe(true);
    await t.scheduler.stop();
  });

  it("keeps the old password when the outgoing server refuses the new one", async () => {
    const t = setup();
    await t.revoked({ smtp: true });
    t.setOutgoing((password) => ({
      ok: false,
      kind: "auth",
      reason: `535 authentication failed for ${password}`,
    }));
    const r = await t.change(NEW);
    expect(r).toMatchObject({ type: "error", code: "outgoingAuthFailed" });
    noSecret(r);
    expect(await t.saved()).toBe(OLD);
    expect(t.rejected.has("acc1")).toBe(true);
    await t.scheduler.stop();
  });

  it("saves it when the outgoing server cannot be asked, and says so", async () => {
    const t = setup();
    await t.revoked({ smtp: true });
    t.setOutgoing(() => ({ ok: false, kind: "unreachable", reason: "Could not reach the server" }));
    const r = await t.change(NEW);
    expect(r).toMatchObject({
      ok: true,
      outgoing: "unchecked",
      outgoingNote: "Could not reach the server",
    });
    expect(await t.saved()).toBe(NEW);
    await t.scheduler.stop();
  });

  it("asks no outgoing server for an account that does not send", async () => {
    const t = setup();
    await t.revoked();
    expect(await t.change(NEW)).toMatchObject({ ok: true, outgoing: "none" });
    expect(t.verified).toEqual([]);
    await t.scheduler.stop();
  });

  it("keeps the old password, and the account waiting, when the vault cannot be written", async () => {
    const t = setup();
    await t.revoked();
    t.credentials.failWrites = true;
    const tries = t.connector.connects;
    const r = await t.change(NEW);
    expect(r).toMatchObject({ type: "error", ok: false, code: "internal" });
    noSecret(r);
    expect(await t.saved()).toBe(OLD);
    expect(t.rejected.has("acc1")).toBe(true);
    await settle();
    // Only the test login: the sync did not start again with a password that was not saved.
    expect(t.connector.connects).toBe(tries + 1);
    expect(t.scheduler.status("acc1")).toMatchObject({ state: "error", kind: "auth" });
    await t.scheduler.stop();
  });

  it("refuses when the vault cannot protect a password, before any login", async () => {
    const t = setup();
    await t.revoked();
    t.credentials.inner.unavailableReason = "No keyring is available";
    const tries = t.connector.connects;
    expect(await t.change(NEW)).toMatchObject({ code: "credentialsUnavailable" });
    expect(t.connector.connects).toBe(tries);
    await t.scheduler.stop();
  });
});

describe("changePassword: the request", () => {
  it("validates what it carries", async () => {
    const t = setup();
    await t.revoked();
    expect(await t.call({ type: "changePassword", password: NEW })).toMatchObject({
      code: "invalidRequest",
    });
    expect(await t.call({ type: "changePassword", accountId: "", password: NEW })).toMatchObject({
      code: "invalidRequest",
    });
    expect(await t.call({ type: "changePassword", accountId: "acc1", password: 7 })).toMatchObject({
      code: "invalidRequest",
    });
    expect(
      await t.call({ type: "changePassword", accountId: "x".repeat(201), password: NEW }),
    ).toMatchObject({ code: "invalidRequest" });
    expect(await t.change("")).toMatchObject({ code: "invalidAccount" });
    expect(await t.change("x".repeat(MAX_PASSWORD_LENGTH + 1))).toMatchObject({
      code: "invalidAccount",
      message: "That password is too long",
    });
    expect(await t.change(NEW, "nobody")).toMatchObject({ code: "notFound" });
    expect(await t.saved()).toBe(OLD);
    await t.scheduler.stop();
  });
});

describe("the new password form", () => {
  const account = { id: "acc1", host: "imap.example.com", port: 993 };

  it("knows a refused password from other trouble", () => {
    expect(passwordRejected({ state: "error", kind: "auth", message: "" })).toBe(true);
    expect(passwordRejected({ state: "error", kind: "unreachable", message: "" })).toBe(false);
    expect(passwordRejected({ state: "idle" })).toBe(false);
  });

  // reason → background work stops? → the password form opens?
  it.each([
    ["credentials", true, true],
    ["appPassword", true, true],
    ["expired", true, true],
    ["unknown", true, true],
    ["webLogin", true, false],
    ["imapOff", true, false],
    ["notAllowed", true, false],
    ["browserOnly", true, false],
    ["encryptionRequired", true, false],
    ["unavailable", false, false],
    ["throttled", false, false],
  ] as const)("%s: stops %s, asks for a password %s", (refusal, stops, form) => {
    const status: SyncStatus = { state: "error", kind: "auth", message: "", detail: { refusal } };
    expect(signInStopped(status)).toBe(stops);
    expect(passwordRejected(status)).toBe(form);
    // The row and the status line say the reason, not only "Password rejected".
    const label = describeStatus(status).text;
    expect(label === "Password rejected").toBe(refusal === "credentials" || refusal === "unknown");
    expect(signInTrouble(status, account.host)?.sentence).toBe(
      refusalSentence(refusal, account.host, "status"),
    );
  });

  it("gives every reason a next step that exists where it is read", () => {
    const reasons: SignInRefusal[] = [
      "credentials",
      "appPassword",
      "webLogin",
      "imapOff",
      "browserOnly",
      "notAllowed",
      "expired",
      "encryptionRequired",
      "unavailable",
      "throttled",
      "unknown",
    ];
    for (const refusal of reasons) {
      for (const place of ["newPassword", "status"] as const) {
        const text = refusalSentence(refusal, account.host, place);
        // Neither the form nor the row has server settings or a user name to change.
        expect(text).not.toMatch(/settings above|Check both/);
      }
      // A refusal the sync waits on says how to try again; a temporary one, that it will.
      const row = refusalSentence(refusal, account.host, "status");
      if (refusal === "webLogin" || refusal === "imapOff" || refusal === "notAllowed") {
        expect(row).toContain("Sync now");
      }
      if (refusal === "unavailable" || refusal === "throttled") expect(row).toContain("by itself");
    }
  });

  it("quotes the server under the row's sentence", () => {
    const status: SyncStatus = {
      state: "error",
      kind: "auth",
      message: "",
      detail: { refusal: "imapOff", serverText: "IMAP access is disabled for this account" },
    };
    expect(signInTrouble(status, account.host)?.evidence).toBe(
      "The server said: “IMAP access is disabled for this account”",
    );
    expect(signInTrouble({ state: "idle" }, account.host)).toBeUndefined();
  });

  it("drops the password once the backend answers yes, and says what happens next", async () => {
    const sent: string[] = [];
    let release: () => void = () => {};
    const backend = {
      changePassword: (_id: string, password: string) => {
        sent.push(password);
        return new Promise<never>((resolve) => {
          release = () =>
            resolve({
              type: "changePassword",
              requestId: "r",
              ok: true,
              account: {},
              outgoing: "verified",
            } as never);
        });
      },
    };
    await createRoot(async (dispose) => {
      const form = createNewPassword(backend, account);
      expect(form.canSubmit()).toBe(false);
      expect(await form.submit()).toBe(false);
      form.setPassword(NEW);
      expect(form.canSubmit()).toBe(true);
      const done = form.submit();
      expect(form.phase()).toBe("checking");
      expect(form.canSubmit()).toBe(false);
      // A second press while checking sends nothing more.
      expect(await form.submit()).toBe(false);
      release();
      expect(await done).toBe(true);
      expect(sent).toEqual([NEW]);
      expect(form.phase()).toBe("saved");
      expect(form.password()).toBe("");
      expect(form.saved()).toBe("Password saved. Syncing again.");
      dispose();
    });
  });

  it("drops the password on a refusal too, and says the saved one is unchanged", async () => {
    const backend = {
      changePassword: async () => {
        throw new BackendError("authFailed", "authentication failed", {
          refusal: "credentials",
          serverText: "Invalid credentials",
        });
      },
    };
    await createRoot(async (dispose) => {
      const form = createNewPassword(backend, account);
      form.setPassword("typo");
      expect(await form.submit()).toBe(false);
      expect(form.phase()).toBe("editing");
      expect(form.password()).toBe("");
      expect(form.failure()).toBe(
        `${refusalSentence("credentials", account.host, "newPassword")} The saved password is unchanged.`,
      );
      // The server's own words go under it.
      expect(form.evidence()).toBe("The server said: “Invalid credentials”");
      // Typing again clears the old failure.
      form.setPassword("t");
      expect(form.failure()).toBe("");
      expect(form.evidence()).toBe("");
      dispose();
    });
  });

  it("explains each refusal in plain words", () => {
    expect(newPasswordFailure(new BackendError("outgoingAuthFailed", "535"), account)).toBe(
      "Receiving works with this password, but the outgoing server refused it, so sending wouldn't. The saved password is unchanged.",
    );
    // A reason more specific than a wrong password says so.
    expect(
      newPasswordFailure(
        new BackendError("outgoingAuthFailed", "535", { refusal: "notAllowed" }),
        account,
      ),
    ).toContain(refusalSentence("notAllowed", "", "newPassword"));
    expect(newPasswordFailure(new BackendError("unreachable", "x"), account)).toContain(
      "Could not reach imap.example.com:993",
    );
    expect(newPasswordFailure(new BackendError("notFound", "x"), account)).toBe(
      "This account is no longer on this computer.",
    );
    expect(newPasswordFailure(new BackendError("internal", "disk full"), account)).toBe(
      "The password was not changed: disk full. The saved password is unchanged.",
    );
    expect(newPasswordFailure(new Error("?"), account)).toBe(
      "Something went wrong. The saved password is unchanged.",
    );
    expect(newPasswordSaved({ outgoing: "unchecked", outgoingNote: "offline" })).toBe(
      "Password saved. Syncing again. The outgoing server could not be asked (offline); the first send will tell.",
    );
  });
});
