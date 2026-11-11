import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeMessage } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTOMATED_BODY_COUNTER,
  createSqliteStorage,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  type SqliteStorage,
  schemaVersion,
} from "../src/index.ts";

// ADR 0111: stored mail is read once for a mailing's footer, newest first, in small steps.

const dirs: string[] = [];
const open: SqliteStorage[] = [];
afterEach(() => {
  for (const s of open.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const FOOTER = "Deals of the week\n\nThis email was sent to me@example.com. Unsubscribe";
const PERSON = "Hi, see you on Monday.\n\nAnna";

function storage(): SqliteStorage {
  const s = createSqliteStorage(":memory:");
  open.push(s);
  return s;
}

async function flags(s: SqliteStorage, keys: readonly number[]): Promise<(number | null)[]> {
  const byKey = new Map((await s.store.getByKeys(keys)).map((m) => [m.key, m.automated]));
  return keys.map((k) => {
    const a = byKey.get(k);
    return a === undefined ? null : a ? 1 : 0;
  });
}

async function put(
  s: SqliteStorage,
  rows: readonly { text?: string; subject?: string; automated?: boolean }[],
  fromMs = Date.UTC(2026, 0, 1),
): Promise<number[]> {
  const messages = rows.map((r, i) =>
    makeMessage({
      dateMs: fromMs + i * 60_000,
      subject: r.subject ?? "Deals of the week",
      ...(r.automated === undefined ? {} : { automated: r.automated }),
    }),
  );
  await s.store.upsertMessages(messages);
  await s.bodies.putBodies(
    messages.flatMap((m, i) => {
      const text = rows[i]?.text;
      return text === undefined ? [] : [{ key: m.key, threadId: m.threadId, text }];
    }),
  );
  return messages.map((m) => m.key);
}

describe("automated by text (ADR 0111)", () => {
  it("marks stored mail with a mailing's footer and nothing else, then ends", async () => {
    const s = storage();
    const keys = await put(s, [
      { text: FOOTER, automated: false },
      { text: FOOTER },
      { text: PERSON, automated: false },
      { text: PERSON },
      { text: FOOTER, subject: "Re: Deals of the week", automated: false },
      { automated: false },
      { text: PERSON, automated: true },
    ]);
    expect(await s.learnAutomatedFromBodies()).toEqual({ moved: 2, done: true });
    // Footer: marked, whether it was 0 or unknown. A person, a reply, no text: as they were.
    // A flag the headers set is never cleared.
    expect(await flags(s, keys)).toEqual([1, 1, 0, null, 0, 0, 1]);
    expect(await s.learnAutomatedFromBodies()).toEqual({ moved: 0, done: true });
  });

  it("walks newest first in steps and keeps its place", async () => {
    const s = storage();
    const keys = await put(
      s,
      Array.from({ length: 5 }, () => ({ text: FOOTER, automated: false })),
    );
    expect(await s.learnAutomatedFromBodies(2)).toEqual({ moved: 2, done: false });
    expect(await flags(s, keys)).toEqual([0, 0, 0, 1, 1]);
    expect(await s.learnAutomatedFromBodies(2)).toEqual({ moved: 2, done: false });
    expect(await s.learnAutomatedFromBodies(2)).toEqual({ moved: 1, done: true });
    expect(await flags(s, keys)).toEqual([1, 1, 1, 1, 1]);
  });

  it("reads each message once: mail newer than the place is the parser's", async () => {
    const s = storage();
    await put(s, [{ text: PERSON, automated: false }]);
    expect(await s.learnAutomatedFromBodies()).toEqual({ moved: 0, done: true });
    const later = await put(s, [{ text: FOOTER, automated: false }], Date.UTC(2026, 1, 1));
    expect(await s.learnAutomatedFromBodies()).toEqual({ moved: 0, done: true });
    expect(await flags(s, later)).toEqual([0]);
  });

  it("comes with migration 49, which puts the place at the top once", () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-v48-"));
    dirs.push(dir);
    const path = join(dir, "mail.db");
    const old = new DatabaseSync(path);
    old.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
    );
    for (const m of MIGRATIONS.filter((x) => x.version <= 48)) {
      old.exec(m.sql);
      m.run?.(old);
      old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
    }
    old.close();
    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    expect(
      db.prepare("SELECT value FROM counters WHERE name = ?").get(AUTOMATED_BODY_COUNTER),
    ).toEqual({ value: Number.MAX_SAFE_INTEGER });
    db.close();
  });
});
