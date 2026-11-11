import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { startHoodiecrow } from "./support/hoodiecrow.ts";
import { describeImapScenarios, type ServerUnderTest } from "./support/scenarios.ts";

// A listener on every interface can share its port with another process's 127.0.0.1 listener on
// macOS, and that process then gets the clients: a test hangs waiting for a greeting.
it("hoodiecrow does not share its port with a loopback listener", async () => {
  const started = await startHoodiecrow([]);
  const other = createServer();
  const outcome = await new Promise<string>((resolve) => {
    other.once("error", (error: NodeJS.ErrnoException) => resolve(String(error.code)));
    other.listen(started.credentials.port, "127.0.0.1", () => resolve("listening"));
  });
  other.close();
  await started.stop();
  expect(outcome).toBe("EADDRINUSE");
});

function scenarios(plugins: readonly string[], server: Omit<ServerUnderTest, "credentials">) {
  describeImapScenarios(async () => {
    const started = await startHoodiecrow(plugins);
    return {
      server: { ...server, credentials: started.credentials },
      release: started.stop,
    };
  });
}

describe("hoodiecrow without OBJECTID or QRESYNC (fingerprint ids, UID SEARCH fallback)", () => {
  scenarios([], { idPrefix: "fp:", qresync: false });
});

describe("hoodiecrow with OBJECTID and QRESYNC (email ids, VANISHED)", () => {
  scenarios(["QRESYNC", "OBJECTID"], { idPrefix: "eid:", qresync: true });
});
