// The mail window takes `mailto:` links (ADR 0143, rule 5): a link leaves main's queue only once a
// composer has really opened with it. Main's queue is the real one; the composer is a stand-in.
import type { MailtoPrefill } from "@matters/contracts";
import { describe, expect, it } from "vitest";
import { createLinkQueue, MAILTO_TRIES_MAX } from "../src/main/mailtoLinks.ts";
import type { OpenOutcome } from "../src/renderer/compose.ts";
import { createLinkTaker, LINK_RETRY_MS } from "../src/renderer/mailtoTaking.ts";

const settle = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

function rig() {
  const queue = createLinkQueue();
  const opened: string[] = [];
  const timers: { run: () => void; ms: number }[] = [];
  const state = {
    /** A composer is open or opening. */
    busy: false,
    /** What an open does, once `once` is used up. */
    outcome: "opened" as OpenOutcome,
    /** What the next opens do, one each. */
    once: [] as OpenOutcome[],
    /** While set, the next take waits for it before main answers. */
    takeGate: null as Promise<void> | null,
  };
  const taker = createLinkTaker({
    take: async () => {
      const gate = state.takeGate;
      state.takeGate = null;
      if (gate !== null) await gate;
      return queue.next();
    },
    done: async (id, ok) => queue.done(id, ok),
    open: async (link: MailtoPrefill) => {
      if (state.busy) return "busy";
      const outcome = state.once.shift() ?? state.outcome;
      if (outcome === "opened") {
        state.busy = true;
        opened.push(link.to[0] ?? "");
      }
      return outcome;
    },
    busy: () => state.busy,
    later: (run, ms) => {
      const timer = { run, ms };
      timers.push(timer);
      return () => {
        const at = timers.indexOf(timer);
        if (at >= 0) timers.splice(at, 1);
      };
    },
  });
  /** The composer closes, or one that was opening by hand failed: the window asks again. */
  const free = async () => {
    state.busy = false;
    await taker.next();
    await settle();
  };
  return { queue, opened, timers, state, taker, free };
}

describe("a link leaves main only once its composer opened (ADR 0143, rule 5)", () => {
  it("a composer started by hand while the link was asked for keeps the link, which opens after", async () => {
    const r = rig();
    r.queue.offer("mailto:anna@example.org");
    let answer: () => void = () => {};
    r.state.takeGate = new Promise((resolve) => {
      answer = resolve;
    });
    const taking = r.taker.next();
    // The person presses `c` while main's answer is on its way.
    r.state.busy = true;
    answer();
    await taking;
    expect(r.opened).toEqual([]);
    expect(r.queue.size()).toBe(1);
    // That composer closes: the link opens, and only now leaves the queue.
    await r.free();
    expect(r.opened).toEqual(["anna@example.org"]);
    expect(r.queue.size()).toBe(0);
  });

  it("a composer started by hand that fails to open lets the link open", async () => {
    const r = rig();
    r.queue.offer("mailto:anna@example.org");
    r.state.busy = true;
    await r.taker.next();
    expect(r.opened).toEqual([]);
    // It never opened, so nothing closes: its failure is what frees the window.
    await r.free();
    expect(r.opened).toEqual(["anna@example.org"]);
  });

  it("a link whose composer could not be prepared stays, and is tried again", async () => {
    const r = rig();
    r.queue.offer("mailto:anna@example.org");
    r.state.outcome = "failed";
    await r.taker.next();
    expect(r.queue.size()).toBe(1);
    expect(r.timers.map((t) => t.ms)).toEqual([LINK_RETRY_MS]);
    // The backend answers again: the retry opens it.
    r.state.outcome = "opened";
    r.timers.shift()?.run();
    await settle();
    expect(r.opened).toEqual(["anna@example.org"]);
    expect(r.queue.size()).toBe(0);
  });

  it("a link that can never open is dropped after so many tries, and the next one opens", async () => {
    const r = rig();
    r.queue.offer("mailto:never@example.org");
    r.queue.offer("mailto:next@example.org");
    r.state.outcome = "failed";
    await r.taker.next();
    for (let i = 1; i < MAILTO_TRIES_MAX; i++) {
      r.timers.shift()?.run();
      await settle();
    }
    expect(r.queue.size()).toBe(1);
    r.state.outcome = "opened";
    r.timers.shift()?.run();
    await settle();
    expect(r.opened).toEqual(["next@example.org"]);
    expect(r.timers).toEqual([]);
  });

  it("a link that arrives while another is being opened is heard once that attempt ends", async () => {
    const r = rig();
    r.queue.offer("mailto:first@example.org");
    // The first try fails; the one after opens.
    r.state.once = ["failed"];
    let answer: () => void = () => {};
    r.state.takeGate = new Promise((resolve) => {
      answer = resolve;
    });
    const taking = r.taker.next();
    // Main says another came while the first is asked for.
    r.queue.offer("mailto:second@example.org");
    void r.taker.next();
    answer();
    await taking;
    await settle();
    // What main said is not lost: the window asks again at once, with no wait for the retry.
    expect(r.opened).toEqual(["first@example.org"]);
    expect(r.timers).toEqual([]);
    await r.free();
    expect(r.opened).toEqual(["first@example.org", "second@example.org"]);
    expect(r.queue.size()).toBe(0);
  });
});
