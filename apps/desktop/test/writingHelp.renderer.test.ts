// The agent's help while writing (ADR 0098, 0132): what it asks, and what it does with the answer.
import type { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComposerSession } from "../src/renderer/compose.ts";
import type { ReplyAgent, ThreadHelp } from "../src/renderer/replyAgent.ts";
import { CHANGED_TEXT, createAgentHelp } from "../src/renderer/writingHelp.ts";

/** Just enough of the editor: the text, and the changes the help makes to it. */
function editor(start: string) {
  let doc = start;
  const view = {
    state: {
      get doc() {
        return { toString: () => doc, length: doc.length };
      },
    },
    dispatch: (tr: { changes?: { insert: string } }) => {
      if (tr.changes) doc = tr.changes.insert;
    },
    focus: () => {},
  };
  return { view: view as unknown as EditorView, text: () => doc };
}

function agentFor(thread: boolean) {
  const calls: string[] = [];
  const help: ThreadHelp = {
    answer: async (text) => {
      calls.push("answer");
      return text;
    },
    check: async () => {
      calls.push("check");
      return { asked: 0, answered: 0, missing: [] };
    },
    fill: async () => {
      calls.push("fill");
      return [];
    },
  };
  const write = vi.fn(async (words: string, text: string) =>
    words === "nothing" ? text : `${text}\n\nAbout ${words}: [date].`,
  );
  const agent: ReplyAgent = {
    rewrite: async (_kind, text) => text,
    write,
    ...(thread ? { thread: help } : {}),
  };
  return { agent, calls, write };
}

function setup(start: string, thread: boolean) {
  const e = editor(start);
  const a = agentFor(thread);
  const help = createAgentHelp({
    session: () => ({}) as ComposerSession,
    view: () => e.view,
    agent: () => a.agent,
  });
  return { ...e, ...a, help };
}

const LONG = "Hello team, this is long enough to be checked, and it has a [date] in it.";

describe("the agent's help for a new message (ADR 0132)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has no check, no answers and no placeholders filled: there is no thread", async () => {
    const h = setup(LONG, false);
    expect(h.help.available()).toBe(true);
    expect(h.help.hasThread()).toBe(false);
    h.help.start(LONG);
    h.help.bodyChanged(`${LONG} More.`);
    await vi.advanceTimersByTimeAsync(5000);
    await h.help.run("answer");
    await h.help.run("fill");
    expect(h.calls).toEqual([]);
    expect(h.help.check()).toBeNull();
    expect(h.text()).toBe(LONG);
  });

  it("writes as the person asked, and offers Keep and Undo", async () => {
    const h = setup("Hi,", false);
    await h.help.run("write", "the review");
    expect(h.write).toHaveBeenCalledWith("the review", "Hi,");
    expect(h.text()).toBe("Hi,\n\nAbout the review: [date].");
    expect(h.help.note()).toEqual({
      text: "The agent wrote it as you asked.",
      before: "Hi,",
      changed: true,
    });
    expect(h.help.busy()).toBeNull();
    expect(h.help.words()).toBe("");
    h.help.undo();
    expect(h.text()).toBe("Hi,");
  });

  it("says when it changed nothing, and asks nothing for empty words", async () => {
    const h = setup("Hi,", false);
    await h.help.run("write", "   ");
    expect(h.write).not.toHaveBeenCalled();
    await h.help.run("write", "nothing");
    expect(h.help.note()).toMatchObject({ text: "The agent changed nothing.", changed: false });
  });

  it("keeps the words for another try when the turn fails", async () => {
    const h = setup("Hi,", false);
    h.write.mockRejectedValueOnce(new Error("The assistant could not write this. Try again."));
    await h.help.run("write", "the price");
    expect(h.help.problem()).toBe("The assistant could not write this. Try again.");
    expect(h.help.words()).toBe("the price");
    expect(h.text()).toBe("Hi,");
  });
});

describe("the agent's help for a reply", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("fills placeholders at the start and checks a moment after the writer stops", async () => {
    const h = setup(LONG, true);
    expect(h.help.hasThread()).toBe(true);
    h.help.start(LONG);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toEqual(["fill"]);
    h.help.bodyChanged(LONG);
    await vi.advanceTimersByTimeAsync(1500);
    expect(h.calls).toEqual(["fill", "check"]);
  });

  it("leaves the text alone when the writer typed while the agent worked", async () => {
    const h = setup("Hi,", false);
    h.write.mockImplementationOnce(async (words, text) => {
      // The editor stays open during the turn: the writer goes on.
      h.view.dispatch({ changes: { from: 0, to: 3, insert: "Hi, Anna," } });
      return `${text}\n\nAbout ${words}: [date].`;
    });
    await h.help.run("write", "the price");
    expect(h.text()).toBe("Hi, Anna,");
    expect(h.help.note()).toBeNull();
    expect(h.help.problem()).toBe(CHANGED_TEXT);
    // The words are kept, so the same can be asked of the text as it is now.
    expect(h.help.words()).toBe("the price");
    expect(h.help.busy()).toBeNull();
  });
});
