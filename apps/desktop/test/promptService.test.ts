import { visibleText } from "@matters/adapter-mime";
import type {
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentToolRunOptions,
  Message,
  PromptProgress,
  StoredAccount,
} from "@matters/core";
import {
  AgentRunError,
  MAX_FOLLOW_KEEP,
  MAX_PROMPT_BATCH_THREADS,
  PROMPT_ASK_ABOVE,
  PROMPT_INSTRUCTIONS,
  PROMPT_SEARCH_INSTRUCTIONS,
  PROMPT_VERSION,
} from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { InvalidAgentSettingError } from "../src/backend/agentApi.ts";
import { AgentService, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";
import { DemoAgentRuntime } from "../src/backend/demoAgent.ts";

// ADR 0116: a prompt is a filter. The service runs over the in-memory stores and a runtime that
// answers from a function: the plan turn and follow turns of ADR 0080 that search, and the
// batches that judge; with tools, the loop of ADR 0083 calls our tool server for real. The demo
// runtime answers the same turns for a run with no model.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 11, 12);
const PROMPT = 'prompt:"what needs my decision"';

const account = (id: string, address: string): StoredAccount => ({
  id,
  address,
  displayName: id,
  imap: { host: "imap.example.com", port: 993, security: "tls", username: id },
  createdAtMs: 1,
});

type Run = (request: AgentRunRequest, signal?: AbortSignal) => Promise<AgentRunResult>;

/** Which turn a request is, by its schema. */
type Kind = "plan" | "follow" | "verdicts" | "other";
function kindOf(request: AgentRunRequest): Kind {
  const props = (request.schema as { properties?: Record<string, unknown> }).properties ?? {};
  if ("verdicts" in props) return "verdicts";
  if ("trails" in props) return "plan";
  if ("decision" in props) return "follow";
  return "other";
}

/** A plan with one trail of these queries, as a plan turn writes it (ADR 0080). */
const planOf = (queries: readonly string[]) => ({
  goal: "Find what the person asks for",
  assumptions: [],
  time: "any",
  trails: [{ name: "Words", why: "They are the words asked.", priority: 5, queries }],
  traps: [],
});

/** A follow turn that keeps every candidate listed, in order, and answers. */
function keepAll(request: AgentRunRequest) {
  const keep = [...request.untrusted.matchAll(/^\[Thread (\d+)\]/gm)].map((m) => Number(m[1]));
  return {
    decision: "answer",
    keep: [...new Set(keep)].slice(0, MAX_FOLLOW_KEEP),
    hypothesis: "These are the ones.",
  };
}

class Responder {
  readonly id = "fake";
  readonly name = "Fake";
  readonly calls: AgentRunRequest[] = [];
  info: AgentRuntimeInfo = {
    id: "fake",
    name: "Fake",
    status: "found",
    plan: "pro",
    models: ["small", "large"],
  };
  /** The queries the plan turn writes. */
  queries: readonly string[] = ["decide"];
  plan: Run = async () => ({ value: planOf(this.queries) });
  answer: Run = async (request) => ({ value: judgeAll(request) });
  runWithTools?: (
    request: AgentRunRequest,
    options: AgentToolRunOptions,
  ) => Promise<AgentRunResult>;

  async inspect() {
    return this.info;
  }

  /** The turns of one kind that went, in order. */
  of(kind: Kind): AgentRunRequest[] {
    return this.calls.filter((c) => kindOf(c) === kind);
  }

  async run(request: AgentRunRequest, options?: { readonly signal?: AbortSignal }) {
    // The made-up test of the runtime (ADR 0051, rule 5) is answered by its constant.
    if (request.untrusted.includes(TEST_PROMPT_QUOTE)) {
      return {
        value: {
          state: "waiting",
          headline: "Waiting for the contract",
          facts: [{ kind: "promise", who: "them", message: 1, quote: TEST_PROMPT_QUOTE }],
          stakes: "none",
          confidence: 0.9,
          intent: "none",
          intentQuote: "",
          forYou: "generic",
          status: "open",
          category: "other",
        },
      };
    }
    this.calls.push(request);
    switch (kindOf(request)) {
      case "plan":
        return this.plan(request, options?.signal);
      case "follow":
        return { value: keepAll(request) };
      default:
        return this.answer(request, options?.signal);
    }
  }
}

/** Every thread of a batch fits 2 on its line "Please decide by", and 0 without one. */
function judgeAll(request: AgentRunRequest) {
  const parts = request.untrusted.split(/^\[Thread (\d+)\]$/m);
  const verdicts = [];
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const messages = (parts[i + 1] ?? "").split(/^\[Message (\d+)\]$/m);
    let found: { message: number; quote: string } | undefined;
    for (let m = 1; m + 1 < messages.length; m += 2) {
      const line = /^(Please decide by \w+)/m.exec(messages[m + 1] ?? "")?.[1];
      if (line !== undefined) found = { message: Number(messages[m]), quote: line };
    }
    verdicts.push(
      found === undefined
        ? { thread: Number(parts[i]), fit: 0, why: "Nothing to decide." }
        : { thread: Number(parts[i]), fit: 2, why: "It asks for a decision.", ...found },
    );
  }
  return { verdicts };
}

/** Subjects of the threads a request sent, in order. */
const subjectsOf = (request: AgentRunRequest) =>
  [...request.untrusted.matchAll(/^Subject: (.*)$/gm)].map((m) => m[1]);

let seq = 0;

async function build(runtime: { id: string } & Partial<Responder> = new Responder()) {
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const insights = new InMemoryAgentInsightStore();
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add(account("acc1", "me@example.com"));
  await storage.accounts.add(account("acc2", "other@example.com"));
  const progress: PromptProgress[] = [];
  const service = new AgentService({
    runtime: runtime as Responder,
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights,
    settings,
    drafts: storage.drafts,
    views: storage.views,
    saveDraft: async () => {
      throw new Error("no drafts here");
    },
    clock,
    visibleText,
    onChanged: () => {},
    onPromptProgress: (p) => progress.push(p),
  });

  async function addMail(
    threadId: string,
    texts: readonly string[],
    over: {
      accountId?: string;
      from?: string;
      name?: string;
      automated?: boolean;
      dayOffset?: number;
    } = {},
  ): Promise<void> {
    const messages: Message[] = texts.map((_, i) => {
      const n = ++seq;
      return makeMessage({
        seq: n % 1024,
        accountId: over.accountId ?? "acc1",
        threadId,
        providerId: `${threadId}-${n}`,
        dateMs: NOW - (over.dayOffset ?? 1) * DAY + i * 60_000 + n,
        from: { name: over.name ?? "Robin Example", address: over.from ?? "robin@example.org" },
        to: [{ address: "me@example.com" }],
        subject: `Subject ${threadId}`,
        labelIds: ["inbox"],
        ...(over.automated === undefined ? {} : { automated: over.automated }),
      });
    });
    const { keys } = await storage.store.upsertMessages(messages);
    await storage.bodies.putBodies(keys.map((key, i) => ({ key, threadId, text: texts[i] ?? "" })));
    await storage.index.indexMessages(
      messages.map((message, i) => ({
        message: { ...message, key: keys[i] ?? message.key },
        bodyText: texts[i] ?? "",
      })),
    );
  }

  /** `n` threads from Robin that hold nothing a prompt asks for: they make the mail filters broad. */
  async function addFiller(n: number, over: { from?: string } = {}): Promise<void> {
    for (let i = 0; i < n; i++) {
      await addMail(`filler${String(i).padStart(4, "0")}`, [`Weekly note number ${i}`], {
        dayOffset: 10 + i,
        ...over,
      });
    }
  }

  /** AI on for the first account, its runtime tested, the background reading paused. */
  async function ready(): Promise<void> {
    await service.setEnabled({ accountIds: ["acc1"], runtimeId: runtime.id, windowDays: 30 });
    await service.pauseReading();
    await service.testRuntime();
  }

  return { storage, clock, insights, settings, service, progress, addMail, addFiller, ready };
}

type ToolCall = (name: string, args: unknown) => Promise<string>;

/** Gives the runtime the loop of ADR 0083: `loop` calls our tool server as a model would. */
function withTools(
  runtime: Responder,
  loop: (call: ToolCall, options: AgentToolRunOptions) => Promise<unknown>,
): { request: AgentRunRequest; options: AgentToolRunOptions }[] {
  const seen: { request: AgentRunRequest; options: AgentToolRunOptions }[] = [];
  runtime.runWithTools = async (request, options) => {
    seen.push({ request, options });
    let id = 0;
    const call: ToolCall = async (name, args) => {
      const res = await fetch(options.server.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${options.server.token}`,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
      const body = (await res.json()) as {
        result?: { content: { text: string }[] };
        error?: { message: string };
      };
      return body.result?.content[0]?.text ?? `error: ${body.error?.message ?? ""}`;
    };
    return { value: await loop(call, options) };
  };
  return seen;
}

/** The numbers of the threads a `search_mail` answer listed, in order. */
const numbersIn = (text: string) =>
  [...text.matchAll(/^\[Thread (\d+)\]/gm)].map((m) => Number(m[1]));

const NOT_SEARCHED = { ai: "on", searched: false, found: 0, read: 0, fits: 0 };

describe("a prompt is a filter (ADR 0116)", () => {
  it("answers 'off' while AI is off, and sends nothing (rule 11)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("t1", ["Please decide by Friday"]);
    const off = { ai: "off", promptKey: "", searched: false, found: 0, read: 0, fits: 0 };
    expect(await h.service.promptCount(PROMPT)).toEqual(off);
    expect(await h.service.promptVerdicts(PROMPT)).toEqual({ ...off, rows: [] });
    expect(await h.service.promptRun(PROMPT)).toEqual({
      ...off,
      rows: [],
      stopped: false,
      rejected: 0,
    });
    expect(runtime.calls).toEqual([]);
    expect(await h.insights.listLedger(10)).toEqual([]);
  });

  it("refuses a query with no prompt", async () => {
    const h = await build();
    await expect(h.service.promptCount("from:robin")).rejects.toBeInstanceOf(
      InvalidAgentSettingError,
    );
    await expect(h.service.promptRun("prompt:")).rejects.toBeInstanceOf(InvalidAgentSettingError);
  });

  it("knows nothing before the search, then searches, keeps the queries and reads what it found (rules 4 to 7)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("decide-old", ["Hello", "Please decide by Monday\nThanks"], { dayOffset: 300 });
    await h.addMail("decide-new", ["Please decide by Friday"], { dayOffset: 1 });
    await h.addMail("lunch", ["Lunch on Tuesday?"], { dayOffset: 2 });
    // Never searched: an account without consent.
    await h.addMail("elsewhere", ["Please decide by Sunday"], { accountId: "acc2" });
    await h.ready();

    const count = await h.service.promptCount(PROMPT);
    expect(count).toMatchObject(NOT_SEARCHED);
    expect(count.promptKey).toMatch(/^[0-9a-f]{64}$/);
    expect(runtime.calls).toEqual([]);

    const result = await h.service.promptRun(PROMPT);
    // The plan turn sees the prompt as the person's words and no mail (ADR 0080).
    const [plan] = runtime.of("plan");
    expect(plan?.untrusted).toContain("what needs my decision");
    expect(plan?.untrusted).not.toContain("Please decide");
    // Old mail is found as well as new: the search is not a walk of the newest.
    const [request] = runtime.of("verdicts");
    expect(runtime.of("verdicts")).toHaveLength(1);
    expect(request?.instructions).toBe(PROMPT_INSTRUCTIONS);
    expect(request?.untrusted).toContain("\nwhat needs my decision\n");
    expect(subjectsOf(request as AgentRunRequest).sort()).toEqual([
      "Subject decide-new",
      "Subject decide-old",
    ]);
    expect(request?.untrusted).toContain("Signals: unread; not starred; not answered by You;");
    expect(result).toMatchObject({
      ai: "on",
      searched: true,
      found: 2,
      read: 2,
      fits: 2,
      stopped: false,
      rejected: 0,
    });
    expect(result.rows.map((r) => [r.threadId, r.fit, r.why, r.quote?.text])).toEqual([
      ["decide-new", 2, "It asks for a decision.", "Please decide by Friday"],
      ["decide-old", 2, "It asks for a decision.", "Please decide by Monday"],
    ]);
    expect(result.rows[1]?.unread).toBe(2);
    expect(await h.insights.getPromptSearch(count.promptKey, "")).toMatchObject({
      queries: ["decide"],
    });

    expect(await h.service.promptVerdicts(PROMPT)).toEqual({
      ai: "on",
      promptKey: count.promptKey,
      searched: true,
      found: 2,
      read: 2,
      fits: 2,
      toRead: 0,
      rows: result.rows,
    });
    // Lines for the search and for the batch, with the runtime and counts; no prompt, no mail.
    const ledger = (await h.insights.listLedger(10)).filter((l) => l.purpose === "prompt");
    expect(ledger.length).toBeGreaterThanOrEqual(2);
    expect(ledger.every((l) => l.runtimeId === "fake" && l.accountId === "acc1")).toBe(true);
    expect(ledger).toContainEqual({
      atMs: NOW,
      runtimeId: "fake",
      accountId: "acc1",
      purpose: "prompt",
      threads: 2,
    });
    expect(JSON.stringify(ledger)).not.toMatch(/decide|decision/);
    // The phases as they went: the search with its true steps, then the reading.
    expect(h.progress.at(0)).toEqual({
      promptKey: count.promptKey,
      phase: "searching",
      done: 0,
      total: 0,
      finished: false,
    });
    expect(h.progress).toContainEqual({
      promptKey: count.promptKey,
      phase: "searching",
      done: 0,
      total: 0,
      step: { query: "decide", threads: 2 },
      finished: false,
    });
    expect(h.progress.at(-1)).toEqual({
      promptKey: count.promptKey,
      phase: "reading",
      done: 2,
      total: 2,
      finished: true,
    });
  });

  it("comes back with no model: the kept queries run here, and nothing new costs nothing (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("a", ["Please decide by Friday"], { dayOffset: 2 });
    await h.addMail("b", ["Can you decide on lunch"], { dayOffset: 3 });
    await h.ready();
    await h.service.promptRun(PROMPT);
    const spent = runtime.calls.length;

    expect(await h.service.promptCount(PROMPT)).toMatchObject({
      searched: true,
      found: 2,
      read: 2,
      fits: 1,
    });
    const again = await h.service.promptRun(PROMPT);
    expect((await h.service.promptVerdicts(PROMPT)).rows.map((r) => r.threadId)).toEqual(["a"]);
    expect(again.rows.map((r) => r.threadId)).toEqual(["a"]);
    expect(runtime.calls).toHaveLength(spent);
    // White space is folded in the key: the same prompt, the same search and verdicts.
    expect(await h.service.promptCount('prompt:"what  needs my\tdecision"')).toMatchObject({
      searched: true,
      read: 2,
    });
    // Another prompt shares nothing with this one.
    expect(await h.service.promptCount("prompt:invoices")).toMatchObject(NOT_SEARCHED);
  });

  it("reads a new matching thread on return with one batch and no search (rules 4 and 5)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("a", ["Please decide by Friday"], { dayOffset: 2 });
    await h.ready();
    await h.service.promptRun(PROMPT);
    expect(runtime.of("plan")).toHaveLength(1);
    expect(runtime.of("verdicts")).toHaveLength(1);

    // New mail the kept query finds, and a new message in a thread already read.
    await h.addMail("c", ["Please decide by Sunday"], { dayOffset: 1 });
    expect(await h.service.promptCount(PROMPT)).toMatchObject({ found: 2, read: 1 });
    const back = await h.service.promptRun(PROMPT);
    expect(runtime.of("plan")).toHaveLength(1);
    expect(runtime.of("follow")).toHaveLength(1);
    expect(runtime.of("verdicts")).toHaveLength(2);
    expect(subjectsOf(runtime.of("verdicts")[1] as AgentRunRequest)).toEqual(["Subject c"]);
    expect(back.rows.map((r) => r.threadId)).toEqual(["c", "a"]);
  });

  it("reads what narrow mail filters match, whole, with no search (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("robin", ["Please decide by Friday"], { dayOffset: 3 });
    await h.addMail("robin-chat", ["See you soon"], { dayOffset: 2 });
    await h.addMail("sam", ["Please decide by Monday"], {
      from: "sam@example.net",
      name: "Sam Sample",
    });
    await h.ready();
    const query = `from:robin ${PROMPT}`;
    const result = await h.service.promptRun(query);
    // No search turn of any kind: every thread the filters match was judged, newest first.
    expect(runtime.of("plan")).toHaveLength(0);
    expect(runtime.of("follow")).toHaveLength(0);
    expect(runtime.of("verdicts")).toHaveLength(1);
    expect(subjectsOf(runtime.of("verdicts")[0] as AgentRunRequest)).toEqual([
      "Subject robin-chat",
      "Subject robin",
    ]);
    expect(result).toMatchObject({ found: 2, read: 2, fits: 1, whole: true });
    expect(result.rows.map((r) => r.threadId)).toEqual(["robin"]);
    expect(h.progress.some((p) => p.phase === "searching" && p.step !== undefined)).toBe(false);
    expect(await h.insights.getPromptSearch(result.promptKey, "from:robin")).toMatchObject({
      queries: [],
      threadIds: [],
      whole: true,
    });
    // Coming back costs nothing; Search again has no search to run either.
    await h.service.promptRun(query);
    await h.service.promptRun(query, true);
    expect(runtime.calls).toHaveLength(1);
    // A new thread the filters match: one batch with only it.
    await h.addMail("robin-new", ["Please decide by Sunday"], { dayOffset: 1 });
    expect(await h.service.promptCount(query)).toMatchObject({ found: 3, read: 2 });
    const back = await h.service.promptRun(query);
    expect(runtime.of("plan")).toHaveLength(0);
    expect(runtime.of("verdicts")).toHaveLength(2);
    expect(subjectsOf(runtime.of("verdicts")[1] as AgentRunRequest)).toEqual(["Subject robin-new"]);
    expect(back.rows.map((r) => r.threadId)).toEqual(["robin-new", "robin"]);
  });

  it("searches once a narrow view's filters match more than PROMPT_ASK_ABOVE threads (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("robin", ["Please decide by Friday"], { dayOffset: 3 });
    await h.ready();
    const query = `from:robin ${PROMPT}`;
    expect(await h.service.promptRun(query)).toMatchObject({ found: 1, whole: true });
    await h.addFiller(PROMPT_ASK_ABOVE);
    // The whole match no longer stands: nothing is known until a run searches.
    expect(await h.service.promptCount(query)).toMatchObject({ searched: false });
    const searched = await h.service.promptRun(query);
    expect(runtime.of("plan")).toHaveLength(1);
    expect(searched.whole).toBeUndefined();
    expect(searched).toMatchObject({ found: 1, read: 1 });
    expect(runtime.of("verdicts")).toHaveLength(1);
  });

  it("narrows every search by the mail filters, in code (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    // More than PROMPT_ASK_ABOVE threads match `from:robin`: the prompt searches.
    await h.addFiller(PROMPT_ASK_ABOVE + 1);
    await h.addMail("robin", ["Please decide by Friday"]);
    await h.addMail("sam", ["Please decide by Monday"], {
      from: "sam@example.net",
      name: "Sam Sample",
    });
    await h.ready();
    const query = `from:robin ${PROMPT}`;
    const result = await h.service.promptRun(query);
    expect(result).toMatchObject({ found: 1, read: 1 });
    expect(result.rows.map((r) => r.threadId)).toEqual(["robin"]);
    // The follow turn saw only what the filters match; so did the batch.
    expect(runtime.of("follow")[0]?.untrusted).not.toContain("Subject sam");
    expect(subjectsOf(runtime.of("verdicts")[0] as AgentRunRequest)).toEqual(["Subject robin"]);
    // Kept under the filters: the same prompt without them has not searched yet.
    expect(await h.insights.getPromptSearch(result.promptKey, "from:robin")).not.toBeNull();
    expect(await h.service.promptCount(PROMPT)).toMatchObject(NOT_SEARCHED);
  });

  it("with the loop on: two tools, the prompt as data and no mail, each search_mail narrowed by the filters (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addFiller(PROMPT_ASK_ABOVE + 1);
    await h.addMail("robin", ["Please decide by Friday"]);
    await h.addMail("sam", ["Please decide by Monday"], {
      from: "sam@example.net",
      name: "Sam Sample",
    });
    await h.addMail("robin-old", ["Can you decide on the venue"], { dayOffset: 400 });
    await h.ready();
    await h.settings.update({ talkLoop: true });
    const answers: string[] = [];
    const loops = withTools(runtime, async (call) => {
      const found = await call("search_mail", { query: "decide" });
      answers.push(found);
      answers.push(await call("count_mail", { query: "decide" }));
      const [first] = numbersIn(found);
      await call("open_thread", { number: first });
      return { threads: [first], hypothesis: "One thread asks for a decision." };
    });
    const result = await h.service.promptRun(`from:robin ${PROMPT}`);
    expect(runtime.of("plan")).toHaveLength(0);
    expect(loops).toHaveLength(1);
    const [{ request, options }] = loops as [(typeof loops)[number]];
    expect(request.instructions).toBe(PROMPT_SEARCH_INSTRUCTIONS);
    expect(request.untrusted).toContain("what needs my decision");
    expect(request.untrusted).not.toContain("Please decide");
    expect(options.server.tools).toEqual(["search_mail", "open_thread"]);
    // What the tool listed is narrowed by `from:robin`; a tool not offered is refused.
    expect(answers[0]).toContain("Subject robin");
    expect(answers[0]).not.toContain("Subject sam");
    expect(answers[1]).toMatch(/^error: Unknown tool/);
    expect(result).toMatchObject({ searched: true, found: 2, read: 2 });
    // The thread it named goes first, then the best of what the search listed.
    const named = /^\[Thread 1\]\n\\?Subject: (.*)$/m.exec(answers[0] ?? "")?.[1];
    expect(named).toBeDefined();
    expect(subjectsOf(runtime.of("verdicts")[0] as AgentRunRequest)[0]).toBe(named);
    expect(await h.insights.getPromptSearch(result.promptKey, "from:robin")).toMatchObject({
      queries: ["decide"],
    });
  });

  it("falls back to the plan turn when the runtime cannot run tools, as the talk does", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("a", ["Please decide by Friday"]);
    await h.ready();
    await h.settings.update({ talkLoop: true });
    expect(runtime.runWithTools).toBeUndefined();
    const result = await h.service.promptRun(PROMPT);
    expect(runtime.of("plan")).toHaveLength(1);
    expect(result.rows.map((r) => r.threadId)).toEqual(["a"]);
    // The loop off: the plan turn too, even with tools.
    const withLoop = new Responder();
    const h2 = await build(withLoop);
    const loops = withTools(withLoop, async () => ({ threads: [], hypothesis: "" }));
    await h2.addMail("a", ["Please decide by Friday"]);
    await h2.ready();
    await h2.service.promptRun(PROMPT);
    expect(loops).toHaveLength(0);
    expect(withLoop.of("plan")).toHaveLength(1);
  });

  it("Search again runs the search anew and replaces what was kept (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    await h.addMail("a", ["Please decide by Friday"], { dayOffset: 2 });
    await h.addMail("b", ["The budget needs a choice: decide or wait"], { dayOffset: 500 });
    await h.ready();
    runtime.queries = ["friday"];
    const first = await h.service.promptRun(PROMPT);
    expect(first).toMatchObject({ found: 1 });
    runtime.queries = ["decide"];
    // Without `again` the kept search stands.
    await h.service.promptRun(PROMPT);
    expect(runtime.of("plan")).toHaveLength(1);
    const again = await h.service.promptRun(PROMPT, true);
    expect(runtime.of("plan")).toHaveLength(2);
    expect(again).toMatchObject({ found: 2, read: 2 });
    // Only the thread with no verdict went to the batch.
    expect(subjectsOf(runtime.of("verdicts").at(-1) as AgentRunRequest)).toEqual(["Subject b"]);
    expect(await h.insights.getPromptSearch(first.promptKey, "")).toMatchObject({
      queries: ["decide"],
    });
  });

  it("keeps a fit of 1 and does not list it (rule 7)", async () => {
    const runtime = new Responder();
    runtime.answer = async () => ({
      value: {
        verdicts: [
          {
            thread: 1,
            fit: 1,
            why: "It only mentions a decision.",
            message: 1,
            quote: "Please decide by Friday",
          },
        ],
      },
    });
    const h = await build(runtime);
    await h.addMail("t1", ["Please decide by Friday"]);
    await h.ready();
    const result = await h.service.promptRun(PROMPT);
    expect(result).toMatchObject({ found: 1, read: 1, fits: 0, rows: [] });
    const view = await h.storage.store.getThread("t1", { visibleOnly: true });
    expect(
      await h.insights.getPromptVerdicts(result.promptKey, PROMPT_VERSION, [
        { threadId: "t1", lastMessageKey: view?.thread.lastMessageKey ?? 0 },
      ]),
    ).toMatchObject([{ fit: 1, why: "It only mentions a decision." }]);
  });

  it("stores a fit whose quote is not in the mail as 0, so it does not show (rule 6)", async () => {
    const runtime = new Responder();
    runtime.answer = async () => ({
      value: {
        verdicts: [{ thread: 1, fit: 3, why: "Urgent.", message: 1, quote: "Pay now or lose it" }],
      },
    });
    const h = await build(runtime);
    await h.addMail("t1", ["Please decide by Friday"]);
    await h.ready();
    const result = await h.service.promptRun(PROMPT);
    expect(result).toMatchObject({ read: 1, rows: [], rejected: 0 });
  });

  it("keeps nothing of an answer that names a thread it was not sent, and counts it rejected", async () => {
    const runtime = new Responder();
    runtime.answer = async () => ({ value: { verdicts: [{ thread: 7, fit: 0, why: "No." }] } });
    const h = await build(runtime);
    await h.addMail("t1", ["Please decide by Friday"]);
    await h.ready();
    expect(await h.service.promptRun(PROMPT)).toMatchObject({ read: 0, rejected: 1 });
    // What went is in the ledger all the same.
    expect((await h.insights.listLedger(1))[0]).toMatchObject({ purpose: "prompt", threads: 1 });
  });

  it("Stop in the search keeps nothing half-written (rule 9)", async () => {
    const runtime = new Responder();
    runtime.plan = (_request, signal) =>
      new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true });
      });
    const h = await build(runtime);
    await h.addMail("t1", ["Please decide by Friday"]);
    await h.ready();
    const running = h.service.promptRun(PROMPT);
    while (runtime.of("plan").length === 0) await new Promise((r) => setTimeout(r, 1));
    expect(await h.service.promptCount(PROMPT)).toMatchObject({
      searched: false,
      running: { phase: "searching" },
    });
    await h.service.promptStop();
    const result = await running;
    expect(result).toMatchObject({ ...NOT_SEARCHED, stopped: true, rows: [] });
    expect(result.problem).toBeUndefined();
    expect(await h.insights.getPromptSearch(result.promptKey, "")).toBeNull();
    expect(runtime.of("verdicts")).toHaveLength(0);
    // The next run searches again.
    runtime.plan = async () => ({ value: planOf(["decide"]) });
    expect(await h.service.promptRun(PROMPT)).toMatchObject({ searched: true, read: 1 });
  });

  it("reads in batches, and Stop in the reading keeps the batches that finished (rule 9)", async () => {
    const runtime = new Responder();
    let release: (() => void) | undefined;
    const firstDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered = 0;
    runtime.answer = (request, signal) => {
      // The first full batch is answered; the others run at the same time and wait to be stopped.
      if (subjectsOf(request).length === MAX_PROMPT_BATCH_THREADS && answered++ === 0) {
        return Promise.resolve({ value: judgeAll(request) });
      }
      return new Promise((_, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("Cancelled.")), { once: true });
      });
    };
    const h = await build(runtime);
    const threads = 2 * MAX_PROMPT_BATCH_THREADS + 3;
    for (let i = 0; i < threads; i++) {
      await h.addMail(`t${String(i).padStart(2, "0")}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const running = h.service.promptRun(PROMPT);
    const watch = setInterval(() => {
      if (h.progress.some((p) => p.phase === "reading" && p.done > 0)) release?.();
    }, 1);
    await firstDone;
    clearInterval(watch);
    expect(await h.service.promptCount(PROMPT)).toMatchObject({
      read: MAX_PROMPT_BATCH_THREADS,
      running: { phase: "reading", done: MAX_PROMPT_BATCH_THREADS, total: threads },
    });
    await h.service.promptStop();
    const result = await running;
    expect(result).toMatchObject({ stopped: true, read: MAX_PROMPT_BATCH_THREADS });
    // What is left to read is what the line says: found less read.
    expect(result.found - result.read).toBe(threads - MAX_PROMPT_BATCH_THREADS);
    expect(result.ask).toBeUndefined();
    expect(result.rows).toHaveLength(MAX_PROMPT_BATCH_THREADS);
    expect("running" in result).toBe(false);
    expect(
      runtime
        .of("verdicts")
        .map((c) => subjectsOf(c).length)
        .sort(),
    ).toEqual([10, 10, 3]);
    expect(h.progress.at(-1)).toMatchObject({ finished: true });
    // A second run reads only what is left, with no search.
    runtime.answer = async (request) => ({ value: judgeAll(request) });
    const rest = await h.service.promptRun(PROMPT);
    expect(rest).toMatchObject({ read: threads, stopped: false });
    expect(runtime.of("plan")).toHaveLength(1);
  });

  it("ends a run the plan cuts short, keeping what finished and saying why", async () => {
    const runtime = new Responder();
    runtime.answer = async (request) => {
      if (runtime.of("verdicts").length > 1) {
        throw new AgentRunError("limit", "The plan is used up.");
      }
      return { value: judgeAll(request) };
    };
    const h = await build(runtime);
    for (let i = 0; i < 3 * MAX_PROMPT_BATCH_THREADS; i++) {
      await h.addMail(`t${i}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const result = await h.service.promptRun(PROMPT);
    expect(result.stopped).toBe(false);
    expect(result.problem).toMatch(/allowance/);
    expect(result.read).toBe(MAX_PROMPT_BATCH_THREADS);
  });

  it("has no cap of its own: above PROMPT_ASK_ABOVE it asks, then reads every match (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    const n = 450;
    for (let i = 0; i < n; i++) {
      await h.addMail(`t${String(i).padStart(3, "0")}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const asked = await h.service.promptRun(PROMPT);
    // The count is said and nothing is read: one more ↵ is the person's.
    expect(asked).toMatchObject({ searched: true, found: n, read: 0, ask: true, stopped: false });
    expect(runtime.of("verdicts")).toHaveLength(0);
    expect(h.progress.at(-1)).toMatchObject({ phase: "reading", total: n, finished: true });
    // Asked again without readAll: still a question, and no search again.
    expect(await h.service.promptRun(PROMPT)).toMatchObject({ ask: true, read: 0 });
    const all = await h.service.promptRun(PROMPT, false, true);
    expect(all.ask).toBeUndefined();
    expect(all).toMatchObject({ found: n, read: n, fits: n });
    expect(all.rows).toHaveLength(n);
    expect(runtime.of("plan")).toHaveLength(1);
    const sent = runtime.of("verdicts").flatMap(subjectsOf);
    expect(sent).toHaveLength(n);
    expect(new Set(sent).size).toBe(n);
    // A return visit with nothing new: no call at all.
    const spent = runtime.calls.length;
    await h.service.promptRun(PROMPT);
    expect(runtime.calls).toHaveLength(spent);
  });

  it("reads up to PROMPT_ASK_ABOVE threads by itself, with no question (rule 4)", async () => {
    const runtime = new Responder();
    const h = await build(runtime);
    for (let i = 0; i < PROMPT_ASK_ABOVE; i++) {
      await h.addMail(`t${String(i).padStart(3, "0")}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const result = await h.service.promptRun(PROMPT);
    expect(result.ask).toBeUndefined();
    expect(result).toMatchObject({ found: PROMPT_ASK_ABOVE, read: PROMPT_ASK_ABOVE });
  });

  it("limit: reads until N fit, never searches again for it, and reads on when raised (rule 4a)", async () => {
    const runtime = new Responder();
    runtime.queries = ["decide"];
    const h = await build(runtime);
    // Every other thread fits: t00, t02, … hold the line, t01, t03, … do not. More than the
    // turns that run at once can take: what is read past the limit is a few batches, not all.
    for (let i = 0; i < 80; i++) {
      await h.addMail(
        `t${String(i).padStart(2, "0")}`,
        [i % 2 === 0 ? "Please decide by Friday" : "Nothing to decide here, decide nothing"],
        { dayOffset: 1 + i, from: `person${i}@example${i}.org` },
      );
    }
    await h.ready();
    const other = 'prompt:"decide something"';
    // Read in batches of ten, one turn at a time here: 5 fit within the first ten read.
    const five = await h.service.promptRun(`${other} limit:5`);
    expect(five).toMatchObject({ found: 80, limit: 5, fits: 5, toRead: 0, reached: true });
    expect(five.rows).toHaveLength(5);
    const read = runtime.of("verdicts").flatMap(subjectsOf).length;
    expect(read).toBeLessThan(80);
    expect(runtime.of("plan")).toHaveLength(1);
    // A return visit: the limit's worth is kept, and nothing goes.
    const again = await h.service.promptRun(`${other} limit:5`);
    expect(again.rows.map((r) => r.threadId)).toEqual(five.rows.map((r) => r.threadId));
    expect(runtime.of("verdicts").flatMap(subjectsOf)).toHaveLength(read);
    // Raised: the same search, and the reading goes on from where it stopped.
    const raised = await h.service.promptRun(`limit:30 ${other}`);
    expect(raised).toMatchObject({ found: 80, limit: 30, fits: 30, reached: true });
    expect(runtime.of("plan")).toHaveLength(1);
    const readRaised = runtime.of("verdicts").flatMap(subjectsOf);
    expect(new Set(readRaised).size).toBe(readRaised.length);
    // Removed: the rest, nothing twice, and the first five are among what fits.
    const all = await h.service.promptRun(other);
    expect(all).toMatchObject({ found: 80, read: 80, fits: 40, toRead: 0 });
    expect(all.limit).toBeUndefined();
    const everything = runtime.of("verdicts").flatMap(subjectsOf);
    expect(everything).toHaveLength(80);
    expect(new Set(everything).size).toBe(80);
    for (const r of five.rows) expect(all.rows.map((x) => x.threadId)).toContain(r.threadId);
    // A smaller limit after all is read lists that many, and asks nothing.
    const three = await h.service.promptVerdicts(`${other} limit:3`);
    expect(three.rows).toHaveLength(3);
    expect(three).toMatchObject({ fits: 3, toRead: 0, reached: true });
  });

  it("limit with sort: newest reads newest first, oldest oldest first, and lists by date (rules 4a, 4b)", async () => {
    const runtime = new Responder();
    runtime.queries = ["decide"];
    const h = await build(runtime);
    for (let i = 0; i < 80; i++) {
      await h.addMail(`t${String(i).padStart(2, "0")}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    // t00 is the newest (a day ago), t79 the oldest.
    const newest = await h.service.promptRun(`${PROMPT} sort:newest limit:3`);
    expect(newest.rows.map((r) => r.threadId)).toEqual(["t00", "t01", "t02"]);
    expect(newest).toMatchObject({ fits: 3, reached: true });
    const sentNewest = runtime.of("verdicts").flatMap(subjectsOf);
    expect(sentNewest[0]).toBe("Subject t00");
    const oldest = await h.service.promptRun(`${PROMPT} sort:oldest limit:3`);
    expect(oldest.rows.map((r) => r.threadId)).toEqual(["t79", "t78", "t77"]);
    const sentOldest = runtime.of("verdicts").flatMap(subjectsOf).slice(sentNewest.length);
    expect(sentOldest[0]).toBe("Subject t79");
    // Changing the order never searches again (rule 4b): the queries are kept under the filters.
    expect(runtime.of("plan")).toHaveLength(1);
    // Without a limit the order is only the list's: nothing more is read for it.
    const before = runtime.of("verdicts").length;
    await h.service.promptRun(PROMPT);
    const byDate = await h.service.promptVerdicts(`${PROMPT} sort:oldest`);
    const dates = byDate.rows.map((r) => r.message.dateMs);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
    const byNewest = await h.service.promptVerdicts(`sort:newest ${PROMPT}`);
    expect(byNewest.rows.map((r) => r.threadId)).toEqual(
      byDate.rows.map((r) => r.threadId).reverse(),
    );
    expect(runtime.of("plan")).toHaveLength(1);
    expect(runtime.of("verdicts").length).toBeGreaterThan(before);
    const after = runtime.of("verdicts").length;
    await h.service.promptRun(`${PROMPT} sort:relevance`);
    expect(runtime.of("verdicts").length).toBe(after);
  });

  it("limit on a return visit: a new thread is read under sort:newest, passed over in the search's order (rule 4a)", async () => {
    const runtime = new Responder();
    runtime.queries = ["decide"];
    const h = await build(runtime);
    for (let i = 0; i < 12; i++) {
      await h.addMail(`t${String(i).padStart(2, "0")}`, ["Please decide by Friday"], {
        dayOffset: 2 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const q = `${PROMPT} limit:3`;
    await h.service.promptRun(`${q} sort:newest`);
    await h.service.promptRun(q);
    const calls = runtime.of("verdicts").length;
    // Nothing new: zero calls under either order.
    await h.service.promptRun(`${q} sort:newest`);
    await h.service.promptRun(q);
    expect(runtime.of("verdicts")).toHaveLength(calls);
    // New mail that fits, newer than all.
    await h.addMail("fresh", ["Please decide by Friday"], {
      dayOffset: 0,
      from: "new@example.net",
    });
    // In the search's order the three found stay the answer: no call.
    const kept = await h.service.promptRun(q);
    expect(runtime.of("verdicts")).toHaveLength(calls);
    expect(kept.rows).toHaveLength(3);
    // By date it may take the place of the oldest of the three: it is read, and it does.
    expect(await h.service.promptCount(`${q} sort:newest`)).toMatchObject({ toRead: 1, fits: 3 });
    const fresh = await h.service.promptRun(`${q} sort:newest`);
    expect(runtime.of("verdicts")).toHaveLength(calls + 1);
    expect(fresh.rows.map((r) => r.threadId)).toEqual(["fresh", "t00", "t01"]);
  });

  it("limit: one run reads at most PROMPT_ASK_ABOVE when few fit, and the next reads on (rules 4, 4a)", async () => {
    // Found on a copy of a real mailbox: `limit:20` over 49,532 candidates of which few fit, or
    // `sort:newest limit:10` with 1,924 unread before the tenth fit, would read them all on one
    // `↵` with no question. The limit bounds the result, not what is read.
    const runtime = new Responder();
    runtime.queries = ["decide"];
    const h = await build(runtime);
    const n = PROMPT_ASK_ABOVE + 40;
    for (let i = 0; i < n; i++) {
      // Only the two oldest fit.
      await h.addMail(
        `t${String(i).padStart(3, "0")}`,
        [i >= n - 2 ? "Please decide by Friday" : "Nothing to decide here, decide nothing"],
        { dayOffset: 1 + i, from: `person${i}@example${i}.org` },
      );
    }
    await h.ready();
    const q = `${PROMPT} sort:newest limit:5`;
    const first = await h.service.promptRun(q, false, true);
    const sent = runtime.of("verdicts").flatMap(subjectsOf).length;
    expect(sent).toBe(PROMPT_ASK_ABOVE);
    expect(first).toMatchObject({ found: n, fits: 0, toRead: n - PROMPT_ASK_ABOVE });
    expect(first.ask).toBeUndefined();
    // The next ↵ reads on from where it stopped, and finds the two.
    const second = await h.service.promptRun(q, false, true);
    expect(runtime.of("verdicts").flatMap(subjectsOf)).toHaveLength(n);
    expect(second).toMatchObject({ fits: 2, toRead: 0 });
    expect(second.rows).toHaveLength(2);
  });

  it("limit: turns in parallel never list more than N (rule 4a)", async () => {
    const runtime = new Responder();
    runtime.queries = ["decide"];
    // Every turn waits a little, so that three run at once.
    const answer = runtime.answer;
    let inFlight = 0;
    let most = 0;
    runtime.answer = async (request, signal) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return answer(request, signal);
    };
    const h = await build(runtime);
    for (let i = 0; i < 80; i++) {
      await h.addMail(`t${String(i).padStart(2, "0")}`, ["Please decide by Friday"], {
        dayOffset: 1 + i,
        from: `person${i}@example${i}.org`,
      });
    }
    await h.ready();
    const r = await h.service.promptRun(`${PROMPT} limit:4`);
    expect(most).toBeGreaterThan(1);
    expect(r.rows).toHaveLength(4);
    expect(r).toMatchObject({ fits: 4, reached: true });
    // A few extra verdicts are fine; the whole set is not read.
    expect(runtime.of("verdicts").flatMap(subjectsOf).length).toBeLessThan(80);
    // Under a limit nothing is asked, however much was found (rule 4a).
    expect(r.ask).toBeUndefined();
  });

  it("removes verdicts with the thread's mail, and keeps a saved view's prompt past the cut (rule 12)", async () => {
    const h = await build();
    await h.addMail("t1", ["Please decide by Friday"]);
    await h.ready();
    await h.service.promptRun(PROMPT);
    await h.service.promptRun('prompt:"decide other"');
    await h.storage.views.put({
      id: "v1",
      name: "Decisions",
      query: `in:inbox ${PROMPT}`,
      position: 1,
      createdMs: 1,
      updatedMs: 1,
    });
    await h.clock.advance(31 * DAY);
    // A run prunes first: the unsaved prompt's verdicts and search go, the saved one's stay.
    await h.service.promptRun("prompt:third");
    expect(await h.service.promptCount(PROMPT)).toMatchObject({ searched: true, read: 1 });
    expect(await h.service.promptCount('prompt:"decide other"')).toMatchObject(NOT_SEARCHED);
    await h.insights.removeForThreads(["t1"]);
    expect((await h.service.promptCount(PROMPT)).read).toBe(0);
  });
});

describe("the demo runtime (ADR 0116)", () => {
  it("searches and judges the same way every time, with varied fits and reasons the code accepts", async () => {
    const demo = new DemoAgentRuntime(() => NOW, 0);
    const h = await build(demo as unknown as Responder);
    await h.addMail(
      "pay",
      [
        "Hello,",
        "The invoice is due on Friday.",
        "Did you pay the invoice yet?\nThe invoice total is 40.\nPay the invoice by card.",
        "Paid the invoice now.",
      ],
      { dayOffset: 2 },
    );
    await h.addMail("twice", ["The invoice came.", "I sent the invoice on."], { dayOffset: 3 });
    await h.addMail("once", ["One invoice, by the way."], { dayOffset: 4 });
    await h.addMail("chat", ["See you soon"], { dayOffset: 5 });
    await h.ready();
    const query = 'prompt:"invoice to pay"';
    const first = await h.service.promptRun(query);
    expect(first.rejected).toBe(0);
    expect(first).toMatchObject({ searched: true, found: 3, read: 3, fits: 2 });
    expect(first.rows.map((r) => [r.threadId, r.fit])).toEqual([
      ["pay", 3],
      ["twice", 2],
    ]);
    expect(new Set(first.rows.map((r) => r.why)).size).toBe(2);
    expect(first.rows[0]?.quote?.text).toBe("The invoice is due on Friday.");
    await settle();
    expect((await h.service.promptVerdicts(query)).rows).toEqual(first.rows);
  });
});
