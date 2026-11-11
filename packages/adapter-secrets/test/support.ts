import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import type { CredentialAvailability } from "@matters/core";
import type { Encryptor, RpcPort } from "../src/index.ts";

/** Real AES-GCM with a random key, standing in for the keychain. */
export class TestEncryptor implements Encryptor {
  private readonly key = randomBytes(32);
  state: CredentialAvailability = { available: true };
  reencrypt = false;
  encryptions = 0;

  async availability(): Promise<CredentialAvailability> {
    return this.state;
  }

  async encrypt(plainText: string): Promise<Uint8Array> {
    this.encryptions++;
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  }

  async decrypt(data: Uint8Array) {
    const buf = Buffer.from(data);
    const decipher = createDecipheriv("aes-256-gcm", this.key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const text = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
    return { text, reencrypt: this.reencrypt };
  }
}

/** Two connected ports; worker_threads ports deliver the data itself, like `RpcPort` wants. */
export function portPair(): { a: RpcPort; b: RpcPort; close(): void } {
  const { port1, port2 } = new MessageChannel();
  const wrap = (p: typeof port1): RpcPort => ({
    postMessage: (m) => p.postMessage(m),
    onMessage: (h) => {
      p.on("message", h);
    },
  });
  return {
    a: wrap(port1),
    b: wrap(port2),
    close: () => {
      port1.close();
      port2.close();
    },
  };
}
