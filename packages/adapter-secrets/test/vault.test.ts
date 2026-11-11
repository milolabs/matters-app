import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EncryptedFileCredentialStore } from "../src/index.ts";
import { TestEncryptor } from "./support.ts";

const PASSWORD = "p@ssw0rd-zażółć-123";
const cred = (password = PASSWORD): Credential => ({
  kind: "password",
  username: "vault-test-username",
  password,
});

describe("EncryptedFileCredentialStore", () => {
  let dir: string;
  let file: string;
  let encryptor: TestEncryptor;
  let store: EncryptedFileCredentialStore;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "matters-vault-"));
    file = join(dir, "sub", "credentials.json");
    encryptor = new TestEncryptor();
    store = new EncryptedFileCredentialStore(file, encryptor);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and never writes the password, or its base64, to disk", async () => {
    await store.set("a", cred());
    expect(await store.get("a")).toEqual(cred());
    expect(await store.get("missing")).toBeNull();

    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from(PASSWORD))).toBe(false);
    expect(raw.toString("latin1")).not.toContain(Buffer.from(PASSWORD).toString("base64"));
    expect(raw.toString("utf8")).not.toContain("vault-test-username");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sub"))).toEqual(["credentials.json"]);
  });

  it("keeps other accounts when one is set again or deleted", async () => {
    await store.set("a", cred("one"));
    await store.set("b", cred("two"));
    await store.set("a", cred("three"));
    expect((await store.get("a"))?.kind === "password" && (await store.get("a"))).toMatchObject({
      password: "three",
    });
    await store.delete("a");
    await store.delete("a");
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toMatchObject({ password: "two" });
  });

  it("serializes concurrent writes without losing any", async () => {
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.set(`acc${i}`, cred(`pw${i}`))));
    for (let i = 0; i < 25; i++) {
      expect(await store.get(`acc${i}`)).toMatchObject({ password: `pw${i}` });
    }
  });

  it("refuses to save or read when the keychain is unavailable, and still deletes", async () => {
    await store.set("a", cred());
    encryptor.state = { available: false, reason: "No keyring is available on this system" };

    await expect(store.set("b", cred())).rejects.toMatchObject({
      kind: "credentials",
      message: "No keyring is available on this system",
    });
    await expect(store.get("a")).rejects.toMatchObject({ kind: "credentials" });
    expect(await store.availability()).toEqual({
      available: false,
      reason: "No keyring is available on this system",
    });
    await store.delete("a");
    encryptor.state = { available: true };
    expect(await store.get("a")).toBeNull();
    expect(await store.get("b")).toBeNull();
  });

  it("leaves the old file intact when encryption fails, and no temp file behind", async () => {
    await store.set("a", cred("old"));
    const before = readFileSync(file, "utf8");
    encryptor.encrypt = async () => {
      throw new Error("keychain locked");
    };
    await expect(store.set("a", cred("new"))).rejects.toThrow("keychain locked");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "sub"))).toEqual(["credentials.json"]);
  });

  it("reports a blob it cannot decrypt as a credentials problem, not a crash", async () => {
    await store.set("a", cred());
    const other = new EncryptedFileCredentialStore(file, new TestEncryptor());
    await expect(other.get("a")).rejects.toMatchObject({ kind: "credentials" });
  });

  it("encrypts again when the keychain asks for it", async () => {
    await store.set("a", cred());
    const first = readFileSync(file, "utf8");
    encryptor.reencrypt = true;
    expect(await store.get("a")).toEqual(cred());
    expect(readFileSync(file, "utf8")).not.toBe(first);
    encryptor.reencrypt = false;
    expect(await store.get("a")).toEqual(cred());
  });

  it("replaces every credential in one write, or leaves the file as it was", async () => {
    await store.set("gone", cred("old"));
    await store.replaceAll({ a: cred("one"), b: cred("replaced-secret-two") });
    expect(await store.get("gone")).toBeNull();
    expect(await store.get("a")).toMatchObject({ password: "one" });
    expect(await store.get("b")).toMatchObject({ password: "replaced-secret-two" });
    expect(readFileSync(file, "utf8")).not.toContain("replaced-secret-two");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const before = readFileSync(file, "utf8");
    let calls = 0;
    const encrypt = encryptor.encrypt.bind(encryptor);
    encryptor.encrypt = async (text) => {
      if (++calls === 2) throw new Error("keychain locked");
      return encrypt(text);
    };
    await expect(store.replaceAll({ a: cred("x"), b: cred("y") })).rejects.toThrow("locked");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(readdirSync(join(dir, "sub"))).toEqual(["credentials.json"]);

    encryptor.state = { available: false, reason: "No keyring" };
    await expect(store.replaceAll({})).rejects.toMatchObject({ kind: "credentials" });
  });

  it("sets a damaged file aside instead of overwriting it", async () => {
    await store.set("a", cred());
    writeFileSync(file, "{ not json");
    expect(await store.get("a")).toBeNull();
    await store.set("b", cred());
    const names = readdirSync(join(dir, "sub"));
    expect(names).toContain("credentials.json");
    expect(names.some((n) => n.startsWith("credentials.json.corrupt-"))).toBe(true);
  });
});
