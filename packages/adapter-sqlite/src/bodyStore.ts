import { constants, zstdCompressSync, zstdDecompressSync } from "node:zlib";
import type { HtmlKind, MessageBody, MessageBodyPort } from "@matters/core";
import { type Database, readTransaction, write } from "./database.ts";

/** Uncompressed size after which a thread starts a new text block (ADR 0009: 64-256 KB). */
export const BLOCK_LIMIT_BYTES = 256 * 1024;
/** Uncompressed size after which a sender starts a new HTML block (ADR 0088). */
export const HTML_BLOCK_LIMIT_BYTES = 1024 * 1024;
/** Raw HTML one step of the move to sender blocks takes at most, past its first message. */
export const REPACK_STEP_BYTES = 4 * 1024 * 1024;
const ZSTD_LEVEL = 3;

export interface BodyStats {
  readonly blocks: number;
  readonly messages: number;
  readonly rawBytes: number;
  readonly compressedBytes: number;
}

/** What one step of the move to sender blocks did, and whether any of it is left. */
export interface RepackStep {
  readonly moved: number;
  readonly done: boolean;
}

/** One block in memory: its messages in storage order. */
interface Block {
  readonly group: string;
  readonly no: number;
  readonly entries: Map<number, Buffer>;
  rawBytes: number;
  dirty: boolean;
}

interface IndexRow {
  key: number;
  grp: string;
  block_no: number;
  offset: number;
  length: number;
}

/** The HTML group of a sender's mail (ADR 0088). Thread ids start with `pt:` or `lt:`. */
export function senderGroup(address: string): string {
  return `from:${address.toLowerCase()}`;
}

function compress(raw: Buffer): Buffer {
  return zstdCompressSync(raw, { params: { [constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL } });
}

function asBuffer(blob: unknown): Buffer {
  const u8 = blob as Uint8Array;
  return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
}

interface BlockStoreShape {
  readonly blocks: string;
  readonly index: string;
  /** The column that names a block's group: a thread for text, a sender for HTML. */
  readonly column: string;
  readonly limit: number;
}

/** The blocks a write has loaded or started, each rewritten once at the end if dirty. */
class Staging {
  readonly loaded = new Map<string, Block>();
  readonly tails = new Map<string, Block>();
}

/**
 * Strings per message as zstd blocks per group (ADR 0009, 0088). Text is grouped by thread:
 * quoted replies repeat earlier text, so compressing a thread together beats compressing each
 * message alone. HTML is grouped by sender, whose mail shares a template.
 *
 * A new message is appended to the group's last block, which is rewritten inside the same
 * transaction; when that block would pass the limit a new block starts. Replacing an existing
 * body rewrites only the block that holds it. Only dirty blocks are rewritten. Reads go through
 * the index alone, so they never care what kind of group a block belongs to.
 */
class BlockStore {
  private readonly db: Database;
  private readonly indexTable: string;
  private readonly limit: number;
  private readonly selectIndexByKey;
  private readonly selectIndexByKeys;
  private readonly selectBlockEntries;
  private readonly countBlockEntries;
  private readonly selectBlockData;
  private readonly selectTail;
  private readonly upsertBlock;
  private readonly deleteBlock;
  private readonly deleteBlockIndex;
  private readonly insertIndex;
  private readonly selectStats;

  constructor(db: Database, shape: BlockStoreShape) {
    const { blocks, index, column: c, limit } = shape;
    this.db = db;
    this.indexTable = index;
    this.limit = limit;
    this.selectIndexByKey = db.prepare(
      `SELECT key, ${c} AS grp, block_no, offset, length FROM ${index} WHERE key = ?`,
    );
    this.selectIndexByKeys = db.prepare(
      `SELECT key, ${c} AS grp, block_no, offset, length FROM ${index}
        WHERE key IN (SELECT value FROM json_each(?)) ORDER BY ${c}, block_no`,
    );
    this.selectBlockEntries = db.prepare(
      `SELECT key, ${c} AS grp, block_no, offset, length FROM ${index}
        WHERE ${c} = ? AND block_no = ? ORDER BY offset`,
    );
    this.countBlockEntries = db.prepare(
      `SELECT COUNT(*) AS n FROM ${index} WHERE ${c} = ? AND block_no = ?`,
    );
    this.selectBlockData = db.prepare(`SELECT data FROM ${blocks} WHERE ${c} = ? AND block_no = ?`);
    this.selectTail = db.prepare(
      `SELECT block_no, raw_bytes FROM ${blocks} WHERE ${c} = ? ORDER BY block_no DESC LIMIT 1`,
    );
    this.upsertBlock = db.prepare(`
      INSERT INTO ${blocks} (${c}, block_no, raw_bytes, data) VALUES (?, ?, ?, ?)
      ON CONFLICT (${c}, block_no) DO UPDATE SET raw_bytes = excluded.raw_bytes, data = excluded.data`);
    this.deleteBlock = db.prepare(`DELETE FROM ${blocks} WHERE ${c} = ? AND block_no = ?`);
    this.deleteBlockIndex = db.prepare(`DELETE FROM ${index} WHERE ${c} = ? AND block_no = ?`);
    this.insertIndex = db.prepare(
      `INSERT OR REPLACE INTO ${index} (key, ${c}, block_no, offset, length) VALUES (?, ?, ?, ?, ?)`,
    );
    this.selectStats = db.prepare(
      `SELECT COUNT(*) AS blocks, COALESCE(SUM(raw_bytes), 0) AS raw, COALESCE(SUM(LENGTH(data)), 0) AS packed FROM ${blocks}`,
    );
  }

  /** Writes each entry's text into its group; the last entry for a key wins. */
  async put(batch: readonly { key: number; group: string; text: string }[]): Promise<void> {
    if (batch.length === 0) return;
    const latest = new Map<number, { group: string; text: string }>();
    for (const b of batch) latest.set(b.key, b);

    await write(this.db, () => {
      const staging = new Staging();
      for (const [key, { group, text }] of latest)
        this.place(staging, key, group, Buffer.from(text, "utf8"));
      this.flush(staging);
    });
  }

  /**
   * Moves stored entries into the groups given, inside the caller's write; an entry that is
   * gone or already in its group is left alone. Returns the raw bytes moved.
   */
  regroup(moves: readonly { key: number; group: string }[]): number {
    const staging = new Staging();
    let bytes = 0;
    for (const { key, group } of moves) {
      const old = this.selectIndexByKey.get(key) as IndexRow | undefined;
      if (!old || old.grp === group) continue;
      const stored = this.blockOf(staging, old.grp, old.block_no).entries.get(key);
      if (stored === undefined) continue;
      this.place(staging, key, group, stored);
      bytes += stored.length;
    }
    this.flush(staging);
    return bytes;
  }

  private blockOf(staging: Staging, group: string, no: number): Block {
    const id = `${group}\u0000${no}`;
    let block = staging.loaded.get(id);
    if (!block) {
      block = this.loadBlock(group, no);
      staging.loaded.set(id, block);
    }
    return block;
  }

  private place(staging: Staging, key: number, group: string, bytes: Buffer): void {
    const old = this.selectIndexByKey.get(key) as IndexRow | undefined;
    if (old && old.grp === group) {
      const block = this.blockOf(staging, group, old.block_no);
      block.rawBytes += bytes.length - (block.entries.get(key)?.length ?? 0);
      block.entries.set(key, bytes);
      block.dirty = true;
      return;
    }
    if (old) {
      // The message moved to another group: take it out of the old block first.
      const block = this.blockOf(staging, old.grp, old.block_no);
      block.rawBytes -= block.entries.get(key)?.length ?? 0;
      block.entries.delete(key);
      block.dirty = true;
    }
    let tail = staging.tails.get(group);
    if (!tail) {
      const row = this.selectTail.get(group) as { block_no: number; raw_bytes: number } | undefined;
      tail = row ? this.blockOf(staging, group, row.block_no) : this.emptyBlock(group, 0);
      if (!row) staging.loaded.set(`${group}\u0000${0}`, tail);
      staging.tails.set(group, tail);
    }
    if (tail.entries.size > 0 && tail.rawBytes + bytes.length > this.limit) {
      tail = this.emptyBlock(group, tail.no + 1);
      staging.loaded.set(`${group}\u0000${tail.no}`, tail);
      staging.tails.set(group, tail);
    }
    tail.entries.set(key, bytes);
    tail.rawBytes += bytes.length;
    tail.dirty = true;
  }

  private flush(staging: Staging): void {
    for (const block of staging.loaded.values()) if (block.dirty) this.writeBlock(block);
  }

  async remove(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) return;
    await write(this.db, () => {
      const rows = this.selectIndexByKeys.all(JSON.stringify(keys)) as unknown as IndexRow[];
      const byBlock = new Map<string, IndexRow[]>();
      for (const row of rows) {
        const id = `${row.grp}\u0000${row.block_no}`;
        const group = byBlock.get(id);
        if (group) group.push(row);
        else byBlock.set(id, [row]);
      }
      for (const rowsOfBlock of byBlock.values()) {
        const { grp: group, block_no: no } = rowsOfBlock[0] as IndexRow;
        const { n } = this.countBlockEntries.get(group, no) as { n: number };
        // Nothing stays in the block: no need to unpack it, the usual case for a whole account.
        if (n === rowsOfBlock.length) {
          this.deleteBlockIndex.run(group, no);
          this.deleteBlock.run(group, no);
          continue;
        }
        const block = this.loadBlock(group, no);
        for (const row of rowsOfBlock) {
          block.rawBytes -= block.entries.get(row.key)?.length ?? 0;
          block.entries.delete(row.key);
        }
        this.writeBlock(block);
      }
    });
  }

  async get(keys: readonly number[]): Promise<ReadonlyMap<number, string>> {
    if (keys.length === 0) return new Map();
    // Index rows and block data must come from one snapshot, or offsets and bytes can disagree.
    return readTransaction(this.db, () => this.readBodies(keys));
  }

  private readBodies(keys: readonly number[]): Map<number, string> {
    const out = new Map<number, string>();
    const rows = this.selectIndexByKeys.all(JSON.stringify(keys)) as unknown as IndexRow[];
    let raw: Buffer | undefined;
    let current = "";
    for (const row of rows) {
      const id = `${row.grp}\u0000${row.block_no}`;
      if (id !== current) {
        current = id;
        const stored = this.selectBlockData.get(row.grp, row.block_no) as
          | { data: unknown }
          | undefined;
        raw = stored ? zstdDecompressSync(asBuffer(stored.data)) : undefined;
      }
      if (raw) out.set(row.key, raw.toString("utf8", row.offset, row.offset + row.length));
    }
    return out;
  }

  stats(): BodyStats {
    const r = this.selectStats.get() as { blocks: number; raw: number; packed: number };
    const messages = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM ${this.indexTable}`).get() as { n: number }
    ).n;
    return { blocks: r.blocks, messages, rawBytes: r.raw, compressedBytes: r.packed };
  }

  private emptyBlock(group: string, no: number): Block {
    return { group, no, entries: new Map(), rawBytes: 0, dirty: false };
  }

  private loadBlock(group: string, no: number): Block {
    const block = this.emptyBlock(group, no);
    const stored = this.selectBlockData.get(group, no) as { data: unknown } | undefined;
    if (!stored) return block;
    const raw = zstdDecompressSync(asBuffer(stored.data));
    const rows = this.selectBlockEntries.all(group, no) as unknown as IndexRow[];
    for (const row of rows)
      block.entries.set(row.key, raw.subarray(row.offset, row.offset + row.length));
    block.rawBytes = raw.length;
    return block;
  }

  private writeBlock(block: Block): void {
    this.deleteBlockIndex.run(block.group, block.no);
    if (block.entries.size === 0) {
      this.deleteBlock.run(block.group, block.no);
      return;
    }
    const parts: Buffer[] = [];
    let offset = 0;
    for (const [key, bytes] of block.entries) {
      this.insertIndex.run(key, block.group, block.no, offset, bytes.length);
      parts.push(bytes);
      offset += bytes.length;
    }
    this.upsertBlock.run(block.group, block.no, offset, compress(Buffer.concat(parts)));
  }
}

/** Text and HTML of messages, in separate blocks (ADR 0024). */
export class SqliteBodyStore implements MessageBodyPort {
  private readonly db: Database;
  private readonly text: BlockStore;
  private readonly html: BlockStore;
  private readonly upsertKind;
  private readonly deleteKinds;
  private readonly selectKinds;

  private readonly selectRepack;
  private readonly deleteRepack;
  private readonly anyRepack;
  private readonly selectFillFrom;
  private readonly setFillFrom;
  private readonly selectToList;
  private readonly insertRepack;

  constructor(db: Database) {
    this.db = db;
    this.text = new BlockStore(db, {
      blocks: "body_blocks",
      index: "body_index",
      column: "thread_id",
      limit: BLOCK_LIMIT_BYTES,
    });
    this.html = new BlockStore(db, {
      blocks: "html_blocks",
      index: "html_index",
      column: "grp",
      limit: HTML_BLOCK_LIMIT_BYTES,
    });
    this.selectRepack = db.prepare(`
      SELECT r.sender, r.key, i.grp, i.length FROM html_repack r
        LEFT JOIN html_index i ON i.key = r.key
        ORDER BY r.sender, r.key LIMIT ?`);
    this.deleteRepack = db.prepare("DELETE FROM html_repack WHERE sender = ? AND key = ?");
    this.anyRepack = db.prepare("SELECT EXISTS (SELECT 1 FROM html_repack) AS left");
    this.selectFillFrom = db.prepare("SELECT fill_from FROM html_repack_state");
    this.setFillFrom = db.prepare("UPDATE html_repack_state SET fill_from = ?");
    this.selectToList = db.prepare(`
      SELECT i.key, COALESCE(lower(json_extract(m.from_json, '$.address')), '') AS sender
        FROM html_index i JOIN messages m ON m.key = i.key
        WHERE i.key >= ? AND i.grp NOT LIKE 'from:%' ORDER BY i.key LIMIT ?`);
    this.insertRepack = db.prepare("INSERT OR IGNORE INTO html_repack (sender, key) VALUES (?, ?)");
    this.upsertKind = db.prepare("INSERT OR REPLACE INTO html_kinds (key, designed) VALUES (?, ?)");
    this.deleteKinds = db.prepare(
      "DELETE FROM html_kinds WHERE key IN (SELECT value FROM json_each(?))",
    );
    this.selectKinds = db.prepare(
      "SELECT key, designed FROM html_kinds WHERE key IN (SELECT value FROM json_each(?))",
    );
  }

  async putBodies(batch: readonly MessageBody[]): Promise<void> {
    await this.text.put(batch.map((b) => ({ key: b.key, group: b.threadId, text: b.text })));
    const withHtml = batch.filter((b) => b.html !== undefined);
    if (withHtml.length === 0) return;
    await this.html.put(
      withHtml.map((b) => ({
        key: b.key,
        // ADR 0088: a sender's HTML together; a body that names no sender keeps its thread.
        group: b.sender === undefined ? b.threadId : senderGroup(b.sender),
        text: b.html ?? "",
      })),
    );
    await write(this.db, () => {
      for (const b of withHtml) this.upsertKind.run(b.key, b.htmlKind === "designed" ? 1 : 0);
    });
  }

  async removeBodies(keys: readonly number[]): Promise<void> {
    if (keys.length === 0) return;
    await this.text.remove(keys);
    await this.html.remove(keys);
    await write(this.db, () => {
      this.deleteKinds.run(JSON.stringify(keys));
    });
  }

  getBodies(keys: readonly number[]): Promise<ReadonlyMap<number, string>> {
    return this.text.get(keys);
  }

  async getHtmlKinds(keys: readonly number[]): Promise<ReadonlyMap<number, HtmlKind>> {
    if (keys.length === 0) return new Map();
    const rows = this.selectKinds.all(JSON.stringify(keys)) as unknown as {
      key: number;
      designed: number;
    }[];
    return new Map(rows.map((r) => [r.key, r.designed === 1 ? "designed" : "simple"]));
  }

  async getHtml(key: number): Promise<string | undefined> {
    return (await this.html.get([key])).get(key);
  }

  stats(): BodyStats {
    return this.text.stats();
  }

  htmlStats(): BodyStats {
    return this.html.stats();
  }

  /**
   * One step of moving HTML stored per thread into blocks per sender (ADR 0088). Until the work
   * list is complete, a step lists the next `REPACK_FILL_ROWS` messages kept per thread with
   * their senders. Then a step moves the next messages of the list, in sender order, up to
   * `budgetBytes` of raw HTML past the first. A message that is gone, or already in its
   * sender's group, only leaves the list.
   */
  async repackHtml(budgetBytes = REPACK_STEP_BYTES): Promise<RepackStep> {
    return write(this.db, () => {
      const state = this.selectFillFrom.get() as { fill_from: number | null } | undefined;
      if (state !== undefined && state.fill_from !== null) {
        const listed = this.selectToList.all(state.fill_from, REPACK_FILL_ROWS) as unknown as {
          key: number;
          sender: string;
        }[];
        for (const row of listed) this.insertRepack.run(row.sender, row.key);
        const last = listed.at(-1);
        this.setFillFrom.run(
          listed.length < REPACK_FILL_ROWS || last === undefined ? null : last.key + 1,
        );
        return { moved: 0, done: false };
      }
      const rows = this.selectRepack.all(REPACK_ROWS) as unknown as {
        sender: string;
        key: number;
        grp: string | null;
        length: number | null;
      }[];
      const moves: { key: number; group: string }[] = [];
      let bytes = 0;
      for (const row of rows) {
        if (moves.length > 0 && bytes + (row.length ?? 0) > budgetBytes) break;
        this.deleteRepack.run(row.sender, row.key);
        const group = senderGroup(row.sender);
        if (row.grp === null || row.grp === group) continue;
        moves.push({ key: row.key, group });
        bytes += row.length ?? 0;
      }
      this.html.regroup(moves);
      const { left } = this.anyRepack.get() as { left: number };
      return { moved: moves.length, done: left === 0 };
    });
  }
}

/** Work list rows one step of the move looks at; skipped ones cost only their delete. */
const REPACK_ROWS = 2000;
/** Messages one step lists while the work list is filled. */
export const REPACK_FILL_ROWS = 5000;
