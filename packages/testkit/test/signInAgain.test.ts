import type { Credential, StoredAccount } from "@matters/core";
import {
  AccountNotFoundError,
  OutgoingServerError,
  RejectedPasswords,
  SignInEndedError,
  signInAgain,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  createInMemoryStorage,
  FakeMailConnector,
  FakeMailError,
  FakeMailSubmit,
  FakeMailSync,
  InMemoryCredentialStore,
} from "../src/index.ts";

const OLD: Credential = {
  kind: "oauth2",
  provider: "microsoft",
  accessToken: "old-access",
  refreshToken: "old-refresh",
  expiresAtMs: 1000,
};
const NEW_TOKEN = "eyJ0.new-access.sig";
const NEW: Credential = {
  kind: "oauth2",
  provider: "microsoft",
  accessToken: NEW_TOKEN,
  refreshToken: "new-refresh",
  expiresAtMs: 9000,
};
const ACCOUNT: StoredAccount = {
  id: "acc1",
  address: "me@outlook.example",
  displayName: "Me",
  imap: {
    host: "outlook.office365.com",
    port: 993,
    security: "tls",
    username: "me@outlook.example",
  },
  smtp: {
    host: "smtp.office365.com",
    port: 587,
    security: "starttls",
    username: "me@outlook.example",
  },
  createdAtMs: 1,
};

async function setup() {
  const storage = createInMemoryStorage();
  await storage.accounts.add(ACCOUNT);
  const connector = new FakeMailConnector(new FakeMailSync(["INBOX"]));
  const credentials = new InMemoryCredentialStore();
  await credentials.set("acc1", OLD);
  await credentials.set("handle-1", NEW);
  const outgoing = new FakeMailSubmit();
  const rejected = new RejectedPasswords();
  rejected.note("acc1", {
    state: "error",
    kind: "auth",
    message: "",
    detail: { refusal: "signInAgain" },
  });
  const deps = { accounts: storage.accounts, credentials, connector, outgoing, rejected };
  return { storage, connector, credentials, outgoing, rejected, deps };
}

describe("signInAgain (ADR 0133, rule 11)", () => {
  it("tests both servers with the new token, then replaces the stored one and ends the mark", async () => {
    const t = await setup();
    expect(t.rejected.has("acc1")).toBe(true);
    t.connector.acceptedTokens.add(NEW_TOKEN);

    const result = await signInAgain(t.deps, { accountId: "acc1", signIn: "handle-1" });

    expect(result).toEqual({ account: ACCOUNT, outgoing: { state: "verified" } });
    expect(await t.credentials.get("acc1")).toEqual(NEW);
    expect(await t.credentials.get("handle-1")).toBeNull();
    expect(t.outgoing.verified).toEqual([{ server: ACCOUNT.smtp, credential: NEW }]);
    expect(t.rejected.has("acc1")).toBe(false);
  });

  it("keeps the stored sign-in and drops the new one when the incoming server refuses it", async () => {
    const t = await setup();
    t.connector.connectErrors.push(new FakeMailError("auth", `no ${NEW_TOKEN}`));
    const error = await signInAgain(t.deps, { accountId: "acc1", signIn: "handle-1" }).catch(
      (e: unknown) => e as Error,
    );
    expect(error).toMatchObject({ kind: "auth" });
    expect((error as Error).message).not.toContain(NEW_TOKEN);
    expect(await t.credentials.get("acc1")).toEqual(OLD);
    expect(await t.credentials.get("handle-1")).toBeNull();
    expect(t.rejected.has("acc1")).toBe(true);
  });

  it("keeps the stored sign-in when the outgoing server refuses the token", async () => {
    const t = await setup();
    t.outgoing.outgoing = { ok: false, kind: "auth", reason: `535 ${NEW_TOKEN}` };
    const error = await signInAgain(t.deps, { accountId: "acc1", signIn: "handle-1" }).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OutgoingServerError);
    expect((error as Error).message).not.toContain(NEW_TOKEN);
    expect(await t.credentials.get("acc1")).toEqual(OLD);
    expect(await t.credentials.get("handle-1")).toBeNull();
  });

  it("replaces it when the outgoing server could not be asked (ADR 0113, rule 3)", async () => {
    const t = await setup();
    t.outgoing.outgoing = { ok: false, kind: "unreachable", reason: "timeout" };
    const result = await signInAgain(t.deps, { accountId: "acc1", signIn: "handle-1" });
    expect(result.outgoing).toEqual({ state: "unchecked", reason: "timeout" });
    expect(await t.credentials.get("acc1")).toEqual(NEW);
  });

  it("says the sign-in has ended when the handle holds nothing", async () => {
    const t = await setup();
    await t.credentials.delete("handle-1");
    await expect(
      signInAgain(t.deps, { accountId: "acc1", signIn: "handle-1" }),
    ).rejects.toBeInstanceOf(SignInEndedError);
    expect(t.connector.connects).toBe(0);
    expect(await t.credentials.get("acc1")).toEqual(OLD);
  });

  it("drops the sign-in for an account that is gone", async () => {
    const t = await setup();
    await expect(
      signInAgain(t.deps, { accountId: "gone", signIn: "handle-1" }),
    ).rejects.toBeInstanceOf(AccountNotFoundError);
    expect(await t.credentials.get("handle-1")).toBeNull();
  });
});
