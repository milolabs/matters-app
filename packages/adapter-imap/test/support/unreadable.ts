import { generateCase } from "../../../testkit/src/corpusGenerators.ts";
import { Admin, type Credentials } from "./admin.ts";
import { Mailbox } from "./harness.ts";
import { mail } from "./mail.ts";

/**
 * A message the parser cannot read, between two good ones, then one more later (ADR 0047). Runs
 * the syncs and reports what happened; the callers assert.
 */
export async function runUnreadableScenario(credentials: Credentials, reset = false) {
  const admin = await Admin.connect(credentials);
  const box = new Mailbox(credentials, 20);
  try {
    if (reset) await admin.reset();
    await admin.append(
      "INBOX",
      mail({ id: "first", subject: "first", date: new Date(Date.UTC(2026, 10, 1, 8, 0)) }),
    );
    await admin.append("INBOX", generateCase("many-headers", "bad").toString("latin1"));
    await admin.append(
      "INBOX",
      mail({ id: "second", subject: "second", date: new Date(Date.UTC(2026, 10, 1, 9, 0)) }),
    );
    await box.sync();
    const afterFirst = await box.messages();
    const downloadedByFirst = box.stats.sourcesDownloaded;
    await admin.append(
      "INBOX",
      mail({ id: "later", subject: "later", date: new Date(Date.UTC(2026, 10, 5, 9, 0)) }),
    );
    await box.sync();
    const afterSecond = await box.messages();
    const bad = afterFirst.find((m) => m.messageIdHeader === "<bad@corpus.test>");
    const bodies = bad ? await box.storage.bodies.getBodies([bad.key]) : undefined;
    return {
      afterFirst,
      afterSecond,
      bad,
      badBody: bad ? bodies?.get(bad.key) : undefined,
      downloadedByFirst,
      downloadedBySecond: box.stats.sourcesDownloaded - downloadedByFirst,
    };
  } finally {
    box.close();
    await admin.close();
  }
}
