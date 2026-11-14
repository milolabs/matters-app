import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, OAuthProvider, TokenRenewal, TokenRenewalPort } from "@matters/core";
import { failureDetailOf, mailErrorKind, SignInEndedError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EncryptedFileCredentialStore,
  type OAuthCredential,
  RemoteCredentialPort,
  RenewingCredentialStore,
  serveCredentials,
} from "../src/index.ts";
import { portPair, TestEncryptor } from "./support.ts";

const MINUTE = 60_000;
const NOW = 1_000_000_000;

/** The token endpoint, answered by the test: each call waits until `answer` is called. */
class ScriptedRenewal implements TokenRenewalPort {
  readonly calls: { provider: OAuthProvider; refreshToken: string }[] = [];
  private waiting: ((answer: TokenRenewal) => void)[] = [];
  /** Answered at once when set. */
  next: TokenRenewal | null = null;

  renew(provider: OAuthProvider, refreshToken: string): Promise<TokenRenewal> {
    this.calls.push({ provider, refreshToken });
    if (this.next) return Promise.resolve(this.next);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  answer(answer: TokenRenewal): void {
    for (const resolve of this.waiting.splice(0)) resolve(answer);
  }
}

const oauth = (over: Partial<OAuthCredential> = {}): OAuthCredential => ({
  kind: "oauth2",
  provider: "microsoft",
  accessToken: "access-1",
  refreshToken: "refresh-1",
  expiresAtMs: NOW + 60 * MINUTE,
  ...over,
});

/** Waits until the renewal has been asked `count` times: the vault's reads take real time. */
const asked = (renewal: ScriptedRenewal, count: number) =>
  vi.waitFor(() => expect(renewal.calls.length).toBeGreaterThanOrEqual(count), { timeout: 2000 });
const settle = () => new Promise((r) => setTimeout(r, 5));

describe("RenewingCredentialStore (ADR 0133, rules 5 to 8)", () => {
  let dir: string;
  let file: string;
  let vault: EncryptedFileCredentialStore;
  let renewal: ScriptedRenewal;
  let now: number;
  let store: RenewingCredentialStore;
  let writes: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matters-renewing-"));
    file = join(dir, "credentials.json");
    const encryptor = new TestEncryptor();
    vault = new EncryptedFileCredentialStore(file, encryptor);
    renewal = new ScriptedRenewal();
    now = NOW;
    let n = 0;
    store = new RenewingCredentialStore({
      vault,
      renewal,
      now: () => now,
      newHandle: () => `handle-${++n}`,
    });
    writes = 0;
    const set = vault.set.bind(vault);
    vault.set = (id, c) => {
      writes++;
      return set(id, c);
    };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hands out a token far from its end as it is, without the refresh token", async () => {
    await vault.set("acc", oauth());
    const got = await store.get("acc");
    expect(got).toEqual({
      kind: "oauth2",
      provider: "microsoft",
      accessToken: "access-1",
      expiresAtMs: NOW + 60 * MINUTE,
    });
    expect(renewal.calls).toEqual([]);
  });

  it("renews a token that ends within 5 minutes, and saves the rotation in one write", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW + 5 * MINUTE }));
    writes = 0;
    renewal.next = {
      ok: true,
      tokens: {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAtMs: NOW + 65 * MINUTE,
      },
    };
    const got = await store.get("acc");
    expect(got).toEqual({
      kind: "oauth2",
      provider: "microsoft",
      accessToken: "access-2",
      expiresAtMs: NOW + 65 * MINUTE,
    });
    expect(renewal.calls).toEqual([{ provider: "microsoft", refreshToken: "refresh-1" }]);
    expect(writes).toBe(1);
    expect(await vault.get("acc")).toEqual(
      oauth({ accessToken: "access-2", refreshToken: "refresh-2", expiresAtMs: NOW + 65 * MINUTE }),
    );
    // Nothing of the tokens is readable in the file.
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("refresh-2");
    expect(raw).not.toContain("access-2");
  });

  it("keeps the refresh token when the provider sends none", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW + MINUTE }));
    renewal.next = {
      ok: true,
      tokens: { accessToken: "access-2", expiresAtMs: NOW + 60 * MINUTE },
    };
    await store.get("acc");
    expect((await vault.get("acc")) as OAuthCredential).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-1",
    });
  });

  it("does not renew 1 ms before the window", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW + 5 * MINUTE + 1 }));
    await store.get("acc");
    expect(renewal.calls).toEqual([]);
    now += 1;
    renewal.next = { ok: true, tokens: { accessToken: "a2", expiresAtMs: now + 60 * MINUTE } };
    await store.get("acc");
    expect(renewal.calls).toHaveLength(1);
  });

  it("joins the callers of one account to one renewal", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW - MINUTE }));
    writes = 0;
    const callers = [store.get("acc"), store.get("acc"), store.get("acc")];
    await asked(renewal, 1);
    await settle();
    expect(renewal.calls).toHaveLength(1);
    renewal.answer({
      ok: true,
      tokens: {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAtMs: NOW + 60 * MINUTE,
      },
    });
    const got = await Promise.all(callers);
    expect(got.map((c) => c?.kind === "oauth2" && c.accessToken)).toEqual([
      "access-2",
      "access-2",
      "access-2",
    ]);
    expect(writes).toBe(1);
    // A caller after the renewal reads the new token and asks nobody.
    expect(await store.get("acc")).toMatchObject({ accessToken: "access-2" });
    expect(renewal.calls).toHaveLength(1);
  });

  it("renews now when asked to, far from the end, joined with one already running (ADR 0136, rule 11)", async () => {
    await vault.set("acc", oauth());
    // Far from its end: no renewal unless asked.
    expect(await store.get("acc")).toMatchObject({ accessToken: "access-1" });
    expect(renewal.calls).toEqual([]);
    const asking = [store.get("acc", { renew: true }), store.get("acc", { renew: true })];
    await asked(renewal, 1);
    await settle();
    expect(renewal.calls).toHaveLength(1);
    renewal.answer({
      ok: true,
      tokens: {
        accessToken: "access-2",
        refreshToken: "refresh-2",
        expiresAtMs: NOW + 60 * MINUTE,
      },
    });
    const got = await Promise.all(asking);
    expect(got.map((c) => c?.kind === "oauth2" && c.accessToken)).toEqual(["access-2", "access-2"]);
    expect(got.some((c) => c !== null && "refreshToken" in c)).toBe(false);
    expect(await vault.get("acc")).toMatchObject({
      accessToken: "access-2",
      refreshToken: "refresh-2",
    });
  });

  it("ignores renew for a password and for a sign-in still held", async () => {
    await vault.set("pw", { kind: "password", username: "u", password: "p" });
    expect(await store.get("pw", { renew: true })).toEqual({
      kind: "password",
      username: "u",
      password: "p",
    });
    const handle = store.hold({ ...oauth(), refreshToken: "r", expiresAtMs: NOW + 60 * MINUTE });
    expect(await store.get(handle, { renew: true })).toMatchObject({ accessToken: "access-1" });
    expect(renewal.calls).toEqual([]);
  });

  it("carries renew over the credential RPC, and only when asked", async () => {
    const ports = portPair();
    serveCredentials(ports.a, store);
    const client = new RemoteCredentialPort(ports.b);
    try {
      await vault.set("acc", oauth());
      expect(await client.get("acc")).toMatchObject({ accessToken: "access-1" });
      expect(renewal.calls).toEqual([]);
      renewal.next = {
        ok: true,
        tokens: { accessToken: "access-2", expiresAtMs: NOW + 60 * MINUTE },
      };
      expect(await client.get("acc", { renew: true })).toMatchObject({ accessToken: "access-2" });
      expect(renewal.calls).toHaveLength(1);
    } finally {
      ports.close();
    }
  });

  it("renews two accounts apart", async () => {
    await vault.set("a", oauth({ expiresAtMs: NOW, refreshToken: "ra" }));
    await vault.set("b", oauth({ expiresAtMs: NOW, refreshToken: "rb" }));
    const both = [store.get("a"), store.get("b")];
    await asked(renewal, 2);
    expect(renewal.calls.map((c) => c.refreshToken).sort()).toEqual(["ra", "rb"]);
    renewal.answer({ ok: true, tokens: { accessToken: "x", expiresAtMs: NOW + 60 * MINUTE } });
    await Promise.all(both);
  });

  it("turns a refused refresh token into a refused sign-in: signInAgain (rule 8)", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW }));
    renewal.next = { ok: false, failure: "signInAgain", reason: "invalid_grant" };
    const error = await store.get("acc").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SignInEndedError);
    expect(mailErrorKind(error)).toBe("auth");
    expect(failureDetailOf(error)).toEqual({ refusal: "signInAgain" });
    // The stored sign-in is kept: Settings offers Sign in again for it.
    expect(await vault.get("acc")).toEqual(oauth({ expiresAtMs: NOW }));
  });

  it("turns an unreachable provider into an unreachable failure (rule 7)", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW }));
    renewal.next = { ok: false, failure: "unreachable", reason: "offline" };
    const error = await store.get("acc").catch((e: unknown) => e);
    expect(mailErrorKind(error)).toBe("unreachable");
    expect(String((error as Error).message)).not.toContain("refresh-1");
    renewal.next = { ok: false, failure: "other", reason: "bad answer" };
    expect(mailErrorKind(await store.get("acc").catch((e: unknown) => e))).toBe("other");
  });

  it("does not write a renewal back over an account removed meanwhile", async () => {
    await vault.set("acc", oauth({ expiresAtMs: NOW }));
    const pending = store.get("acc");
    await asked(renewal, 1);
    await store.delete("acc");
    renewal.answer({ ok: true, tokens: { accessToken: "late", expiresAtMs: NOW + 60 * MINUTE } });
    expect(await pending).toBeNull();
    expect(await vault.get("acc")).toBeNull();
  });

  it("passes a password through as it is", async () => {
    const password: Credential = { kind: "password", username: "me", password: "pw" };
    await store.set("acc", password);
    expect(await store.get("acc")).toEqual(password);
  });

  it("refuses to store a browser sign-in without its refresh token", async () => {
    const { refreshToken: _r, ...bare } = oauth();
    await expect(store.set("acc", bare)).rejects.toThrow(/refresh token/);
    expect(await vault.get("acc")).toBeNull();
  });

  describe("held sign-ins (rule 6)", () => {
    it("holds a sign-in under a handle and hands out its token without the refresh token", async () => {
      const handle = store.hold(oauth());
      expect(handle).toBe("handle-1");
      expect(await store.get(handle)).toEqual({
        kind: "oauth2",
        provider: "microsoft",
        accessToken: "access-1",
        expiresAtMs: NOW + 60 * MINUTE,
      });
      expect(await vault.get(handle)).toBeNull();
    });

    it("makes a random handle by default", () => {
      const plain = new RenewingCredentialStore({ vault, renewal });
      const a = plain.hold(oauth());
      expect(a).toMatch(/^signin-[0-9a-f]{32}$/);
      expect(plain.hold(oauth())).not.toBe(a);
    });

    it("moves it to the account in one write, refresh token and all", async () => {
      const handle = store.hold(oauth());
      writes = 0;
      await store.move(handle, "acc");
      expect(writes).toBe(1);
      expect(await vault.get("acc")).toEqual(oauth());
      expect(await store.get(handle)).toBeNull();
      await expect(store.move(handle, "acc")).rejects.toBeInstanceOf(SignInEndedError);
    });

    it("replaces an account's tokens on a move (Sign in again)", async () => {
      await vault.set("acc", oauth({ accessToken: "old", refreshToken: "old-r" }));
      await store.move(store.hold(oauth({ accessToken: "new", refreshToken: "new-r" })), "acc");
      expect(await vault.get("acc")).toEqual(oauth({ accessToken: "new", refreshToken: "new-r" }));
    });

    it("holds for 10 minutes and no longer", async () => {
      const handle = store.hold(oauth());
      now += 10 * MINUTE - 1;
      expect(await store.get(handle)).not.toBeNull();
      now += 1;
      expect(await store.get(handle)).toBeNull();
      await expect(store.move(handle, "acc")).rejects.toBeInstanceOf(SignInEndedError);
      expect(await vault.get("acc")).toBeNull();
    });

    it("drops a held sign-in on delete without touching the vault", async () => {
      const handle = store.hold(oauth());
      writes = 0;
      await store.delete(handle);
      expect(await store.get(handle)).toBeNull();
      expect(writes).toBe(0);
    });
  });
});

describe("EncryptedFileCredentialStore.move", () => {
  let dir: string;
  let vault: EncryptedFileCredentialStore;
  let encryptor: TestEncryptor;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matters-move-"));
    encryptor = new TestEncryptor();
    vault = new EncryptedFileCredentialStore(join(dir, "credentials.json"), encryptor);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("moves the entry without decrypting it, and replaces what was there", async () => {
    await vault.set("from", oauth());
    await vault.set("to", oauth({ accessToken: "old" }));
    const before = encryptor.encryptions;
    await vault.move("from", "to");
    expect(encryptor.encryptions).toBe(before);
    expect(await vault.get("to")).toEqual(oauth());
    expect(await vault.get("from")).toBeNull();
  });

  it("rejects when there is nothing to move", async () => {
    await expect(vault.move("none", "to")).rejects.toBeInstanceOf(SignInEndedError);
  });
});

describe("credential RPC with browser sign-in", () => {
  it("moves over the port and carries signInAgain back as a refused sign-in", async () => {
    const ports = portPair();
    const calls: string[] = [];
    serveCredentials(ports.a, {
      availability: async () => ({ available: true }),
      get: async () => {
        throw new SignInEndedError();
      },
      set: async () => {},
      delete: async () => {},
      move: async (from, to) => void calls.push(`${from}->${to}`),
    });
    const client = new RemoteCredentialPort(ports.b);
    try {
      await client.move("handle-1", "acc");
      expect(calls).toEqual(["handle-1->acc"]);
      const error = await client.get("acc").catch((e: unknown) => e);
      expect(mailErrorKind(error)).toBe("auth");
      expect(failureDetailOf(error)).toEqual({ refusal: "signInAgain" });
    } finally {
      ports.close();
    }
  });

  it("takes an oauth2 credential only with a known provider", async () => {
    const { parseCredential } = await import("../src/index.ts");
    expect(parseCredential({ kind: "oauth2", accessToken: "t" })).toBeNull();
    expect(parseCredential({ kind: "oauth2", provider: "elsewhere", accessToken: "t" })).toBeNull();
    expect(parseCredential({ kind: "oauth2", provider: "microsoft", accessToken: "t" })).toEqual({
      kind: "oauth2",
      provider: "microsoft",
      accessToken: "t",
    });
  });
});
