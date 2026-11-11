// The read thread (ADR 0070, rule 2): the reads that walk a lot of mail, on a read-only connection of
// their own, so that the router's lists and threads never queue behind them. It writes nothing and
// holds no secrets: it gets a database path, and answers one question at a time.
import { parentPort, workerData } from "node:worker_threads";
import { createSqliteReader } from "@matters/adapter-sqlite";
import { type HeavyRead, serveHeavyRead } from "./heavyReads.ts";
import { mark } from "./trace.ts";

mark("read-thread-script-start");
const reader = createSqliteReader((workerData as { dbPath: string }).dbPath);
const { read } = reader;
const deps = {
  insights: read.agentInsights,
  settings: read.agentSettings,
  store: read.store,
  accounts: read.accounts,
  // A reply in the outbox is an answer before it is in its thread (ADR 0112).
  sends: { outbox: read.outbox, drafts: read.drafts },
  storage: read.storageUsage,
};
mark("read-thread-ready");

parentPort?.on(
  "message",
  (message: { id?: number; read?: HeavyRead; nowMs?: number; stop?: true }) => {
    if (message.stop) {
      reader.close();
      process.exit(0);
    }
    const { id, read: question, nowMs } = message;
    if (id === undefined || question === undefined || nowMs === undefined) return;
    serveHeavyRead(deps, question, nowMs).then(
      (value) => {
        mark("read-thread-answer");
        parentPort?.postMessage({ id, ok: true, value });
      },
      // The router asks again on its own connection, and the person hears of it from there.
      () => parentPort?.postMessage({ id, ok: false }),
    );
  },
);
