import { describe, expect, it } from "vitest";
import { type AutoRead, createAutoRead, DWELL_MS } from "../src/renderer/autoRead.ts";
import { plainKey } from "../src/renderer/keys.ts";
import { letterKeys, sameKeys } from "../src/renderer/threadLetters.ts";

/** A clock the test turns by hand. */
function rig(dwellMs?: number) {
  let now = 0;
  let seq = 0;
  let timers: { id: number; at: number; run: () => void }[] = [];
  const fired: string[] = [];
  const counting: (string | null)[] = [];
  let created = 0;
  const auto: AutoRead = createAutoRead({
    ...(dwellMs === undefined ? {} : { dwellMs }),
    setTimeout: (run, ms) => {
      const id = ++seq;
      created++;
      timers.push({ id, at: now + ms, run });
      return () => {
        timers = timers.filter((t) => t.id !== id);
      };
    },
    onDwell: (thread) => fired.push(thread),
    onCounting: (thread) => counting.push(thread),
  });
  return {
    auto,
    fired,
    counting,
    created: () => created,
    waiting: () => timers.length,
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        timers = timers.filter((t) => t !== next);
        now = next.at;
        next.run();
      }
      now = end;
    },
  };
}

describe("autoRead: what the list is told to draw while it counts", () => {
  it("names the thread for the length of the countdown, and clears after the mail is read", () => {
    const r = rig();
    r.auto.chose("A");
    expect(r.counting).toEqual(["A"]);
    r.advance(1499);
    expect(r.counting).toEqual(["A"]);
    r.advance(1);
    expect(r.fired).toEqual(["A"]);
    expect(r.counting).toEqual(["A", null]);
  });

  it("clears when the reader leaves, marks it themselves or loses the window", () => {
    const r = rig();
    r.auto.chose("A");
    r.auto.chose("B");
    expect(r.counting).toEqual(["A", null, "B"]);
    r.auto.settled("B");
    expect(r.counting).toEqual(["A", null, "B", null]);

    r.auto.chose("C");
    r.auto.focus(false);
    expect(r.counting.slice(-2)).toEqual(["C", null]);
    r.auto.focus(true);
    expect(r.counting.at(-1)).toBe("C");
  });

  it("says nothing for what the app selected, or with no countdown to stop", () => {
    const r = rig();
    r.auto.displaced("A");
    r.auto.settled("A");
    r.auto.focus(false);
    r.auto.focus(true);
    expect(r.counting).toEqual([]);
  });

  it("has the mail read before it clears, so the dot never shows whole in between", () => {
    const order: string[] = [];
    let fire = () => {};
    const auto = createAutoRead({
      setTimeout: (run) => {
        fire = run;
        return () => {};
      },
      onDwell: () => order.push("read"),
      onCounting: (thread) => order.push(thread ?? "cleared"),
    });
    auto.chose("A");
    fire();
    expect(order).toEqual(["A", "read", "cleared"]);
  });
});

describe("autoRead: when a thread becomes read (ADR 0039)", () => {
  it("reads a thread the reader chose after it stayed selected for 1500 ms", () => {
    const r = rig();
    expect(DWELL_MS).toBe(1500);
    r.auto.chose("A");
    r.advance(1499);
    expect(r.fired).toEqual([]);
    r.advance(1);
    expect(r.fired).toEqual(["A"]);
    // Once only.
    r.advance(60_000);
    expect(r.fired).toEqual(["A"]);
  });

  it("changes nothing for threads passed faster than that with j/k", () => {
    const r = rig();
    for (const t of ["A", "B", "C", "D"]) {
      r.auto.chose(t);
      r.advance(300);
    }
    expect(r.fired).toEqual([]);
    expect(r.waiting()).toBe(1);
    r.advance(1200);
    expect(r.fired).toEqual(["D"]);
  });

  it("never counts for a selection the app made: launch, a view, a refresh", () => {
    const r = rig();
    // The first row opens by itself at start, again for a view, again when its row went away.
    r.auto.displaced("A");
    r.advance(10_000);
    r.auto.displaced("B");
    r.advance(10_000);
    r.auto.displaced(null);
    r.advance(10_000);
    expect(r.fired).toEqual([]);
    expect(r.created()).toBe(0);
  });

  it("stops a countdown when the app moves the selection under it", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1000);
    r.auto.displaced("B");
    r.advance(10_000);
    expect(r.fired).toEqual([]);
  });

  it("does not start over when the selection lands on the thread it is already on", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1000);
    // A refresh re-selects: another row of the same thread, or the same one again.
    r.auto.displaced("A");
    r.auto.chose("A");
    r.advance(500);
    expect(r.fired).toEqual(["A"]);
    expect(r.created()).toBe(1);
  });

  it("makes a thread the app opened the reader's when they click it", () => {
    const r = rig();
    r.auto.displaced("A");
    r.advance(5000);
    r.auto.chose("A");
    r.advance(1500);
    expect(r.fired).toEqual(["A"]);
  });

  it("counts only while the window has focus: blur cancels, focus starts it over", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1000);
    r.auto.focus(false);
    r.advance(10_000);
    expect(r.fired).toEqual([]);
    r.auto.focus(true);
    r.advance(1499);
    expect(r.fired).toEqual([]);
    r.advance(1);
    expect(r.fired).toEqual(["A"]);
  });

  it("does not count a choice made while the window is behind, until it is in front", () => {
    const r = rig();
    r.auto.focus(false);
    r.auto.chose("A");
    r.advance(10_000);
    expect(r.fired).toEqual([]);
    r.auto.focus(true);
    r.advance(1500);
    expect(r.fired).toEqual(["A"]);
  });

  it("does not start a countdown on focus for a selection the app made", () => {
    const r = rig();
    r.auto.displaced("A");
    r.auto.focus(false);
    r.auto.focus(true);
    r.advance(10_000);
    expect(r.fired).toEqual([]);
  });

  it("does not restart the countdown on a repeated focus event", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1000);
    r.auto.focus(true);
    r.advance(500);
    expect(r.fired).toEqual(["A"]);
  });

  it("does not read a thread again after it was read, or after the reader marked it", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1500);
    // A message arrives in the open thread: it stays unread until the thread is chosen again.
    r.auto.displaced("A");
    r.auto.chose("A");
    r.advance(60_000);
    expect(r.fired).toEqual(["A"]);
    r.auto.chose("B");
    r.auto.chose("A");
    r.advance(1500);
    expect(r.fired).toEqual(["A", "A"]);
  });

  it("cancels the countdown when the reader marks the thread, and does not re-mark it", () => {
    const r = rig();
    r.auto.chose("A");
    r.advance(1000);
    r.auto.settled("A");
    r.advance(10_000);
    expect(r.fired).toEqual([]);

    // Clicking the same row again is not choosing it again; coming back is.
    r.auto.chose("A");
    r.advance(10_000);
    expect(r.fired).toEqual([]);
    r.auto.focus(false);
    r.auto.focus(true);
    r.advance(10_000);
    expect(r.fired).toEqual([]);
    r.auto.chose("B");
    r.auto.chose("A");
    r.advance(1500);
    expect(r.fired).toEqual(["A"]);
  });

  it("ignores a mark on a thread that is not the selected one", () => {
    const r = rig();
    r.auto.chose("A");
    r.auto.settled("Z");
    r.advance(1500);
    expect(r.fired).toEqual(["A"]);
  });

  it("dispose cancels the timer", () => {
    const r = rig();
    r.auto.chose("A");
    r.auto.dispose();
    r.advance(10_000);
    expect(r.fired).toEqual([]);
  });
});

describe("plainKey: the guards of the single-key shortcuts", () => {
  const press = (over: Partial<Parameters<typeof plainKey>[0]> = {}) => ({
    key: "u",
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...over,
  });
  const place = (over: Partial<Parameters<typeof plainKey>[1]> = {}) => ({
    composeOpen: false,
    inSearch: false,
    textTarget: false,
    ...over,
  });

  it("lets a plain key through from the list and from the reader", () => {
    expect(plainKey(press(), place())).toBe("u");
    expect(plainKey(press({ key: "j" }), place())).toBe("j");
  });

  it("holds it back in text fields, the query bar and the composer", () => {
    expect(plainKey(press(), place({ textTarget: true }))).toBeNull();
    expect(plainKey(press(), place({ inSearch: true }))).toBeNull();
    expect(plainKey(press(), place({ composeOpen: true }))).toBeNull();
  });

  it("holds it back with a modifier or while an input method composes", () => {
    expect(plainKey(press({ metaKey: true }), place())).toBeNull();
    expect(plainKey(press({ ctrlKey: true }), place())).toBeNull();
    expect(plainKey(press({ altKey: true }), place())).toBeNull();
    expect(plainKey(press({ isComposing: true }), place())).toBeNull();
  });
});

describe("letterKeys: what keeps an open thread from reloading", () => {
  const message = (key: number, seen: boolean) =>
    ({ key, flags: { seen, flagged: false, answered: false, draft: false } }) as never;

  it("is the same list of keys when only a flag moves, so no letter is made again", () => {
    const before = letterKeys([message(1, false), message(2, false), message(3, true)]);
    const after = letterKeys([message(1, true), message(2, true), message(3, true)]);
    expect(sameKeys(before, after)).toBe(true);
  });

  it("changes when a message arrives or leaves", () => {
    const before = letterKeys([message(1, true), message(2, true)]);
    expect(
      sameKeys(before, letterKeys([message(1, true), message(2, true), message(3, false)])),
    ).toBe(false);
    expect(sameKeys(before, letterKeys([message(2, true)]))).toBe(false);
    expect(sameKeys([1, 2], [2, 1])).toBe(false);
  });
});
