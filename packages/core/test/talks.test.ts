import { describe, expect, it } from "vitest";
import {
  buildTalkTitleRequest,
  cutTitle,
  MAX_TALK_TITLE_CHARS,
  parseTalkTitleAnswer,
  splitByPause,
  startsNewTalk,
  TALK_PAUSE_MS,
  TALK_TITLE_INSTRUCTIONS,
  talkGroup,
  talkTitle,
} from "../src/index.ts";

// ADR 0086: talks across all mail.

describe("cutTitle", () => {
  it("keeps a short title, folding its white space", () => {
    expect(cutTitle("  Job   change\nat Acme ")).toBe("Job change at Acme");
  });

  it("cuts a long one at a word boundary, with an ellipsis, never over the limit", () => {
    const long = "find every mail about my job change in the last two years and the contract";
    const cut = cutTitle(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_TALK_TITLE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
    expect(long.startsWith(cut.slice(0, -1))).toBe(true);
    expect(cut.slice(0, -1).endsWith(" ")).toBe(false);
  });

  it("cuts one very long word where it has to", () => {
    const cut = cutTitle("x".repeat(100));
    expect(cut).toHaveLength(MAX_TALK_TITLE_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("talkTitle", () => {
  it("prefers the given name, then the first question, then New talk", () => {
    expect(talkTitle({ title: "Job change", firstWords: "find the mail" })).toBe("Job change");
    expect(talkTitle({ firstWords: "find the mail" })).toBe("find the mail");
    expect(talkTitle({ title: "  ", firstWords: "" })).toBe("New talk");
  });
});

describe("startsNewTalk (rule 4)", () => {
  const now = 10 * TALK_PAUSE_MS;
  it("starts one when none is open", () => {
    expect(startsNewTalk(null, now, false)).toBe(true);
  });
  it("continues an empty talk, a recent one, and one chosen from the list", () => {
    expect(startsNewTalk({ lastAtMs: 0, entries: 0 }, now, false)).toBe(false);
    expect(startsNewTalk({ lastAtMs: now - TALK_PAUSE_MS, entries: 2 }, now, false)).toBe(false);
    expect(startsNewTalk({ lastAtMs: 0, entries: 2 }, now, true)).toBe(false);
  });
  it("starts one after the pause", () => {
    expect(startsNewTalk({ lastAtMs: now - TALK_PAUSE_MS - 1, entries: 2 }, now, false)).toBe(true);
  });
});

describe("splitByPause (rule 15)", () => {
  it("numbers the talks, starting a new one only after more than the pause", () => {
    expect(splitByPause([])).toEqual([]);
    expect(splitByPause([0, TALK_PAUSE_MS, 2 * TALK_PAUSE_MS + 1, 2 * TALK_PAUSE_MS + 5])).toEqual([
      0, 0, 1, 1,
    ]);
  });
});

describe("talkGroup (rule 5)", () => {
  const now = new Date(2026, 10, 9, 15, 0).getTime();
  const at = (day: number, hour = 12) => new Date(2026, 10, day, hour).getTime();
  it("groups by the local day", () => {
    expect(talkGroup(at(9, 0), now)).toBe("today");
    expect(talkGroup(at(8, 23), now)).toBe("yesterday");
    expect(talkGroup(at(8, 0), now)).toBe("yesterday");
    expect(talkGroup(at(7), now)).toBe("week");
    expect(talkGroup(at(3), now)).toBe("week");
    expect(talkGroup(at(2), now)).toBe("earlier");
  });
});

describe("the title turn (rule 6)", () => {
  it("sends the first three questions only, as untrusted text", () => {
    const request = buildTalkTitleRequest(["one", "two\nlines", "three", "four"]);
    expect(request.untrusted).toBe("The person asked:\n1. one\n2. two lines\n3. three");
    expect(request.instructions).toBe(TALK_TITLE_INSTRUCTIONS);
    expect(request.instructions).not.toContain("one");
  });

  it("accepts a short name, folded and without quotes or a full stop", () => {
    expect(parseTalkTitleAnswer({ title: "  “Job change at Acme.”  " })).toBe("Job change at Acme");
    expect(parseTalkTitleAnswer({ title: "Zmiana pracy" })).toBe("Zmiana pracy");
  });

  it("refuses anything else", () => {
    for (const bad of [
      null,
      "Job change",
      [],
      {},
      { title: "" },
      { title: "   " },
      { title: 3 },
      { title: "Job", extra: 1 },
      { title: "two\nlines" },
      { title: "one two three four five six seven eight nine" },
      { title: "x".repeat(81) },
    ]) {
      expect(parseTalkTitleAnswer(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});
