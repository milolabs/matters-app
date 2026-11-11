// The only file that touches Electron's safeStorage (OS keychain). It is available in the main
// process only: a utility process has no `safeStorage` (its `electron` module offers just
// net, systemPreferences and a few others; checked on Electron 45), which is why the backend
// asks main for credentials over a MessagePort (ADR 0018).
import type { Encryptor } from "@matters/adapter-secrets";
import { safeStorage } from "electron";

const NO_STORAGE =
  "Secure storage is not available on this system, so Matters will not save the password. ";

export class SafeStorageEncryptor implements Encryptor {
  async availability() {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) {
      return {
        available: false as const,
        reason:
          process.platform === "linux"
            ? `${NO_STORAGE}Install and unlock a keyring (GNOME Keyring or KWallet).`
            : NO_STORAGE,
      };
    }
    // On Linux without a keyring Electron "encrypts" with a hard-coded key (basic_text).
    if (process.platform === "linux") {
      const backend = safeStorage.getSelectedStorageBackend();
      if (backend === "basic_text" || backend === "unknown") {
        return {
          available: false as const,
          reason: `${NO_STORAGE}No keyring (GNOME Keyring or KWallet) was found.`,
        };
      }
    }
    return { available: true as const };
  }

  encrypt(plainText: string): Promise<Uint8Array> {
    return safeStorage.encryptStringAsync(plainText);
  }

  async decrypt(data: Uint8Array) {
    const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(data));
    return { text: result, reencrypt: shouldReEncrypt };
  }
}
