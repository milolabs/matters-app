// Evaluates the first round of the agent's search across all mail on one's own mailbox
// (ADR 0081): for each question the plan turn is made (or read from a cache), the queries of the
// first round run through the same candidate pipeline the backend uses, and the tool prints where
// the threads one expects to see land in the ordered list of candidates.
//
//   ELECTRON_RUN_AS_NODE=1 electron tools/eval-talk-search.ts \
//     --db <copy of matters.db> --questions <questions.json> --plans <plans-cache.json> [--rounds 1]
//
// questions.json: {"questions":[{"id","question","history":[{"role":"you"|"agent","text"}],
//   "targets":[{"name","subjectLike"}]}]}. `subjectLike` is an SQL LIKE pattern over subjects; a
// target is every thread with such a subject. Keep the questions file out of the repository: it is
// about one person's mail.
//
// The database is opened read-only; use a copy. The planner (Claude Code, model "haiku") sees only
// the question and the history, never mail; it is called only when the cache has no plan for this
// question, history and planner prompt. With --rounds 1 no follow or answer turn runs, so no mail
// goes to any model. The output holds no text of mail: target names, ranks, counts, the queries
// the planner wrote, timings, and the domains of the senders of the top candidates.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTrailPool } from "../apps/desktop/src/backend/trailPool.ts";
import { ClaudeCodeRuntime } from "../packages/adapter-claude-code/src/index.ts";
import { createSqliteReader } from "../packages/adapter-sqlite/src/index.ts";
import {
  buildTalkPlanRequest,
  firstRoundQueries,
  parseTalkPlan,
  type RankedSearchPort,
  type TalkEntry,
} from "../packages/core/src/index.ts";

interface Question {
  readonly id: string;
  readonly question: string;
  readonly history?: readonly { role: "you" | "agent"; text: string }[];
  readonly targets: readonly { name: string; subjectLike: string }[];
}

function args(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a.startsWith("--")) {
      out.set(
        a.slice(2),
        argv[i + 1] === undefined || argv[i + 1]?.startsWith("--") ? "" : (argv[++i] as string),
      );
    }
  }
  return out;
}

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
};

async function main(): Promise<void> {
  const opts = args();
  const dbPath = opts.get("db");
  const questionsPath = opts.get("questions");
  const plansPath = opts.get("plans");
  if (!dbPath || !questionsPath || !plansPath) {
    console.log(
      "usage: eval-talk-search.ts --db <db> --questions <json> --plans <cache.json> [--rounds 1]",
    );
    return;
  }
  const rounds = Number(opts.get("rounds") || "1");
  // --warm runs every round once before the measured run, so the timings are of a warm cache.
  const warm = opts.has("warm");
  if (rounds !== 1) console.log("note: only the first round is evaluated (--rounds 1)");
  const questions = (JSON.parse(readFileSync(questionsPath, "utf8")) as { questions: Question[] })
    .questions;
  const cache: Record<string, unknown> = existsSync(plansPath)
    ? (JSON.parse(readFileSync(plansPath, "utf8")) as Record<string, unknown>)
    : {};

  const reader = createSqliteReader(dbPath);
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  const accounts = await reader.read.accounts.list();
  const consented = new Set(accounts.map((a) => a.id));
  const runtime = new ClaudeCodeRuntime();
  const nowMs = Date.now();

  let top20 = 0;
  let top60 = 0;
  let total = 0;
  const allMs: number[] = [];

  for (const q of questions) {
    const history: TalkEntry[] = (q.history ?? []).map((h, i) =>
      h.role === "you"
        ? { id: i + 1, threadId: null, atMs: nowMs - 60_000 * (10 - i), role: "you", text: h.text }
        : {
            id: i + 1,
            threadId: null,
            atMs: nowMs - 60_000 * (10 - i),
            role: "agent",
            kind: "answer",
            text: h.text,
            quotes: [],
            runtimeName: "eval",
            model: "eval",
            threads: 0,
          },
    );
    const request = buildTalkPlanRequest(history, q.question, nowMs);
    // The date line is left out of the key, so a plan made yesterday is still this plan.
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          request.instructions,
          request.untrusted.replace(/^Today: .*\n/, ""),
          request.schema,
        ]),
      )
      .digest("hex");
    let value = cache[key];
    let cached = true;
    if (value === undefined) {
      cached = false;
      for (let attempt = 0; attempt < 2 && value === undefined; attempt++) {
        try {
          value = (await runtime.run({ model: "haiku", effort: "low", ...request })).value;
        } catch (error) {
          console.log(
            `  planner failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      if (value !== undefined) {
        cache[key] = value;
        writeFileSync(plansPath, JSON.stringify(cache, null, 1));
      }
    }
    const plan = parseTalkPlan(value);
    console.log(`\n== ${q.id}  (plan ${cached ? "cached" : "made now"})`);
    if (plan === null) {
      console.log("  the plan did not fit its schema");
      for (const t of q.targets) console.log(`  ${t.name}: absent (no plan)`);
      total += q.targets.length;
      continue;
    }
    const flags = plan as { followsUp?: boolean; time?: string };
    console.log(
      `  plan: ${plan.trails.length} trails, followsUp=${String(flags.followsUp ?? "-")}, time=${String(flags.time ?? "-")}`,
    );
    const makePool = () =>
      createTrailPool({
        store: reader.read.store,
        index: reader.read.index as unknown as RankedSearchPort,
        bodies: reader.read.bodies,
        visibleText: () => "",
        nowMs,
        consented,
        accounts: accounts.map((a) => ({
          id: a.id,
          address: a.address,
          displayName: a.displayName,
        })),
        rules: [],
        olderThanDays: undefined,
        carry: undefined,
        fragments: false,
        time: plan.time,
      });
    const queries = firstRoundQueries(plan, new Set());
    if (warm) await makePool().runRound(queries);
    const pool = makePool();
    await pool.runRound(queries);
    await pool.refresh();
    const shown = pool.shown();
    for (const r of pool.ran) {
      allMs.push(r.ms);
      console.log(
        `  query ${r.messages} msgs -> ${r.threads} threads, ${r.ms.toFixed(0)} ms: ${r.query}`,
      );
    }
    for (const d of pool.dropped) console.log(`  dropped: ${d.query} (${d.reason})`);

    for (const t of q.targets) {
      const ids = new Set(
        (
          raw
            .prepare("SELECT DISTINCT thread_id FROM messages WHERE subject LIKE ?")
            .all(t.subjectLike) as {
            thread_id: string;
          }[]
        ).map((r) => r.thread_id),
      );
      const rank = pool.rankOf(ids, shown);
      let inQuery = "-";
      for (const [i, list] of pool.lists.entries()) {
        const at = list.findIndex((x) => ids.has(x.threadId));
        if (at >= 0)
          inQuery = inQuery === "-" ? `q${i + 1}#${at + 1}` : `${inQuery},q${i + 1}#${at + 1}`;
      }
      total++;
      if (rank !== null && rank <= 20) top20++;
      if (rank !== null && rank <= 60) top60++;
      console.log(
        `  ${t.name}: ${rank === null ? "absent" : `rank ${rank}`}  (threads ${ids.size}; per-query positions ${inQuery})`,
      );
    }
    const domains = new Map<string, number>();
    for (const c of shown.slice(0, 10)) {
      const d = c.summary.senderAddress.split("@")[1]?.toLowerCase() ?? "?";
      domains.set(d, (domains.get(d) ?? 0) + 1);
    }
    console.log(`  top-10 sender domains: ${[...domains].map(([d, n]) => `${d}x${n}`).join(" ")}`);
  }
  console.log(
    `\nquery timings: n=${allMs.length} median ${percentile(allMs, 0.5).toFixed(0)} ms, p95 ${percentile(allMs, 0.95).toFixed(0)} ms, max ${percentile(allMs, 1).toFixed(0)} ms`,
  );
  console.log(`targets in top 20: ${top20}/${total}, in top 60: ${top60}/${total}`);
  reader.close();
  raw.close();
}

main().then(
  () => process.exit(0),
  (error: unknown) => {
    console.log(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(0);
  },
);
