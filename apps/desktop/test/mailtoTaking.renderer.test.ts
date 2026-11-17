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
    /** While set, the next open, or the next answer about a link, waits for it. */
    openGate: null as Promise<void> | null,
    doneGate: null as Promise<void> | null,
  };
  const taker = createLinkTaker({
    take: async () => {
      const gate = state.takeGate;
      state.takeGate = null;
      if (gate !== null) await gate;
      return queue.next();
    },
    done: async (id, ok) => {
      const gate = state.doneGate;
      state.doneGate = null;
      if (gate !== null) await gate;
      return queue.done(id, ok);
    },
    open: async (link: MailtoPrefill) => {
      const gate = state.openGate;
      state.openGate = null;
      if (gate !== null) await gate;
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
    expect(r.opened).toEqual(["first@example.org"]);
    // What main said is not lost: the window asks again once the first composer closes.
    await r.free();
    expect(r.opened).toEqual(["first@example.org", "second@example.org"]);
    expect(r.queue.size()).toBe(0);
  });

  it("a failed link is tried again only after the wait, whatever happens meanwhile", async () => {
    const r = rig();
    r.queue.offer("mailto:first@example.org");
    r.state.outcome = "failed";
    let answer: () => void = () => {};
    r.state.takeGate = new Promise((resolve) => {
      answer = resolve;
    });
    const taking = r.taker.next();
    // The failed open frees the window while the attempt is still under way, and another link
    // comes: neither starts a try at once.
    void r.taker.next();
    r.queue.offer("mailto:second@example.org");
    void r.taker.next();
    answer();
    await taking;
    await settle();
    expect(r.timers.map((t) => t.ms)).toEqual([LINK_RETRY_MS]);
    // Nor does anything that happens during the wait.
    await r.taker.next();
    await settle();
    expect(r.timers.length).toBe(1);
    expect(r.opened).toEqual([]);
    // One try was used, not all of them: the link is still there when the wait is over.
    r.state.outcome = "opened";
    r.timers.shift()?.run();
    await settle();
    expect(r.opened).toEqual(["first@example.org"]);
    await r.free();
    expect(r.opened).toEqual(["first@example.org", "second@example.org"]);
  });

  it("a retry that comes due while a composer is open leaves the link for when it closes", async () => {
    const r = rig();
    r.queue.offer("mailto:anna@example.org");
    r.state.once = ["failed"];
    await r.taker.next();
    r.state.busy = true;
    r.timers.shift()?.run();
    await settle();
    expect(r.opened).toEqual([]);
    await r.free();
    expect(r.opened).toEqual(["anna@example.org"]);
  });

  it("a window that went starts nothing more: no open, no retry", async () => {
    const r = rig();
    r.queue.offer("mailto:anna@example.org");
    let answer: () => void = () => {};
    r.state.takeGate = new Promise((resolve) => {
      answer = resolve;
    });
    const taking = r.taker.next();
    r.taker.stop();
    answer();
    await taking;
    await settle();
    expect(r.opened).toEqual([]);
    expect(r.queue.size()).toBe(1);

    // Stopped while the composer was being prepared, which then fails: no retry is scheduled.
    const s = rig();
    s.queue.offer("mailto:anna@example.org");
    s.state.outcome = "failed";
    const failing = s.taker.next();
    s.taker.stop();
    await failing;
    await settle();
    expect(s.timers).toEqual([]);
    await s.taker.next();
    await settle();
    expect(s.opened).toEqual([]);
  });

  for (const during of ["openGate", "doneGate"] as const) {
    it(`a window that went while ${during === "openGate" ? "the composer was being prepared" : "main was told how it went"} schedules no retry`, async () => {
      const r = rig();
      r.queue.offer("mailto:anna@example.org");
      r.queue.offer("mailto:next@example.org");
      r.state.outcome = "failed";
      let answer: () => void = () => {};
      r.state[during] = new Promise((resolve) => {
        answer = resolve;
      });
      const taking = r.taker.next();
      // Main answered with the link, and the step after it is under way.
      await settle();
      // Something else came meanwhile, and then the window went.
      void r.taker.next();
      r.taker.stop();
      answer();
      await taking;
      await settle();
      expect(r.timers).toEqual([]);
      expect(r.opened).toEqual([]);
      // Main still has both: the failed one with one try used, and the one behind it.
      expect(r.queue.size()).toBe(2);
    });
  }
});
