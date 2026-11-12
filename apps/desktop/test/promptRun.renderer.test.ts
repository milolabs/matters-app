// A prompt is a filter (ADR 0116), on the page: the bar's pill, the line under it, the run (its
// search, then the reading) with its progress and Stop, Search again, the list in the prompt's
// order, and the saved view that holds a prompt.
import type { BackendEvent } from "@matters/contracts";
import {
  type AgentStatus,
  type Message,
  PROMPT_ASK_ABOVE,
  type PromptCount,
  type PromptList,
  type PromptRow,
  type PromptRunResult,
  parseQuery,
  type SavedView,
} from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { type Backend, BackendError } from "../src/renderer/client.ts";
import { layoutList } from "../src/renderer/listLayout.ts";
import { createPromptRun } from "../src/renderer/promptRun.ts";
import {
  FOUND_NOTHING,
  NOTHING_FITS,
  promptLine,
  promptOff,
  promptOffText,
  READ_ALL,
  READY,
  SEARCHING,
  SOME_REJECTED,
  STOPPING,
  withPromptOffText,
} from "../src/renderer/promptView.ts";
import { querySegments } from "../src/renderer/querySegments.ts";
import { querySuggestions } from "../src/renderer/querySuggestions.ts";
import { createMailStore } from "../src/renderer/store.ts";
import { createViewsStore, holdsPrompt } from "../src/renderer/views.ts";

const QUERY = 'from:office prompt:"what needs my decision"';
const KEY = "k1";

const msg = (key: number, threadId = `t${key}`, over: Partial<Message> = {}): Message =>
  makeMessage({ key, providerId: `p${key}`, threadId, dateMs: key * 1000, ...over });

const row = (key: number, fit: 2 | 3, why = `Reason ${key}.`): PromptRow => ({
  threadId: `t${key}`,
  message: msg(key),
  unread: 0,
  fit,
  why,
});

const count = (over: Partial<PromptCount> = {}): PromptCount => ({
  ai: "on",
  promptKey: KEY,
  searched: true,
  found: 10,
  read: 0,
  fits: 0,
  ...over,
});

const list = (rows: readonly PromptRow[], over: Partial<PromptCount> = {}): PromptList => ({
  ...count(over),
  rows,
});

/** A timer the test fires by hand. */
function timers() {
  const waiting: { run: () => void; ms: number; gone: boolean }[] = [];
  return {
    schedule: (run: () => void, ms: number) => {
      const t = { run, ms, gone: false };
      waiting.push(t);
      return () => {
        t.gone = true;
      };
    },
    fire() {
      for (const t of waiting.splice(0)) if (!t.gone) t.run();
    },
    pending: () => waiting.filter((t) => !t.gone).length,
  };
}

const tick = async (n = 6) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A backend for the prompt only: answers come from the test, events go to the listeners. */
function rig() {
  const calls: string[] = [];
  /** Whether each run asked to read everything (rule 4). */
  const readAlls: boolean[] = [];
  const listeners = new Set<(e: BackendEvent) => void>();
  let counted: PromptCount = count();
  let verdicts: PromptList = list([]);
  let runs: ((query: string) => Promise<PromptRunResult>)[] = [];
  const backend = {
    async agentPromptCount(query: string) {
      calls.push(`count ${query}`);
      return counted;
    },
    async agentPromptVerdicts(query: string) {
      calls.push(`verdicts ${query}`);
      return verdicts;
    },
    async agentPromptRun(query: string, again?: boolean, readAll?: boolean) {
      calls.push(`${again === true ? "again" : "run"} ${query}`);
      readAlls.push(readAll === true);
      const next = runs.shift();
      if (!next) throw new Error("no scripted run");
      return next(query);
    },
    async agentPromptStop() {
      calls.push("stop");
    },
    onEvent(listener: (e: BackendEvent) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } as unknown as Backend;
  return {
    backend,
    calls,
    readAlls,
    push: (e: BackendEvent) => {
      for (const l of listeners) l(e);
    },
    setCount: (c: PromptCount) => {
      counted = c;
    },
    setVerdicts: (l: PromptList) => {
      verdicts = l;
    },
    /** The next run answers at once with this, or fails with it. */
    answerRun(answer: PromptRunResult | Error) {
      runs = [
        ...runs,
        async () => {
          if (answer instanceof Error) throw answer;
          return answer;
        },
      ];
    },
    /** The next run waits for the test: `end` answers it. */
    holdRun() {
      let end!: (r: PromptRunResult) => void;
      let fail!: (e: unknown) => void;
      runs = [
        ...runs,
        () =>
          new Promise<PromptRunResult>((resolve, reject) => {
            end = resolve;
            fail = reject;
          }),
      ];
      return {
        end: (r: PromptRunResult) => end(r),
        fail: (e: unknown) => fail(e),
      };
    },
  };
}

const result = (
  rows: readonly PromptRow[],
  over: Partial<PromptRunResult> = {},
): PromptRunResult => ({
  ...list(rows, { read: 10 }),
  stopped: false,
  rejected: 0,
  ...over,
});

describe("the prompt in the bar (rules 1 and 11)", () => {
  const segs = (text: string, off = false) =>
    querySegments(text, parseQuery(text, off ? { promptOff: true } : {}));

  it("draws the prompt as one pill of the agent's, apart from the other terms", () => {
    const s = segs(QUERY);
    const prompt = s.filter((x) => x.agent === true);
    expect(prompt.map((x) => `${x.kind}:${x.state}:${x.text}`)).toEqual([
      "key:ok:prompt:",
      'value:ok:"what needs my decision"',
    ]);
    expect(prompt[0]?.pill).toBe(prompt[1]?.pill);
    expect(s.filter((x) => x.text.startsWith("from") || x.text === "office")).not.toContainEqual(
      expect.objectContaining({ agent: true }),
    );
  });

  it("marks the prompt invalid while AI is off, and a dropped second one too", () => {
    expect(
      segs(QUERY, true)
        .filter((x) => x.agent)
        .map((x) => x.state),
    ).toEqual(["invalid", "invalid"]);
    const twice = segs("prompt:one prompt:two").filter((x) => x.agent);
    expect(twice.map((x) => x.state)).toEqual(["ok", "ok", "invalid", "invalid"]);
  });

  it("offers prompt: with its hint, the caret inside the quotes, and not while AI is off", () => {
    const text = "from:office pro";
    const sources = { labels: [], accounts: [], people: [] };
    const items = querySuggestions(text, text.length, parseQuery(text), sources).flatMap(
      (g) => g.items,
    );
    const item = items.find((i) => i.label === "prompt:");
    expect(item?.hint).toBe("Your question, read by the assistant");
    const edit = item?.edit;
    if (!edit) throw new Error("no prompt suggestion");
    const after = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
    expect(after).toBe('from:office prompt:""');
    expect(edit.caret).toBe(after.length - 1);
    const off = querySuggestions(text, text.length, parseQuery(text), {
      ...sources,
      noPrompt: true,
    }).flatMap((g) => g.items);
    expect(off.some((i) => i.label === "prompt:")).toBe(false);
  });

  it("says AI is off, or that nothing is shared, and where to change it", () => {
    const status = (consents: AgentStatus["consents"]) =>
      ({
        settings: { kindRuntime: { understand: "claude-code" } },
        consents,
      }) as unknown as AgentStatus;
    expect(promptOff(false, null)).toBe("off");
    expect(promptOff(true, null)).toBeNull();
    expect(promptOff(true, status([]))).toBe("noConsent");
    expect(
      promptOff(true, status([{ accountId: "a", runtimeId: "other", grantedAtMs: 1 }] as never)),
    ).toBe("noConsent");
    expect(
      promptOff(true, status([{ accountId: "a", runtimeId: "claude-code", grantedAtMs: 1 }])),
    ).toBeNull();
    const parsed = withPromptOffText(parseQuery(QUERY, { promptOff: true }), "off");
    expect(parsed.prompt).toBeUndefined();
    expect(parsed.diagnostics.map((d) => d.message)).toEqual([promptOffText("off")]);
    expect(promptOffText("off")).toMatch(/AI is off.*Settings › Agents/);
    expect(promptOffText("noConsent")).toMatch(/No account is shared.*Settings › Agents/);
    // Nothing to put in other words: the same object back.
    const plain = parseQuery("from:office");
    expect(withPromptOffText(plain, "off")).toBe(plain);
  });
});

describe("the line under the bar (rules 4 and 9)", () => {
  const line = (c: PromptCount | null, over: Partial<Parameters<typeof promptLine>[0]> = {}) =>
    promptLine({ count: c, progress: null, stopping: false, outcome: null, ...over });

  it("before the search, says that ↵ searches; there is no cap of ours to say (rule 4)", () => {
    expect(line(count({ searched: false, found: 0 }))).toEqual({ kind: "ready", text: READY });
    expect(READY).toBe("↵ to search your mail with this prompt.");
  });

  it("after a search that found more than PROMPT_ASK_ABOVE, asks for one more ↵ (rule 4)", () => {
    expect(line(count({ found: 1240 }))).toEqual({
      kind: "ask",
      text: "Found 1,240 threads.",
      key: READ_ALL,
    });
    expect(READ_ALL).toBe("↵ to read them all.");
    // At the line it reads by itself; once some are read the line counts what is left.
    expect(line(count({ found: PROMPT_ASK_ABOVE }))?.kind).toBe("count");
    expect(line(count({ found: 1240, read: 300 }))?.text).toBe(
      "940 threads to read, 300 read already.",
    );
    // Under a limit nothing is asked: the limit is the person's own bound (rule 4a).
    expect(line(count({ found: 1240, limit: 500, toRead: 1240 }))).toEqual({
      kind: "count",
      text: "500 to find among 1,240 threads.",
    });
  });

  it("under a limit, counts what fits, not what is read, and says where it stopped (rule 4a)", () => {
    expect(
      line(count({ found: 1240, limit: 10, toRead: 1240 }), {
        progress: { phase: "reading", done: 12, total: 1240, fits: 4 },
      })?.text,
    ).toBe("Reading… 4 of 10 found");
    expect(line(count({ found: 1240, limit: 10, toRead: 1240 }))?.text).toBe(
      "10 to find among 1,240 threads.",
    );
    expect(line(count({ found: 1240, limit: 10, read: 30, fits: 3, toRead: 1210 }))?.text).toBe(
      "7 more to find among 1,210 threads.",
    );
    // The limit's worth fit and nothing before them is unread: where the reading stopped.
    expect(
      line(count({ found: 1240, limit: 10, read: 37, fits: 10, toRead: 0, reached: true })),
    ).toEqual({ kind: "allRead", text: "10 threads fit. Stopped at your limit.", whole: false });
    // By date, unread threads before them are read: one may take the place of the last.
    expect(line(count({ found: 1241, limit: 10, read: 37, fits: 10, toRead: 1 }))?.text).toBe(
      "1 thread to read to be sure of these 10.",
    );
    expect(line(count({ found: 4045, limit: 10, read: 82, fits: 10, toRead: 1924 }))?.text).toBe(
      "1,924 threads to read to be sure of these 10.",
    );
    // Fewer fit than the limit and all is read: what fits of all.
    expect(line(count({ found: 10, limit: 50, read: 10, fits: 3, toRead: 0 }))?.text).toBe(
      "3 of 10 threads fit.",
    );
    // Without a limit the reading counts threads.
    expect(
      line(count({ found: 10 }), { progress: { phase: "reading", done: 1, total: 10 } })?.text,
    ).toBe("Reading 1 of 10 threads…");
  });

  it("offers no Search again when no search ran: the mail filters alone were read", () => {
    expect(line(count({ read: 10, fits: 3, whole: true }))).toEqual({
      kind: "allRead",
      text: "3 of 10 threads fit.",
      whole: true,
    });
  });

  it("after it, says how many threads it found are left to read, and how many are read", () => {
    expect(line(count())).toEqual({ kind: "count", text: "10 threads to read." });
    expect(line(count({ found: 1 }))?.text).toBe("1 thread to read.");
    expect(line(count({ read: 4 }))?.text).toBe("6 threads to read, 4 read already.");
  });

  it("says how many fit once all are read, and when the search found nothing", () => {
    expect(line(count({ read: 10, fits: 3 }))).toEqual({
      kind: "allRead",
      text: "3 of 10 threads fit.",
      whole: false,
    });
    expect(line(count({ found: 1, read: 1, fits: 1 }))?.text).toBe("1 of 1 thread fits.");
    expect(line(count({ found: 0 }))).toEqual({ kind: "none", text: FOUND_NOTHING });
  });

  it("says nothing while AI is off or nothing is known yet", () => {
    expect(line(null)).toBeNull();
    expect(line(count({ ai: "off", promptKey: "", searched: false, found: 0 }))).toBeNull();
  });

  it("shows the search with its last true step, the reading, Stop, and how it ended", () => {
    expect(line(null, { progress: { phase: "searching", done: 0, total: 0 } })).toEqual({
      kind: "searching",
      text: SEARCHING,
      stopping: false,
    });
    expect(
      line(null, {
        progress: {
          phase: "searching",
          done: 0,
          total: 0,
          step: { query: "warranty", threads: 12 },
        },
      })?.text,
    ).toBe("Searched: warranty → 12 threads");
    expect(line(count(), { progress: { phase: "reading", done: 3, total: 10 } })).toEqual({
      kind: "reading",
      text: "Reading 3 of 10 threads…",
      stopping: false,
    });
    expect(line(null, { progress: { phase: "reading", done: 0, total: 0 } })?.text).toBe(
      "Reading…",
    );
    expect(
      line(count(), { progress: { phase: "searching", done: 0, total: 0 }, stopping: true })?.text,
    ).toBe(STOPPING);
    expect(
      line(count(), { outcome: { problem: "Your plan's allowance is used up.", rejected: 0 } }),
    ).toEqual({ kind: "problem", text: "Your plan's allowance is used up.", retry: false });
    expect(line(count(), { outcome: { rejected: 2 } })).toEqual({
      kind: "problem",
      text: SOME_REJECTED,
      retry: true,
    });
    expect(
      line(count(), { outcome: { problem: "Refused.", rejected: 0, failed: true } })?.kind,
    ).toBe("problem");
  });

  it("keeps every sentence short enough for one line of the list column", () => {
    for (const text of [
      READY,
      FOUND_NOTHING,
      "3 of 40 threads fit.",
      "Reading 30 of 40 threads…",
    ]) {
      expect(text.length).toBeLessThanOrEqual(45);
    }
  });
});

describe("the prompt's run (rules 2, 3 and 9)", () => {
  it("asks for the count only after a quiet moment, and only for the text still in the bar", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery("prompt:wh", true);
    p.setQuery("prompt:what", true);
    // Typing calls nothing (rule 2).
    expect(r.calls).toEqual([]);
    t.fire();
    await tick();
    expect(r.calls).toEqual(["count prompt:what"]);
    expect(p.count()?.found).toBe(10);
    expect(p.rows()).toBeNull();
    // A query without a prompt asks nothing at all.
    p.setQuery("from:office", false);
    t.fire();
    await tick();
    expect(r.calls).toEqual(["count prompt:what"]);
    expect(p.count()).toBeNull();
  });

  it("drops a count that answers after the text changed", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    p.setQuery(`${QUERY} is:unread`, true);
    await tick();
    expect(p.count()).toBeNull();
  });

  it("shows the kept rows when everything is read already, with no run", async () => {
    const r = rig();
    const t = timers();
    r.setCount(count({ read: 10 }));
    r.setVerdicts(list([row(2, 3), row(9, 2)], { read: 10 }));
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t2", "t9"]);
    await p.run();
    expect(r.calls.some((c) => c.startsWith("run"))).toBe(false);
  });

  it("runs only with a prompt in the text", async () => {
    const r = rig();
    const p = createPromptRun(r.backend, { schedule: timers().schedule });
    p.setQuery("from:office", false);
    await p.run();
    expect(r.calls).toEqual([]);
  });

  it("shows rows as batches return, in the order given, and the end of the run", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    const run = r.holdRun();
    const done = p.run();
    await tick();
    expect(r.calls).toContain(`run ${QUERY}`);
    expect(p.progress()).toEqual({ phase: "reading", done: 0, total: 10 });
    expect(p.rows()).toEqual([]);

    r.setVerdicts(list([row(5, 2)], { read: 5 }));
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "reading",
      done: 5,
      total: 10,
      finished: false,
    });
    await tick();
    expect(p.progress()).toEqual({ phase: "reading", done: 5, total: 10 });
    // The rows are read again at most once a second while a run reads, not per batch.
    expect(p.rows()).toEqual([]);
    expect(t.pending()).toBe(1);
    t.fire();
    await tick();
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t5"]);

    r.setVerdicts(list([row(1, 3), row(5, 2)], { read: 10 }));
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "reading",
      done: 10,
      total: 10,
      finished: false,
    });
    t.fire();
    await tick();
    expect(p.rows()?.map((x) => [x.threadId, x.why])).toEqual([
      ["t1", "Reason 1."],
      ["t5", "Reason 5."],
    ]);

    run.end(result([row(1, 3), row(5, 2), row(7, 2)]));
    await done;
    expect(p.progress()).toBeNull();
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t1", "t5", "t7"]);
    expect(p.outcome()).toBeNull();
    expect(p.count()?.read).toBe(10);
  });

  it("ignores progress of another prompt and of text no longer in the bar", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    r.holdRun();
    void p.run();
    await tick();
    const reads = () => r.calls.filter((c) => c.startsWith("verdicts")).length;
    const before = reads();
    r.push({
      type: "agentPromptProgress",
      promptKey: "other",
      phase: "reading",
      done: 4,
      total: 9,
      finished: false,
    });
    await tick();
    expect(p.progress()).toEqual({ phase: "reading", done: 0, total: 10 });
    expect(reads()).toBe(before);

    // The text changed: the run is stopped, and its progress is no longer this text's.
    p.setQuery("prompt:something else", true);
    expect(r.calls.at(-1)).toBe("stop");
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "reading",
      done: 8,
      total: 10,
      finished: false,
    });
    await tick();
    expect(p.progress()).toBeNull();
    expect(p.rows()).toBeNull();
    expect(reads()).toBe(before);
  });

  it("takes the key from the start of its run when ↵ came before the count", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    r.holdRun();
    void p.run();
    await tick();
    expect(p.progress()).toEqual({ phase: "searching", done: 0, total: 0 });
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "searching",
      done: 0,
      total: 0,
      finished: false,
    });
    r.push({
      type: "agentPromptProgress",
      promptKey: "other",
      phase: "reading",
      done: 3,
      total: 9,
      finished: false,
    });
    await tick();
    expect(p.progress()).toEqual({ phase: "searching", done: 0, total: 0 });
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "reading",
      done: 0,
      total: 7,
      finished: false,
    });
    await tick();
    expect(p.progress()).toEqual({ phase: "reading", done: 0, total: 7 });
  });

  it("stops: the stop goes to the backend once, and the run's answer says what was kept", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    const run = r.holdRun();
    const done = p.run();
    await tick();
    p.stop();
    p.stop();
    expect(r.calls.filter((c) => c === "stop")).toHaveLength(1);
    expect(p.stopping()).toBe(true);
    expect(promptLine({ ...state(p) })?.text).toBe(STOPPING);
    run.end(result([row(3, 2)], { stopped: true, read: 4 }));
    await done;
    expect(p.stopping()).toBe(false);
    expect(p.progress()).toBeNull();
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t3"]);
    expect(promptLine(state(p))?.text).toBe("6 threads to read, 4 read already.");
  });

  it("says what went wrong, with Try again when some batches were not accepted", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    r.answerRun(result([], { rejected: 1, read: 6 }));
    await p.run();
    expect(promptLine(state(p))).toEqual({ kind: "problem", text: SOME_REJECTED, retry: true });

    r.answerRun(
      new BackendError("agentUnavailable", "The assistant is still working on a prompt."),
    );
    await p.run();
    expect(promptLine(state(p))).toEqual({
      kind: "problem",
      text: "The assistant is still working on a prompt.",
      retry: true,
    });
  });

  it("opens a saved view with its kept rows at once, then reads what is unread", async () => {
    const r = rig();
    const t = timers();
    r.setVerdicts(list([row(4, 3)], { read: 6 }));
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    const run = r.holdRun();
    const opened = p.open();
    await tick();
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t4"]);
    expect(r.calls).toContain(`run ${QUERY}`);
    expect(p.progress()).toEqual({ phase: "reading", done: 0, total: 4 });
    // The verdicts carried the count: no count of its own.
    t.fire();
    await tick();
    expect(r.calls.some((c) => c.startsWith("count"))).toBe(false);
    run.end(result([row(4, 3), row(8, 2)]));
    await opened;
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t4", "t8"]);
  });

  it("shows nothing of the mail filters under an opened view, before and without kept rows", async () => {
    const r = rig();
    r.setVerdicts(list([row(4, 3)], { read: 10 }));
    const p = createPromptRun(r.backend, { schedule: timers().schedule });
    p.setQuery(QUERY, true);
    const opened = p.open();
    // Before the kept rows are here: an empty list of the prompt's, not the filters' result.
    expect(p.rows()).toEqual([]);
    expect(p.opening()).toBe(true);
    await opened;
    expect(p.opening()).toBe(false);
    expect(p.rows()?.length).toBe(1);

    // A view never searched stays empty while its first search runs.
    r.setVerdicts(list([], { searched: false, found: 0 }));
    p.setQuery(`${QUERY} is:unread`, true);
    const run = r.holdRun();
    const again = p.open();
    await tick();
    expect(p.rows()).toEqual([]);
    expect(p.progress()?.phase).toBe("searching");
    run.end(result([row(8, 2)]));
    await again;
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t8"]);

    // Typed text is not a view: the mail filters' result shows until it is run (rule 2).
    p.setQuery(`${QUERY} is:starred`, true);
    expect(p.rows()).toBeNull();
  });

  it("opens a view that is all read without a run, and does nothing while AI is off", async () => {
    const r = rig();
    r.setVerdicts(list([row(4, 3)], { read: 10 }));
    const p = createPromptRun(r.backend, { schedule: timers().schedule });
    p.setQuery(QUERY, true);
    await p.open();
    expect(p.rows()?.length).toBe(1);
    expect(r.calls.some((c) => c.startsWith("run"))).toBe(false);

    r.setVerdicts(list([], { ai: "off", promptKey: "", searched: false, found: 0 }));
    p.setQuery(`${QUERY} is:unread`, true);
    await p.open();
    expect(p.rows()).toBeNull();
    expect(promptLine(state(p))).toBeNull();
  });

  it("before the first search shows the mail filters' result, then searches on ↵ with its true steps", async () => {
    const r = rig();
    const t = timers();
    r.setCount(count({ searched: false, found: 0 }));
    r.setVerdicts(list([], { searched: false, found: 0 }));
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    expect(p.rows()).toBeNull();
    expect(promptLine(state(p))?.kind).toBe("ready");
    const run = r.holdRun();
    const done = p.run();
    await tick();
    expect(r.calls).toContain(`run ${QUERY}`);
    expect(p.progress()).toEqual({ phase: "searching", done: 0, total: 0 });
    // Nothing is listed yet: the mail filters' result stays while the agent searches.
    expect(p.rows()).toBeNull();
    const reads = () => r.calls.filter((c) => c.startsWith("verdicts")).length;
    const before = reads();
    r.push({
      type: "agentPromptProgress",
      promptKey: KEY,
      phase: "searching",
      done: 0,
      total: 0,
      step: { query: "warranty receipt", threads: 7 },
      finished: false,
    });
    await tick();
    expect(promptLine(state(p))?.text).toBe("Searched: warranty receipt → 7 threads");
    // A query that ran adds no rows: nothing is read for it.
    expect(reads()).toBe(before);
    run.end(result([row(2, 3)], { found: 7, read: 7, fits: 1 }));
    await done;
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t2"]);
    expect(promptLine(state(p))).toEqual({
      kind: "allRead",
      text: "1 of 7 threads fits.",
      whole: false,
    });
  });

  it("Search again asks for a new search, even when everything is read (rule 4)", async () => {
    const r = rig();
    const t = timers();
    r.setCount(count({ read: 10, fits: 2 }));
    r.setVerdicts(list([row(2, 3), row(9, 2)], { read: 10, fits: 2 }));
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    await p.run();
    expect(r.calls.some((c) => c.startsWith("run") || c.startsWith("again"))).toBe(false);
    const run = r.holdRun();
    const done = p.searchAgain();
    await tick();
    expect(r.calls).toContain(`again ${QUERY}`);
    expect(p.progress()).toEqual({ phase: "searching", done: 0, total: 0 });
    // The rows kept stay while it searches.
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t2", "t9"]);
    run.end(result([row(4, 3)], { found: 12, read: 12, fits: 1 }));
    await done;
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t4"]);
  });

  it("opens a saved view that never searched by searching (rule 3)", async () => {
    const r = rig();
    r.setVerdicts(list([], { searched: false, found: 0 }));
    const p = createPromptRun(r.backend, { schedule: timers().schedule });
    p.setQuery(QUERY, true);
    r.answerRun(result([], { found: 0, read: 0 }));
    await p.open();
    expect(r.calls).toContain(`run ${QUERY}`);
    expect(promptLine(state(p))).toEqual({ kind: "none", text: FOUND_NOTHING });
    expect(p.rows()).toEqual([]);
  });

  it("asks before reading more than PROMPT_ASK_ABOVE, then reads them all on ↵ (rule 4)", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    // ↵ before anything is known: the search runs, and the count it found is not acknowledged.
    r.answerRun(result([], { found: 450, read: 0, ask: true }));
    await p.run();
    expect(r.readAlls).toEqual([false]);
    expect(promptLine(state(p))).toEqual({
      kind: "ask",
      text: "Found 450 threads.",
      key: READ_ALL,
    });
    // The person saw the number: the next ↵ reads all of them.
    r.answerRun(result([row(3, 2)], { found: 450, read: 450, fits: 1 }));
    await p.run();
    expect(r.readAlls).toEqual([false, true]);
    expect(promptLine(state(p))?.text).toBe("1 of 450 threads fits.");
  });

  it("opens a saved view with more than PROMPT_ASK_ABOVE unread by asking, not reading", async () => {
    const r = rig();
    r.setVerdicts(list([row(2, 3)], { found: 400, read: 150, fits: 1 }));
    const p = createPromptRun(r.backend, { schedule: timers().schedule });
    p.setQuery(QUERY, true);
    await p.open();
    expect(r.calls.some((c) => c.startsWith("run"))).toBe(false);
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t2"]);
    expect(promptLine(state(p))?.text).toBe("250 threads to read, 150 read already.");
    r.answerRun(result([row(2, 3)], { found: 400, read: 400, fits: 1 }));
    await p.run();
    expect(r.readAlls).toEqual([true]);
  });

  it("starts a new run only after the stopped one has ended", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    t.fire();
    await tick();
    const first = r.holdRun();
    void p.run();
    await tick();
    p.setQuery("prompt:another question", true);
    r.holdRun();
    void p.run();
    await tick();
    expect(r.calls.filter((c) => c.startsWith("run"))).toHaveLength(1);
    first.end(result([], { stopped: true }));
    await tick();
    expect(r.calls.filter((c) => c.startsWith("run")).at(-1)).toBe("run prompt:another question");
  });
});

const state = (p: ReturnType<typeof createPromptRun>) => ({
  count: p.count(),
  progress: p.progress(),
  stopping: p.stopping(),
  outcome: p.outcome(),
});

/** A mailbox for the list: newest first, every search answered from it. */
function mailBackend(all: readonly Message[]) {
  const searches: string[] = [];
  let hold: Promise<void> | null = null;
  const backend = {
    async listNewest({ limit }: { limit: number }) {
      return { messages: all.slice(0, limit) };
    },
    async search({ query }: { query: string }) {
      searches.push(query);
      if (hold) await hold;
      return { messages: all.filter((m) => m.subject.includes("office")) };
    },
    async getMessages(keys: readonly number[]) {
      return { messages: all.filter((m) => keys.includes(m.key)) };
    },
    async openThread(threadId: string) {
      return {
        thread: {
          id: threadId,
          accountId: "a",
          subject: "s",
          messageKeys: [],
          lastMessageKey: 0,
          labelIds: [],
          unreadCount: 0,
        },
        messages: all.filter((m) => m.threadId === threadId).map((m) => ({ ...m, bodyText: "b" })),
      };
    },
  } as unknown as Backend;
  return {
    backend,
    searches,
    holdSearches() {
      let release!: () => void;
      hold = new Promise<void>((r) => {
        release = r;
      });
      return () => {
        hold = null;
        release();
      };
    },
  };
}

describe("the list under a prompt (rules 6 and 7)", () => {
  const mail = [
    msg(9, "t9", { subject: "office 9" }),
    msg(7, "t7", { subject: "office 7" }),
    msg(5, "t5", { subject: "office 5" }),
    msg(3, "t3", { subject: "office 3" }),
  ];

  it("shows the prompt's rows in its order, keeps the selection on its thread, and no headings", async () => {
    const m = mailBackend(mail);
    const store = createMailStore(m.backend);
    store.setQuery(QUERY);
    await tick();
    expect(store.messages().map((x) => x.key)).toEqual([9, 7, 5, 3]);
    store.select(2); // t5
    await tick();
    store.showOrdered(QUERY, [msg(3, "t3"), msg(5, "t5")]);
    expect(store.ordered()).toBe(true);
    expect(store.messages().map((x) => x.key)).toEqual([3, 5]);
    expect(store.messages()[store.selected()]?.threadId).toBe("t5");
    expect(store.hasMore()).toBe(false);
    const layout = layoutList(store.messages(), Date.now(), null);
    expect(layout.items.every((i) => i.kind === "row")).toBe(true);
    // j and k walk the prompt's order.
    store.move(-1);
    expect(store.messages()[store.selected()]?.threadId).toBe("t3");
  });

  it("drops rows for text no longer in the bar, and a search answer that lands late", async () => {
    const m = mailBackend(mail);
    const store = createMailStore(m.backend);
    store.showOrdered("prompt:old", [msg(3, "t3")]);
    expect(store.ordered()).toBe(false);
    const release = m.holdSearches();
    store.setQuery(QUERY);
    store.showOrdered(QUERY, [msg(5, "t5")]);
    release();
    await tick();
    expect(store.messages().map((x) => x.key)).toEqual([5]);
  });

  it("goes back to the mail filters' result when the filters change", async () => {
    const m = mailBackend(mail);
    const store = createMailStore(m.backend);
    store.setQuery(QUERY);
    await tick();
    store.showOrdered(QUERY, [msg(3, "t3")]);
    // The same text again keeps the rows.
    store.setQuery(QUERY);
    await tick();
    expect(store.messages().map((x) => x.key)).toEqual([3]);
    store.setQuery(`${QUERY} is:unread`);
    expect(store.ordered()).toBe(false);
    await tick();
    expect(store.messages().map((x) => x.key)).toEqual([9, 7, 5, 3]);
    expect(m.searches.at(-1)).toBe(`${QUERY} is:unread`);
    // Back to the result, by the prompt's word.
    store.showOrdered(`${QUERY} is:unread`, [msg(7, "t7")]);
    store.showOrdered(`${QUERY} is:unread`, null);
    await tick();
    expect(store.ordered()).toBe(false);
    expect(store.messages().map((x) => x.key)).toEqual([9, 7, 5, 3]);
  });

  it("keeps the rows in place when mail changes under them, and lets removed ones go", async () => {
    const m = mailBackend(mail);
    const store = createMailStore(m.backend);
    store.setQuery(QUERY);
    await tick();
    store.showOrdered(QUERY, [msg(3, "t3"), msg(9, "t9"), msg(5, "t5")]);
    await store.applyChanges({ type: "changes", changeSeq: 2, changedKeys: [9], removedKeys: [5] });
    expect(store.messages().map((x) => x.key)).toEqual([3, 9]);
    expect(store.messages()[1]?.subject).toBe("office 9");
  });

  it("says so when no thread fits", () => {
    expect(NOTHING_FITS).toBe("No thread fits this prompt.");
  });
});

describe("a saved view that holds a prompt (rule 10)", () => {
  const view = (id: string, name: string, query: string, position: number): SavedView => ({
    id,
    name,
    query,
    position,
    createdMs: 1,
    updatedMs: 1,
  });

  it("counts its badge from verdicts, not its filters, and tells when it is opened (ADR 0117, rule 4)", async () => {
    const counted: string[] = [];
    const badged: string[] = [];
    const backend = {
      async listNewest() {
        return { messages: [] };
      },
      async search() {
        return { messages: [] };
      },
      async listViews() {
        return [view("a", "Decide", QUERY, 0), view("b", "Office", "from:office", 1)];
      },
      async countMatches(args: { query: string }) {
        counted.push(args.query);
        return { count: 3 };
      },
      async agentPromptBadge(query: string) {
        badged.push(query);
        return { ai: "on", unread: 2 };
      },
    } as unknown as Backend;
    const store = createMailStore(backend);
    const views = createViewsStore(backend, store, { delay: async () => {} });
    const opened: string[] = [];
    views.onOpened((v) => opened.push(v.id));
    await views.load();
    await tick(20);
    expect(counted).toEqual(["is:unread", "from:office"]);
    expect(badged).toEqual([QUERY]);
    expect(views.badge("a")).toBe("2");
    expect(views.badge("b")).toBe("3");
    views.select("a");
    expect(store.query()).toBe(QUERY);
    expect(opened).toEqual(["a"]);
    // Editing the prompt marks the view changed, as any edit does; Revert brings it back.
    store.setQuery('from:office prompt:"what is late"');
    expect(views.changed()).toBe(true);
    views.revert();
    expect(store.query()).toBe(QUERY);
    expect(views.changed()).toBe(false);
    expect(holdsPrompt(QUERY)).toBe(true);
    expect(holdsPrompt("from:office")).toBe(false);
  });
});

describe("a saved view's reading in the background (ADR 0117, rule 3)", () => {
  it("reads the rows again for the prompt shown, and takes no part in a run's progress", async () => {
    const r = rig();
    const t = timers();
    const p = createPromptRun(r.backend, { schedule: t.schedule });
    p.setQuery(QUERY, true);
    r.setVerdicts(list([row(1, 2)], { found: 1, read: 1, fits: 1, toRead: 0 }));
    await p.open();
    await tick();
    const reads = () => r.calls.filter((c) => c.startsWith("verdicts")).length;
    const before = reads();
    // Another prompt's reading is not ours.
    r.push({
      type: "agentPromptProgress",
      promptKey: "other",
      phase: "reading",
      done: 10,
      total: 10,
      finished: false,
      background: true,
    });
    t.fire();
    await tick();
    expect(reads()).toBe(before);
    // Ours: the rows are read again once, after the quiet time; no progress is shown.
    r.setVerdicts(list([row(2, 3), row(1, 2)], { found: 2, read: 2, fits: 2, toRead: 0 }));
    for (const done of [0, 3]) {
      r.push({
        type: "agentPromptProgress",
        promptKey: KEY,
        phase: "reading",
        done,
        total: 3,
        finished: done === 3,
        background: true,
      });
    }
    expect(p.progress()).toBeNull();
    t.fire();
    await tick();
    expect(reads()).toBe(before + 1);
    expect(p.rows()?.map((x) => x.threadId)).toEqual(["t2", "t1"]);
    p.dispose();
  });
});
