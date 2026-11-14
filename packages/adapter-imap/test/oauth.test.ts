import { PostalMimeParser } from "@matters/adapter-mime";
import type { MailTarget } from "@matters/core";
import { failureDetailOf } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImapAuthError, ImapConnector, refusedSignIn } from "../src/index.ts";
import { startHoodiecrow } from "./support/hoodiecrow.ts";

/** Hoodiecrow's XOAUTH2 plugin takes this token for `testuser`. */
const TOKEN = "testtoken";

describe("ImapConnector with a browser sign-in (ADR 0133, rule 9)", () => {
  let started: Awaited<ReturnType<typeof startHoodiecrow>>;
  beforeEach(async () => {
    started = await startHoodiecrow(["SASL-IR", "XOAUTH2"]);
  });
  afterEach(() => started.stop());

  const connector = new ImapConnector({ parser: new PostalMimeParser(), allowInsecure: true });
  const target = (accessToken: string): MailTarget => ({
    server: {
      host: started.credentials.host,
      port: started.credentials.port,
      security: "none",
      username: started.credentials.user,
    },
    credential: { kind: "oauth2", provider: "microsoft", accessToken },
  });

  it("logs in with XOAUTH2 as the server's user name and syncs", async () => {
    const connection = await connector.connect(target(TOKEN));
    try {
      const folders = await connection.sync.listFolders({
        id: "acc",
        address: "testuser@example.com",
        displayName: "",
        capabilities: [],
      });
      expect(folders.map((f) => f.name)).toContain("INBOX");
    } finally {
      await connection.close();
    }
  });

  it("reports a refused token as ImapAuthError without the token anywhere", async () => {
    const wrong = "eyJ0.a-token-the-server-refuses.sig";
    const failure = await connector.connect(target(wrong)).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ImapAuthError);
    const error = failure as ImapAuthError;
    const everything = [error.message, error.stack ?? "", JSON.stringify(error)].join("\n");
    expect(everything).not.toContain(wrong);
  });
});

describe("refusedSignIn with a token (ADR 0133, rule 10)", () => {
  it("is notAllowed on Microsoft's servers for a bare refusal", () => {
    const token = "eyJ0.secret.sig";
    const error = refusedSignIn(
      "outlook.office365.com",
      "me@outlook.example",
      { text: `A2 NO AUTHENTICATE failed for ${token}.` },
      [token],
      "token",
    );
    expect(failureDetailOf(error)?.refusal).toBe("notAllowed");
    expect(JSON.stringify(failureDetailOf(error))).not.toContain(token);
    // The same answer to a password is still browser-only (ADR 0114).
    expect(
      failureDetailOf(
        refusedSignIn("outlook.office365.com", "me", { text: "A2 NO AUTHENTICATE failed." }, []),
      )?.refusal,
    ).toBe("browserOnly");
  });
});
