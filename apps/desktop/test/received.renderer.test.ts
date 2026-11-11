import type { BackendEvent, ReceivedAnswer } from "@matters/contracts";
import type { ReceivedAttachment } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { createProgressSink } from "../src/renderer/progress.ts";
import { createReceivedController, type ReceivedAsk } from "../src/renderer/received.ts";
import {
  announcement,
  canOpen,
  chipLabel,
  chipSpeech,
  drawsRing,
  foldLabel,
  progressText,
  RETRY_TEXT,
  RING_FROM_BYTES,
  RUNNABLE_NOTE,
  ringFraction,
  saveAllNote,
  settle,
  splitName,
  VISIBLE_FILES,
  visibleFiles,
} from "../src/renderer/receivedStrip.ts";

describe("splitName: middle truncation that keeps the end (ADR 0043, rule 15)", () => {
  it("leaves a short name whole", () => {
    expect(splitName("a.pdf")).toEqual({ head: "a.pdf", tail: "" });
    expect(splitName("Faktura.pdf")).toEqual({ head: "Faktura.pdf", tail: "" });
    expect(splitName("12345678901234")).toEqual({ head: "12345678901234", tail: "" });
  });

  it("keeps the extension and four characters before it", () => {
    expect(splitName("Faktura FV 2026-10-0417.pdf")).toEqual({
      head: "Faktura FV 2026-10-",
      tail: "0417.pdf",
    });
  });

  it("always joins back into the name", () => {
    for (const name of [
      "Zestawienie kosztów projektu budowlanego etap drugi (poprawione 28.10.2026).xlsx",
      "archive.tar.gz.backup.2026.zip",
      "bez rozszerzenia i bardzo długa nazwa pliku",
      "😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀😀.png",
      "a.b",
      "",
    ]) {
      const { head, tail } = splitName(name);
      expect(head + tail).toBe(name);
    }
  });

  it("keeps a long extension whole, up to a point", () => {
    expect(splitName("Zestawienie kosztów projektu.xlsx").tail).toBe("ektu.xlsx");
    expect(splitName("very long file name here.numbers").tail.endsWith(".numbers")).toBe(true);
  });

  it("does not call a long tail an extension: it keeps the last few characters", () => {
    const name = "name with a dot.and-then-a-long-ending-of-text";
    const { head, tail } = splitName(name);
    expect(tail).toBe("f-text");
    expect(head + tail).toBe(name);
  });

  it("keeps the last characters of a name with no extension", () => {
    const { head, tail } = splitName("bez rozszerzenia i bardzo długa nazwa");
    expect(tail).toHaveLength(6);
    expect(head + tail).toBe("bez rozszerzenia i bardzo długa nazwa");
  });

  it("does not cut inside a character made of two code units", () => {
    const name = `${"😀".repeat(12)}.png`;
    const { head, tail } = splitName(name);
    for (const piece of [head, tail]) {
      expect(() => encodeURIComponent(piece)).not.toThrow();
    }
    expect(tail.endsWith(".png")).toBe(true);
  });

  it("does not leave an accent behind on its own", () => {
    // "ó" written as o + combining acute right at the cut.
    const name = `${"abcdefghij"}ó${"klm"}.pdf`;
    const { head, tail } = splitName(name);
    expect(tail.startsWith("́")).toBe(false);
    expect(head + tail).toBe(name);
  });

  it("gives the head at least one character", () => {
    expect(splitName("x.verylongextension").head.length).toBeGreaterThan(0);
    expect(splitName(".gitignore-and-more-stuff").head.length).toBeGreaterThan(0);
  });
});

describe("progress words and ring (rule 17)", () => {
  it("says 14 of 34 MB with one unit, as Finder counts", () => {
    expect(progressText(14_000_000, 34_000_000)).toBe("14 of 34 MB");
    expect(progressText(1_500_000, 3_400_000)).toBe("1.5 of 3.4 MB");
    expect(progressText(0, 34_000_000)).toBe("0 of 34 MB");
    expect(progressText(34_000_000, 34_000_000)).toBe("34 of 34 MB");
  });

  it("counts in the unit of the whole", () => {
    expect(progressText(400, 2000)).toBe("0.4 of 2 KB");
    expect(progressText(500_000_000, 2_000_000_000)).toBe("0.5 of 2 GB");
    expect(progressText(10, 500)).toBe("10 of 500 B");
  });

  it("never says more than the whole", () => {
    expect(progressText(40_000_000, 34_000_000)).toBe("34 of 34 MB");
  });

  it("draws the ring from 1 MiB and not under it", () => {
    expect(drawsRing(RING_FROM_BYTES - 1)).toBe(false);
    expect(drawsRing(RING_FROM_BYTES)).toBe(true);
    expect(drawsRing(0)).toBe(false);
    expect(RING_FROM_BYTES).toBe(1_048_576);
  });

  it("fills with the true fraction, clamped", () => {
    expect(ringFraction(25, 100, false)).toBe(0.25);
    expect(ringFraction(0, 100, false)).toBe(0);
    expect(ringFraction(150, 100, false)).toBe(1);
    expect(ringFraction(5, 0, false)).toBe(0);
    expect(ringFraction(-5, 100, false)).toBe(0);
  });

  it("steps by quarters with reduced motion", () => {
    expect(ringFraction(10, 100, true)).toBe(0);
    expect(ringFraction(26, 100, true)).toBe(0.25);
    expect(ringFraction(74, 100, true)).toBe(0.5);
    expect(ringFraction(99, 100, true)).toBe(0.75);
    expect(ringFraction(100, 100, true)).toBe(1);
  });
});

describe("state to label (rule 17)", () => {
  it("shows the size when the file is not here yet and when it is", () => {
    expect(chipLabel("idle", 212_000)).toEqual({ text: "212 KB", tone: "plain" });
    expect(chipLabel("idle", 34_000_000)).toEqual({ text: "34 MB", tone: "plain" });
  });

  it("shows the bytes while downloading a file with a ring, the size for a small one", () => {
    expect(chipLabel("downloading", 34_000_000)).toEqual({ text: "0 of 34 MB", tone: "plain" });
    expect(chipLabel("downloading", 212_000)).toEqual({ text: "212 KB", tone: "plain" });
  });

  it("says it could not be downloaded, in the late tone, offline or not", () => {
    for (const phase of ["offline", "failed"] as const) {
      expect(chipLabel(phase, 1000)).toEqual({ text: "Couldn’t download", tone: "late" });
    }
    expect(RETRY_TEXT).toBe("Try again");
  });

  it("says a file is no longer on the server, quietly", () => {
    expect(chipLabel("gone", 1000)).toEqual({ text: "No longer on the server", tone: "plain" });
  });
});

describe("what a screen reader hears (rule 16)", () => {
  it("names the file, its size and where it stands, never a percentage", () => {
    expect(chipSpeech("Faktura.pdf", 212_000, "idle", false)).toBe("Faktura.pdf, 212 KB");
    expect(chipSpeech("Plan.zip", 34_000_000, "downloading", false)).toBe(
      "Plan.zip, 34 MB, downloading",
    );
    expect(chipSpeech("Plan.zip", 34_000_000, "offline", false)).toContain("Press to try again");
    expect(chipSpeech("a.pdf", 1000, "gone", false)).toBe("a.pdf, 1 KB, no longer on the server");
    for (const phase of ["idle", "downloading", "offline", "failed", "gone"] as const) {
      expect(chipSpeech("a.pdf", 5_000_000, phase, false)).not.toMatch(/%|percent|\d+ of \d+/);
    }
  });

  it("says a file that can run programs can be saved and not opened", () => {
    expect(chipSpeech("a.command", 1000, "idle", true)).toMatch(
      /can run programs.*saved but not opened/,
    );
  });

  it("announces a change of state and nothing for none", () => {
    expect(announcement("a.pdf", "idle", "downloading")).toBe("Downloading a.pdf");
    expect(announcement("a.pdf", "downloading", "offline")).toMatch(/offline/);
    expect(announcement("a.pdf", "downloading", "failed")).toBe("Couldn’t download a.pdf.");
    expect(announcement("a.pdf", "downloading", "gone")).toBe("a.pdf is no longer on the server.");
    expect(announcement("a.pdf", "downloading", "idle")).toBeNull();
    expect(announcement("a.pdf", "downloading", "downloading")).toBeNull();
    expect(announcement("a.pdf", "idle", "idle")).toBeNull();
  });
});

describe("what an answer does to a chip", () => {
  const answer = (a: ReceivedAnswer, name = "a.pdf") => settle(a, name);

  it("makes the file here after it was opened, previewed or saved", () => {
    for (const kind of ["opened", "previewed"] as const) {
      expect(answer({ kind })).toEqual({ phase: "idle", here: true, note: null });
    }
    expect(answer({ kind: "saved", count: 1, skipped: 0 })).toMatchObject({ here: true });
  });

  it("changes nothing for a cancelled dialog", () => {
    expect(answer({ kind: "cancelled" })).toEqual({ phase: "idle", here: false, note: null });
  });

  it("takes the download's outcomes at their word", () => {
    expect(answer({ kind: "gone" }).phase).toBe("gone");
    expect(answer({ kind: "offline" }).phase).toBe("offline");
    expect(answer({ kind: "failed" }).phase).toBe("failed");
  });

  it("explains a refusal to open a program, and a mark that could not be set", () => {
    expect(answer({ kind: "refused", reason: "runnable" }).note?.text).toBe(RUNNABLE_NOTE);
    const quarantine = answer({ kind: "refused", reason: "quarantine" }, "Zażółć.pdf");
    expect(quarantine.note).toEqual({
      text: "Couldn’t open Zażółć.pdf safely. Save it instead.",
      tone: "late",
    });
    expect(answer({ kind: "refused", reason: "unsupported" }).note?.text).toMatch(/macOS/);
    expect(answer({ kind: "refused", reason: "invalid" }).phase).toBe("failed");
  });

  it("has the one line under a file that runs programs", () => {
    expect(RUNNABLE_NOTE).toBe("This kind of file can run programs, so Matters doesn’t open it.");
    expect(canOpen("a.pdf")).toBe(true);
    expect(canOpen("a.command")).toBe(false);
    expect(canOpen("a.pdf.exe")).toBe(false);
  });
});

describe("the fold and Save all (rule 15)", () => {
  it("shows up to five files and folds the rest behind a count", () => {
    expect(VISIBLE_FILES).toBe(5);
    expect(visibleFiles(1, false)).toBe(1);
    expect(visibleFiles(5, false)).toBe(5);
    expect(visibleFiles(6, false)).toBe(5);
    expect(visibleFiles(17, false)).toBe(5);
    expect(foldLabel(12)).toBe("12 more");
    expect(foldLabel(1)).toBe("1 more");
  });

  it("shows everything once unfolded", () => {
    expect(visibleFiles(17, true)).toBe(17);
  });

  it("says what a Save all did", () => {
    expect(saveAllNote({ kind: "saved", count: 3, skipped: 0 })).toEqual({
      text: "Saved 3 files.",
      tone: "plain",
    });
    expect(saveAllNote({ kind: "saved", count: 1, skipped: 0 })?.text).toBe("Saved 1 file.");
    expect(saveAllNote({ kind: "saved", count: 3, skipped: 2 })).toEqual({
      text: "Saved 3 files. Couldn’t save 2 files.",
      tone: "late",
    });
    expect(saveAllNote({ kind: "cancelled" })).toBeNull();
    expect(saveAllNote({ kind: "offline" })?.tone).toBe("late");
  });
});

const pdf = (partId: string, name: string, size = 1000): ReceivedAttachment => ({
  partId,
  name,
  mimeType: "application/pdf",
  size,
  inline: false,
});

/** A controller over fakes, with a way to answer its asks and to push events. */
function rig(files: ReceivedAttachment[], reduced = false) {
  const asks: ReceivedAsk[] = [];
  const pending: ((a: ReceivedAnswer) => void)[] = [];
  const listeners = new Set<(e: BackendEvent) => void>();
  const sink = createProgressSink();
  return createRoot((dispose) => {
    const controller = createReceivedController(77, () => files, {
      ask: (request) =>
        new Promise<ReceivedAnswer>((resolve) => {
          asks.push(request);
          pending.push(resolve);
        }),
      sink,
      keyOf: (key, part) => `r:${key}/${part}`,
      onEvent: (l) => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      reducedMotion: () => reduced,
    });
    return {
      controller,
      asks,
      sink,
      answer: (a: ReceivedAnswer) => pending.shift()?.(a),
      emit: (e: BackendEvent) => {
        for (const l of listeners) l(e);
      },
      listeners,
      dispose,
    };
  });
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the controller of a message's files", () => {
  it("asks main by message key and part id only", async () => {
    const t = rig([pdf("2", "a.pdf")]);
    void t.controller.open("2");
    void t.controller.preview("2");
    // The second press waits for the first: one ask at a time for a file.
    expect(t.asks).toEqual([{ action: "open", messageKey: 77, partId: "2" }]);
    t.answer({ kind: "opened" });
    await flush();
    void t.controller.preview("2");
    t.answer({ kind: "previewed" });
    await flush();
    expect(t.asks.map((a) => a.action)).toEqual(["open", "preview"]);
    for (const ask of t.asks) expect(JSON.stringify(ask)).not.toMatch(/path|\//);
    t.dispose();
  });

  it("offers the file's name as a hint for a save, and the items for Save all", async () => {
    const t = rig([pdf("2", "a.pdf"), pdf("3", "b.pdf")]);
    void t.controller.save("2");
    t.answer({ kind: "cancelled" });
    await flush();
    void t.controller.saveAll(["2", "3"]);
    expect(t.asks).toEqual([
      { action: "save", messageKey: 77, partId: "2", name: "a.pdf" },
      {
        action: "saveAll",
        items: [
          { messageKey: 77, partId: "2" },
          { messageKey: 77, partId: "3" },
        ],
      },
    ]);
    t.answer({ kind: "saved", count: 2, skipped: 0 });
    await flush();
    expect(t.controller.note()?.text).toBe("Saved 2 files.");
    t.dispose();
  });

  it("shows a download only if it lasts, and a quick answer never flashes", async () => {
    vi.useFakeTimers();
    try {
      const t = rig([pdf("2", "a.pdf", 5_000_000)]);
      void t.controller.open("2");
      expect(t.controller.stateOf("2").phase).toBe("idle");
      await vi.advanceTimersByTimeAsync(50);
      t.answer({ kind: "opened" });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.controller.stateOf("2")).toEqual({ phase: "idle", here: true });
      expect(t.controller.spoken()).toBe("");

      void t.controller.open("2");
      await vi.advanceTimersByTimeAsync(500);
      // Here already: still no ring for a press that is instant.
      expect(t.controller.stateOf("2").phase).toBe("idle");
      t.answer({ kind: "opened" });
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("goes through downloading to ready, and announces the start", async () => {
    vi.useFakeTimers();
    try {
      const t = rig([pdf("2", "Plan.zip", 5_000_000)]);
      void t.controller.open("2");
      await vi.advanceTimersByTimeAsync(200);
      expect(t.controller.stateOf("2").phase).toBe("downloading");
      expect(t.controller.spoken()).toBe("Downloading Plan.zip");
      t.answer({ kind: "opened" });
      await vi.advanceTimersByTimeAsync(0);
      expect(t.controller.stateOf("2")).toEqual({ phase: "idle", here: true });
      t.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a second press while one is running", async () => {
    const t = rig([pdf("2", "a.pdf")]);
    void t.controller.open("2");
    void t.controller.open("2");
    void t.controller.save("2");
    expect(t.asks).toHaveLength(1);
    t.answer({ kind: "opened" });
    await flush();
    t.dispose();
  });

  it("lets a failed chip be pressed again, and a chip that is gone not", async () => {
    const t = rig([pdf("2", "a.pdf"), pdf("3", "b.pdf")]);
    void t.controller.open("2");
    t.answer({ kind: "offline" });
    await flush();
    expect(t.controller.stateOf("2").phase).toBe("offline");
    expect(t.controller.spoken()).toMatch(/offline/);
    void t.controller.open("2");
    expect(t.asks).toHaveLength(2);
    t.answer({ kind: "opened" });
    await flush();
    expect(t.controller.stateOf("2").phase).toBe("idle");

    void t.controller.open("3");
    t.answer({ kind: "gone" });
    await flush();
    expect(t.controller.stateOf("3").phase).toBe("gone");
    void t.controller.open("3");
    expect(t.asks).toHaveLength(3);
    t.dispose();
  });

  it("takes a failed ask of main for a failed download", async () => {
    const asks: ReceivedAsk[] = [];
    createRoot((dispose) => {
      const c = createReceivedController(1, () => [pdf("2", "a.pdf")], {
        ask: async (r) => {
          asks.push(r);
          throw new Error("closed");
        },
        sink: createProgressSink(),
        keyOf: (k, p) => `${k}/${p}`,
        onEvent: () => () => {},
        reducedMotion: () => false,
      });
      void c.open("2").then(() => {
        expect(c.stateOf("2").phase).toBe("failed");
        dispose();
      });
    });
    await flush();
    expect(asks).toHaveLength(1);
  });

  it("explains a refused open and says nothing to main for a program", async () => {
    const t = rig([pdf("2", "Instalator.command")]);
    t.controller.explain(RUNNABLE_NOTE);
    expect(t.controller.note()?.text).toBe(RUNNABLE_NOTE);
    expect(t.controller.spoken()).toBe(RUNNABLE_NOTE);
    expect(t.asks).toEqual([]);
    t.dispose();
  });

  it("knows which files get a ring", () => {
    const t = rig([pdf("2", "small.pdf", 1000), pdf("3", "big.zip", 2_000_000)]);
    expect(t.controller.ringed("2")).toBe(false);
    expect(t.controller.ringed("3")).toBe(true);
    expect(t.controller.ringed("9")).toBe(false);
    t.dispose();
  });

  describe("progress events", () => {
    const event = (partId: string, bytes: number, total: number): BackendEvent => ({
      type: "receivedProgress",
      messageKey: 77,
      partId,
      bytes,
      totalBytes: total,
    });

    it("reach the ring and the words directly, not through the state", () => {
      const t = rig([pdf("2", "big.zip", 40_000_000)]);
      const style = { setProperty: vi.fn() };
      const text = { textContent: "" };
      t.sink.bind("r:77/2", { ring: { style } as unknown as HTMLElement, text });
      t.emit(event("2", 14_000_000, 34_000_000));
      expect(style.setProperty).toHaveBeenLastCalledWith("--p", String(14 / 34));
      expect(text.textContent).toBe("14 of 34 MB");
      t.dispose();
    });

    it("show a download started elsewhere, and only for this message's files", () => {
      const t = rig([pdf("2", "big.zip", 40_000_000)]);
      t.emit({ type: "receivedProgress", messageKey: 5, partId: "2", bytes: 1, totalBytes: 100 });
      expect(t.controller.stateOf("2").phase).toBe("idle");
      t.emit(event("9", 1, 100));
      expect(t.controller.stateOf("9").phase).toBe("idle");
      t.emit(event("2", 1, 100));
      expect(t.controller.stateOf("2").phase).toBe("downloading");
      t.dispose();
    });

    it("step by quarters with reduced motion", () => {
      const t = rig([pdf("2", "big.zip", 40_000_000)], true);
      const style = { setProperty: vi.fn() };
      t.sink.bind("r:77/2", { ring: { style } as unknown as HTMLElement });
      t.emit(event("2", 10, 100));
      t.emit(event("2", 40, 100));
      expect(style.setProperty.mock.calls.map((c) => c[1])).toEqual(["0", "0.25"]);
      t.dispose();
    });

    it("stop being heard when the strip goes", () => {
      const t = rig([pdf("2", "big.zip", 40_000_000)]);
      expect(t.listeners.size).toBe(1);
      t.controller.dispose();
      expect(t.listeners.size).toBe(0);
      t.dispose();
    });
  });
});
