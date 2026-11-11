import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential, CredentialPort } from "@matters/core";
import { CredentialsUnavailableError } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  EncryptedFileCredentialStore,
  RemoteCredentialPort,
  serveCredentials,
} from "../src/index.ts";
import { portPair, TestEncryptor } from "./support.ts";

const PASSWORD = "s3cret-Pa$$word";
const cred: Credential = { kind: "password", username: "me", password: PASSWORD };

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

function pair(store: CredentialPort, timeoutMs?: number) {
  const ports = portPair();
  cleanups.push(ports.close);
  serveCredentials(ports.a, store);
  return { client: new RemoteCredentialPort(ports.b, timeoutMs), ports };
}

describe("credential RPC", () => {
  it("round-trips against the encrypted file store with a fake encryptor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-rpc-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const encryptor = new TestEncryptor();
    const { client } = pair(new EncryptedFileCredentialStore(join(dir, "c.json"), encryptor));

    expect(await client.availability()).toEqual({ available: true });
    expect(await client.get("a")).toBeNull();
    await client.set("a", cred);
    expect(await client.get("a")).toEqual(cred);
    await client.delete("a");
    expect(await client.get("a")).toBeNull();
  });

  it("carries the 'unavailable' refusal across as a credentials error with the reason", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-rpc-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const encryptor = new TestEncryptor();
    encryptor.state = { available: false, reason: "No keyring is available" };
    const { client } = pair(new EncryptedFileCredentialStore(join(dir, "c.json"), encryptor));

    expect(await client.availability()).toEqual({
      available: false,
      reason: "No keyring is available",
    });
    const failure = await client.set("a", cred).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(CredentialsUnavailableError);
    expect((failure as Error).message).toBe("No keyring is available");
  });

  it("never echoes the secret back in a response", async () => {
    const seen: unknown[] = [];
    const ports = portPair();
    cleanups.push(ports.close);
    const store: CredentialPort = {
      availability: async () => ({ available: true }),
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
      delete: async () => {},
    };
    serveCredentials(ports.a, store);
    ports.b.onMessage((m) => seen.push(m));
    ports.b.postMessage({ id: 1, op: "set", accountId: "a", credential: cred });
    await new Promise((r) => setTimeout(r, 50));
    expect(JSON.stringify(seen)).not.toContain(PASSWORD);
    expect(seen).toEqual([{ id: 1, ok: false, kind: "other", message: "disk full" }]);
  });

  it("ignores malformed requests and answers the well-formed ones after them", async () => {
    const calls: string[] = [];
    const store: CredentialPort = {
      availability: async () => ({ available: true }),
      get: async (id) => {
        calls.push(`get:${id}`);
        return null;
      },
      set: async (id) => void calls.push(`set:${id}`),
      delete: async (id) => void calls.push(`delete:${id}`),
    };
    const { client, ports } = pair(store);
    for (const junk of [
      null,
      "x",
      { op: "get", accountId: "a" },
      { id: 1, op: "drop", accountId: "a" },
      { id: 2, op: "get", accountId: "" },
      { id: 3, op: "get", accountId: 7 },
      { id: 4, op: "set", accountId: "a", credential: { kind: "password" } },
      { id: 5, op: "set", accountId: "a" },
    ]) {
      ports.b.postMessage(junk);
    }
    expect(await client.get("ok")).toBeNull();
    expect(calls).toEqual(["get:ok"]);
  });

  it("works when the port arrives later, and times out when nobody answers", async () => {
    const ports = portPair();
    cleanups.push(ports.close);
    let deliver: (p: typeof ports.b) => void = () => {};
    const client = new RemoteCredentialPort(new Promise((r) => (deliver = r)), 40);
    serveCredentials(ports.a, {
      availability: async () => ({ available: true }),
      get: async () => cred,
      set: async () => {},
      delete: async () => {},
    });
    const answer = client.get("a");
    deliver(ports.b);
    expect(await answer).toEqual(cred);

    const silent = portPair();
    cleanups.push(silent.close);
    const lonely = new RemoteCredentialPort(silent.b, 30);
    await expect(lonely.get("a")).rejects.toMatchObject({ kind: "credentials" });
  });

  it("fails pending calls on dispose", async () => {
    const silent = portPair();
    cleanups.push(silent.close);
    const client = new RemoteCredentialPort(silent.b, 10_000);
    const waiting = client.get("a").catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    client.dispose();
    expect(await waiting).toMatchObject({ kind: "credentials" });
  });
});
