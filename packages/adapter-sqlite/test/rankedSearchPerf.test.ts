import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@matters/core";
import {
  BULK_PENALTY,
  messageKey,
  parseQuery,
  RANKED_MESSAGES,
  RELATIONSHIP_BOOST,
  rankQueryThreads,
  stemQuery,
} from "@matters/core";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase, SqliteSearchIndex } from "../src/index.ts";

// ADR 0080 and 0081: the agent's ranked search must stay quick at the scale of a large mailbox. 100k
// messages in 30k threads; the words follow a long-tailed distribution (a few are in a fifth of
// all messages, most in a handful), the common words of a mailbox are among them, and so is a
// burst of notifications that name one company again and again.
const MESSAGES = Number(process.env.RANK_PERF_MESSAGES ?? 100_000);
const THREADS = 30_000;
const P95_BUDGET_MS = 50;
const NOW = Date.UTC(2026, 10, 8, 12);
const DAY = 86_400_000;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

const COMMON = [
  "offer",
  "oferta",
  "invoice",
  "faktura",
  "meeting",
  "umowa",
  "agreement",
  "contract",
  "update",
  "report",
  "thanks",
  "plan",
  "budget",
  "review",
  "project",
  "payment",
];
const VOCABULARY = Array.from({ length: 6000 }, (_, i) => `w${i.toString(36)}x`);

const dir = mkdtempSync(join(tmpdir(), "matters-ranked-perf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("the agent's ranked search at scale (ADR 0080)", () => {
  it(`answers within ${P95_BUDGET_MS} ms at p95 over ${MESSAGES} messages`, async () => {
    const db = openDatabase(join(dir, "mail.db"));
    const index = new SqliteSearchIndex(db);
    const insert = db.prepare(
      `INSERT INTO messages (key, account_id, provider_id, thread_id, message_id_header, date_ms,
         from_json, to_json, cc_json, subject, snippet, flags, has_attachments, change_seq)
       VALUES (?, 'acc1', ?, ?, ?, ?, ?, '[]', '[]', ?, '', 0, 0, 0)`,
    );
    const next = rng(7);
    const word = () => {
      // Long tail: the low indexes are far more likely.
      const r = next();
      return VOCABULARY[Math.floor(r * r * r * VOCABULARY.length)] as string;
    };
    const t0 = performance.now();
    const batch: { message: Message; bodyText: string }[] = [];
    const flush = async () => {
      await index.indexMessages(batch.splice(0));
    };
    db.exec("BEGIN");
    for (let m = 0; m < MESSAGES; m++) {
      const dateMs = NOW - Math.floor((m / MESSAGES) * 4 * 365 * DAY);
      const key = messageKey(dateMs, m % 1024);
      const burst = m % 40 === 0;
      const sender = burst
        ? { name: "Build Bot", address: "notifications@builds.example.net" }
        : { name: `Person ${m % 800}`, address: `person${m % 800}@company${m % 120}.example.test` };
      const subject = burst
        ? `[acme-labs/web] Run failed: CI #${m}`
        : `${next() < 0.3 ? "Re: " : ""}${word()} ${COMMON[Math.floor(next() * COMMON.length)]} ${word()}`;
      const words: string[] = [];
      for (let i = 0; i < 40; i++)
        words.push(next() < 0.08 ? (COMMON[Math.floor(next() * COMMON.length)] as string) : word());
      if (burst) words.push("acme-labs", "acme-labs", "workflow");
      insert.run(
        key,
        `p${m}`,
        `t${m % THREADS}`,
        `<${m}@x>`,
        dateMs,
        JSON.stringify(sender),
        subject,
      );
      batch.push({
        message: {
          key,
          dateMs,
          from: sender,
          to: [{ address: "me@example.test" }],
          cc: [],
          subject,
          snippet: "",
        } as unknown as Message,
        bodyText: words.join(" "),
      });
      if (batch.length >= 2000) await flush();
    }
    await flush();
    db.exec("COMMIT");
    const buildMs = performance.now() - t0;

    const queries = [
      "offer OR oferta",
      "agreement OR umowa OR docusign",
      "contract",
      "invoice faktura",
      "update",
      "meeting review",
      "acme-labs offer",
      "acme-labs",
      "from:acme-labs.example",
      "subject:report",
      "payment OR platnosc OR przelew",
      '"offer letter"',
      "offer after:-1y",
      "w1x w2x",
      "thanks plan budget",
      "-update offer",
      "zzzzqq",
    ];
    const run = async (text: string) => {
      // As the trail runs it (ADR 0081): stemmed words, the window of 1500 messages with programs
      // sorted lower before the cut, and the threads scored with flood control after it.
      const found = await index.searchRanked(stemQuery(parseQuery(text, { nowMs: NOW })), {
        limit: RANKED_MESSAGES,
        accountIds: ["acc1"],
        automatedPenalty: BULK_PENALTY,
        ownBoost: RELATIONSHIP_BOOST,
      });
      return rankQueryThreads(found, {
        nowMs: NOW,
        time: "any",
        own: new Set(["me@example.test"]),
        writtenAddresses: new Map(),
        writtenCompanies: new Map(),
        capSenders: true,
      });
    };
    for (const q of queries) await run(q); // warm up
    const times: number[] = [];
    const perQuery = new Map<string, number>();
    for (let round = 0; round < 5; round++) {
      for (const q of queries) {
        const start = performance.now();
        await run(q);
        const took = performance.now() - start;
        times.push(took);
        perQuery.set(q, Math.max(perQuery.get(q) ?? 0, took));
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    const median = times[Math.floor(times.length / 2)] as number;
    const max = times[times.length - 1] as number;
    console.info(
      `ranked search: ${MESSAGES} messages, build ${buildMs.toFixed(0)} ms, median ${median.toFixed(2)} ms, ` +
        `p95 ${p95.toFixed(2)} ms, max ${max.toFixed(2)} ms\n` +
        [...perQuery].map(([q, t]) => `  ${t.toFixed(1)} ms  ${q}`).join("\n"),
    );
    expect(p95).toBeLessThan(P95_BUDGET_MS);
    db.close();
  }, 300_000);
});
