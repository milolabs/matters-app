import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { zstdCompressSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  HTML_BLOCK_LIMIT_BYTES,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  openDatabase,
  REPACK_FILL_ROWS,
  SqliteBodyStore,
  schemaVersion,
  senderGroup,
} from "../src/index.ts";

// ADR 0088: HTML is kept in blocks per sender; HTML kept per thread moves there in steps.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const html = (key: number, threadId: string, body: string, sender?: string) => ({
  key,
  threadId,
  ...(sender === undefined ? {} : { sender }),
  text: `text ${key}`,
  html: body,
  htmlKind: "designed" as const,
});

function groups(db: DatabaseSync): Record<number, string> {
  const rows = db.prepare("SELECT key, grp FROM html_index ORDER BY key").all() as {
    key: number;
    grp: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.grp]));
}

describe("HTML blocks per sender", () => {
  it("keeps one sender's HTML together across threads, and text per thread", async () => {
    const db = openDatabase(":memory:");
    const bodies = new SqliteBodyStore(db);
    await bodies.putBodies([
      html(1, "lt:a:1", "<p>one</p>", "News@Shop.example"),
      html(2, "lt:a:2", "<p>two</p>", "news@shop.example"),
      html(3, "lt:a:3", "<p>three</p>", "friend@example.org"),
    ]);
    expect(groups(db)).toEqual({
      1: "from:news@shop.example",
      2: "from:news@shop.example",
      3: "from:friend@example.org",
    });
    expect(bodies.htmlStats()).toMatchObject({ blocks: 2, messages: 3 });
    expect(bodies.stats()).toMatchObject({ blocks: 3, messages: 3 });
    expect(await bodies.getHtml(2)).toBe("<p>two</p>");
    expect((await bodies.getBodies([3])).get(3)).toBe("text 3");
    db.close();
  });

  it("keeps the thread as the group of a body that names no sender", async () => {
    const db = openDatabase(":memory:");
    const bodies = new SqliteBodyStore(db);
    await bodies.putBodies([html(1, "lt:a:1", "<p>one</p>")]);
    expect(groups(db)).toEqual({ 1: "lt:a:1" });
    db.close();
  });

  it("starts a new block past 1 MB, moves a rewritten body to its sender and drops emptied blocks", async () => {
    const db = openDatabase(":memory:");
    const bodies = new SqliteBodyStore(db);
    const quarter = "x".repeat(HTML_BLOCK_LIMIT_BYTES / 4);
    for (let k = 1; k <= 6; k++)
      await bodies.putBodies([html(k, `lt:a:${k}`, quarter, "a@x.example")]);
    // Six quarters: four in the first block, two in the next.
    expect(bodies.htmlStats().blocks).toBe(2);
    expect(await bodies.getHtml(6)).toBe(quarter);

    await bodies.putBodies([html(7, "lt:a:7", "<p>old</p>")]);
    await bodies.putBodies([html(7, "lt:a:7", "<p>new</p>", "b@x.example")]);
    expect(groups(db)[7]).toBe("from:b@x.example");
    expect(bodies.htmlStats().blocks).toBe(3);
    expect(await bodies.getHtml(7)).toBe("<p>new</p>");

    await bodies.removeBodies([5, 6]);
    expect(bodies.htmlStats().blocks).toBe(2);
    expect(await bodies.getHtml(1)).toBe(quarter);
    db.close();
  });

  it("names a sender's group by the lower-case address", () => {
    expect(senderGroup("Anna@Example.COM")).toBe("from:anna@example.com");
  });
});

/** A store at schema 40 with HTML in one block per thread, as ADR 0024 wrote it. */
function storeAt40(): { path: string; old: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), "matters-v40-"));
  dirs.push(dir);
  const path = join(dir, "mail.db");
  const old = new DatabaseSync(path);
  old.exec(
    "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at_ms INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= 40)) {
    old.exec(m.sql);
    m.run?.(old);
    old.prepare("INSERT INTO schema_version VALUES (?, 0)").run(m.version);
  }
  return { path, old };
}

function addOldThread(
  old: DatabaseSync,
  threadId: string,
  messages: readonly { key: number; from: string; html: string }[],
): void {
  const message = old.prepare(`
    INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
      from_json, to_json, cc_json, subject, snippet, flags, has_attachments, change_seq)
    VALUES (?, 'a', ?, ?, '', 0, ?, '[]', '[]', 's', '', 0, 0, 0)`);
  const index = old.prepare(
    "INSERT INTO html_index (key, thread_id, block_no, offset, length) VALUES (?, ?, 0, ?, ?)",
  );
  let offset = 0;
  const parts: Buffer[] = [];
  for (const m of messages) {
    message.run(m.key, `p${m.key}`, threadId, JSON.stringify({ address: m.from }));
    const bytes = Buffer.from(m.html, "utf8");
    index.run(m.key, threadId, offset, bytes.length);
    parts.push(bytes);
    offset += bytes.length;
  }
  old
    .prepare("INSERT INTO html_blocks (thread_id, block_no, raw_bytes, data) VALUES (?, 0, ?, ?)")
    .run(threadId, offset, zstdCompressSync(Buffer.concat(parts)));
}

describe("migration 41: HTML moves to blocks per sender", () => {
  it("lists the old HTML, then moves it in steps, keeping every message's HTML", async () => {
    const { path, old } = storeAt40();
    addOldThread(old, "lt:a:1", [{ key: 1, from: "News@Shop.example", html: "<p>sale</p>" }]);
    addOldThread(old, "lt:a:2", [{ key: 2, from: "news@shop.example", html: "<p>more</p>" }]);
    // A thread with two senders splits in two.
    addOldThread(old, "lt:a:3", [
      { key: 3, from: "anna@example.org", html: "<p>hi</p>" },
      { key: 4, from: "bob@example.org", html: "<p>hello</p>" },
    ]);
    old.close();

    const db = openDatabase(path);
    expect(schemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    const bodies = new SqliteBodyStore(db);
    // Read as before the move: the renamed column still names each old thread.
    expect(await bodies.getHtml(4)).toBe("<p>hello</p>");
    // Nothing is read at launch; the first step lists the old HTML.
    expect(db.prepare("SELECT COUNT(*) AS n FROM html_repack").get()).toEqual({ n: 0 });
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM html_repack").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT fill_from FROM html_repack_state").get()).toEqual({
      fill_from: null,
    });

    // Gone before the move reaches it: it only leaves the list.
    await bodies.removeBodies([2]);
    // A budget of one byte still moves one message per step.
    const steps = [];
    for (let i = 0; i < 10; i++) {
      const step = await bodies.repackHtml(1);
      steps.push(step);
      if (step.done) break;
    }
    expect(steps.at(-1)?.done).toBe(true);
    expect(steps.reduce((n, s) => n + s.moved, 0)).toBe(3);
    expect(groups(db)).toEqual({
      1: "from:news@shop.example",
      3: "from:anna@example.org",
      4: "from:bob@example.org",
    });
    expect(await bodies.getHtml(1)).toBe("<p>sale</p>");
    expect(await bodies.getHtml(3)).toBe("<p>hi</p>");
    expect(await bodies.getHtml(4)).toBe("<p>hello</p>");
    expect(await bodies.getHtml(2)).toBeUndefined();
    // The old thread blocks are gone; one block per sender is left.
    expect(bodies.htmlStats()).toMatchObject({ blocks: 3, messages: 3 });
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: true });
    db.close();
  });

  it("leaves nothing to move on a new database", async () => {
    const db = openDatabase(":memory:");
    const bodies = new SqliteBodyStore(db);
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: false });
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: true });
    db.close();
  });

  it("lists the old HTML in steps of REPACK_FILL_ROWS, and new mail is never listed", async () => {
    const { path, old } = storeAt40();
    const many = Array.from({ length: REPACK_FILL_ROWS + 3 }, (_, i) => ({
      key: i + 1,
      from: `s${i % 7}@example.org`,
      html: `<p>${i}</p>`,
    }));
    addOldThread(old, "lt:a:big", many);
    old.close();

    const db = openDatabase(path);
    const bodies = new SqliteBodyStore(db);
    await bodies.putBodies([html(1_000_000, "lt:a:new", "<p>new</p>", "s1@example.org")]);
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: false });
    expect(await bodies.repackHtml()).toEqual({ moved: 0, done: false });
    const listed = db.prepare("SELECT COUNT(*) AS n FROM html_repack").get() as { n: number };
    expect(listed.n).toBe(REPACK_FILL_ROWS + 3);
    let moved = 0;
    for (let i = 0; i < 20; i++) {
      const step = await bodies.repackHtml();
      moved += step.moved;
      if (step.done) break;
    }
    expect(moved).toBe(REPACK_FILL_ROWS + 3);
    const left = db
      .prepare("SELECT COUNT(*) AS n FROM html_index WHERE grp NOT LIKE 'from:%'")
      .get() as { n: number };
    expect(left.n).toBe(0);
    expect(await bodies.getHtml(5000)).toBe("<p>4999</p>");
    expect(bodies.htmlStats().blocks).toBe(7);
    db.close();
  }, 30_000); // Over 5,000 messages: about 3 s alone, longer beside the other test files.
});
