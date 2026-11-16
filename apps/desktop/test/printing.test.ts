// Printing and saving as a PDF (ADR 0144): the printer's job with a stand-in window, dialog and
// file; the shapes that cross between the page and main; and the mail window's bridge.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrintDocument } from "@matters/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createPrinter,
  type Paper,
  type PrinterDeps,
  type PrintReady,
  type PrintWindow,
  paperFor,
  printWidthPx,
} from "../src/main/printer.ts";
import {
  CHANNEL_PRINT,
  CHANNEL_PRINT_AVAILABLE,
  CHANNEL_PRINT_DOCUMENT,
  CHANNEL_PRINT_READY,
  readPrintAnswer,
  readPrintDocument,
} from "../src/main/printShapes.ts";
import { createPrintBridge } from "../src/preload/printBridge.ts";

const doc: PrintDocument = {
  title: "Lunch on Friday",
  day: "2026-11-16",
  letters: [
    {
      from: "Anna <anna@example.com>",
      to: "Me <me@example.com>",
      cc: "",
      date: "Monday, 16 November 2026 at 13:00",
      subject: "Lunch on Friday",
      badge: "",
      note: "",
      body: { kind: "html", html: "<p>Hi</p>", images: false },
      attachments: ["menu.pdf · 20 KB"],
    },
    {
      from: "Me <me@example.com>",
      to: "Anna <anna@example.com>",
      cc: "",
      date: "Monday, 16 November 2026 at 14:00",
      subject: "Re: Lunch on Friday",
      badge: "",
      note: "",
      body: { kind: "text", parts: [{ kind: "text", text: "Yes!" }] },
      attachments: [],
    },
  ],
};

interface Fake {
  readonly deps: PrinterDeps;
  readonly windows: { id: number; destroyed: boolean; printed: number; pdfs: Paper[] }[];
  readonly written: { path: string; bytes: Uint8Array }[];
  readonly rendered: { doc: PrintDocument; widthPx: number }[];
}

function fake(
  over: {
    ready?: PrintReady | Error;
    print?: boolean | Error;
    save?: string | undefined;
    write?: Error;
    paper?: Paper;
  } = {},
): Fake {
  const windows: Fake["windows"] = [];
  const written: Fake["written"] = [];
  const rendered: Fake["rendered"] = [];
  const deps: PrinterDeps = {
    open(): PrintWindow {
      const w = { id: windows.length + 10, destroyed: false, printed: 0, pdfs: [] as Paper[] };
      windows.push(w);
      return {
        async render(d, widthPx) {
          rendered.push({ doc: d, widthPx });
          const ready = over.ready ?? { ok: true, scriptRan: false };
          if (ready instanceof Error) throw ready;
          return ready;
        },
        async print() {
          w.printed++;
          if (over.print instanceof Error) throw over.print;
          return over.print ?? true;
        },
        async printToPDF(paper) {
          w.pdfs.push(paper);
          return new TextEncoder().encode("%PDF-1.4 fake");
        },
        destroy() {
          w.destroyed = true;
        },
      };
    },
    chooseSavePath: async (name) => ("save" in over ? over.save : `/Users/x/Downloads/${name}`),
    async writeFile(path, bytes) {
      if (over.write) throw over.write;
      written.push({ path, bytes });
    },
    paper: () => over.paper ?? "A4",
    log: () => {},
  };
  return { deps, windows, written, rendered };
}

describe("the printer (ADR 0144, rules 4 to 6)", () => {
  it("prints once, for the window it made, and destroys that window after", async () => {
    const f = fake();
    const answer = await createPrinter(f.deps).run("print", doc);
    expect(answer).toEqual({ kind: "done" });
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0]?.printed).toBe(1);
    expect(f.windows[0]?.destroyed).toBe(true);
    expect(f.rendered).toEqual([{ doc, widthPx: printWidthPx("A4") }]);
    expect(f.written).toEqual([]);
  });

  it("says cancelled when the person cancels the print dialog, and still destroys the window", async () => {
    const f = fake({ print: false });
    expect(await createPrinter(f.deps).run("print", doc)).toEqual({ kind: "cancelled" });
    expect(f.windows[0]?.destroyed).toBe(true);
  });

  it("destroys the window and says failed when anything fails", async () => {
    for (const over of [
      { ready: new Error("timeout") },
      { ready: { ok: false, scriptRan: false } },
      { print: new Error("no printer") },
    ]) {
      const f = fake(over);
      expect(await createPrinter(f.deps).run("print", doc)).toEqual({ kind: "failed" });
      expect(f.windows[0]?.destroyed).toBe(true);
      expect(f.windows[0]?.printed ?? 0).toBeLessThanOrEqual(1);
    }
    const f = fake({ write: new Error("disk full") });
    expect(await createPrinter(f.deps).run("pdf", doc)).toEqual({ kind: "failed" });
    expect(f.windows[0]?.destroyed).toBe(true);
  });

  it("asks where first: a cancelled save makes no window and writes nothing", async () => {
    const f = fake({ save: undefined });
    expect(await createPrinter(f.deps).run("pdf", doc)).toEqual({ kind: "cancelled" });
    expect(f.windows).toEqual([]);
    expect(f.written).toEqual([]);
  });

  it("writes the PDF where the person chose, under the name of the subject and the day", async () => {
    const f = fake({ paper: "Letter" });
    const chosen = vi.spyOn(f.deps, "chooseSavePath");
    expect(await createPrinter(f.deps).run("pdf", doc)).toEqual({ kind: "done" });
    expect(chosen).toHaveBeenCalledWith("Lunch on Friday 2026-11-16.pdf");
    expect(f.written.map((w) => w.path)).toEqual([
      "/Users/x/Downloads/Lunch on Friday 2026-11-16.pdf",
    ]);
    expect(f.windows[0]?.pdfs).toEqual(["Letter"]);
    expect(f.windows[0]?.printed).toBe(0);
    expect(f.windows[0]?.destroyed).toBe(true);
    expect(f.rendered[0]?.widthPx).toBe(printWidthPx("Letter"));
  });

  it("does one job at a time: a second ask meanwhile is busy and makes nothing", async () => {
    const f = fake();
    let release = () => {};
    const open = f.deps.open;
    f.deps.open = () => {
      const w = open();
      return {
        ...w,
        render: (d, width, ms) =>
          new Promise<PrintReady>((r) => {
            release = () => void w.render(d, width, ms).then(r);
          }),
      };
    };
    const printer = createPrinter(f.deps);
    const first = printer.run("print", doc);
    await Promise.resolve();
    expect(printer.busy()).toBe(true);
    expect(await printer.run("pdf", doc)).toEqual({ kind: "busy" });
    release();
    expect(await first).toEqual({ kind: "done" });
    expect(f.windows).toHaveLength(1);
    expect(printer.busy()).toBe(false);
    // And free again after.
    f.deps.open = open;
    expect(await printer.run("print", doc)).toEqual({ kind: "done" });
  });

  it("chooses Letter where it is the usual paper and A4 elsewhere, and a width that fits", () => {
    expect(paperFor("US")).toBe("Letter");
    expect(paperFor("ca")).toBe("Letter");
    expect(paperFor("PL")).toBe("A4");
    expect(paperFor("")).toBe("A4");
    expect(printWidthPx("A4")).toBe(678);
    expect(printWidthPx("Letter")).toBe(700);
  });
});

describe("what crosses (ADR 0144)", () => {
  it("reads a thread of the right shape, and nothing else", () => {
    expect(readPrintDocument(doc)).toEqual(doc);
    expect(readPrintDocument(null)).toBeNull();
    expect(readPrintDocument({ ...doc, letters: [] })).toBeNull();
    expect(readPrintDocument({ ...doc, title: 1 })).toBeNull();
    expect(readPrintDocument({ ...doc, day: "x".repeat(11) })).toBeNull();
    const letter = doc.letters[0] as (typeof doc.letters)[number];
    const bad = (l: unknown) => readPrintDocument({ ...doc, letters: [l] });
    expect(bad({ ...letter, from: { toString: () => "x" } })).toBeNull();
    expect(bad({ ...letter, body: { kind: "html", html: "<p>", images: "yes" } })).toBeNull();
    expect(bad({ ...letter, body: { kind: "frame", html: "<p>" } })).toBeNull();
    expect(
      bad({ ...letter, body: { kind: "text", parts: [{ kind: "script", text: "x" }] } }),
    ).toBeNull();
    expect(bad({ ...letter, attachments: [1] })).toBeNull();
    expect(bad({ ...letter, subject: "x".repeat(20_001) })).toBeNull();
    // Extra fields are not carried.
    const read = readPrintDocument({ ...doc, extra: 1, letters: [{ ...letter, extra: 2 }] });
    expect(read && "extra" in read).toBe(false);
    expect(read?.letters[0] && "extra" in read.letters[0]).toBe(false);
  });

  it("reads main's answer, and anything else as a failure", () => {
    expect(readPrintAnswer({ kind: "done" })).toEqual({ kind: "done" });
    expect(readPrintAnswer({ kind: "cancelled", path: "/x" })).toEqual({ kind: "cancelled" });
    expect(readPrintAnswer({ kind: "opened" })).toEqual({ kind: "failed" });
    expect(readPrintAnswer(undefined)).toEqual({ kind: "failed" });
  });

  it("names the print view's channels as the print view's preload does", () => {
    const preload = readFileSync(join(import.meta.dirname, "../src/preload/print.ts"), "utf8");
    expect(preload).toContain(`"${CHANNEL_PRINT_DOCUMENT}"`);
    expect(preload).toContain(`"${CHANNEL_PRINT_READY}"`);
    // It imports nothing but electron: a shared module would be a chunk it cannot load.
    expect([...preload.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1])).toEqual([
      "electron",
    ]);
  });
});

describe("the mail window's print bridge", () => {
  const page = {};
  function bridge(answer: unknown = { kind: "done" }) {
    const invoke = vi.fn(async () => answer);
    const send = vi.fn();
    const posted: unknown[] = [];
    const b = createPrintBridge({ invoke, send, post: (m) => posted.push(m) }, page);
    return { b, invoke, send, posted };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("asks main with a checked thread, and passes main's answer back", async () => {
    const { b, invoke, posted } = bridge();
    b.message({ source: page, data: { mattersPrint: { requestId: "r1", action: "pdf", doc } } });
    await flush();
    expect(invoke).toHaveBeenCalledWith(CHANNEL_PRINT, "pdf", doc);
    expect(posted).toEqual([{ mattersPrintAnswer: { requestId: "r1", answer: { kind: "done" } } }]);
  });

  it("refuses another action, a thread of another shape, or another window's message", async () => {
    const { b, invoke, posted } = bridge();
    b.message({ source: page, data: { mattersPrint: { requestId: "r1", action: "open", doc } } });
    b.message({
      source: page,
      data: { mattersPrint: { requestId: "r2", action: "print", doc: {} } },
    });
    b.message({ source: {}, data: { mattersPrint: { requestId: "r3", action: "print", doc } } });
    await flush();
    expect(invoke).not.toHaveBeenCalled();
    expect(posted).toEqual([
      { mattersPrintAnswer: { requestId: "r1", answer: { kind: "failed" } } },
      { mattersPrintAnswer: { requestId: "r2", answer: { kind: "failed" } } },
    ]);
  });

  it("tells main whether a thread is open, as a boolean, and passes the menu's ask on", () => {
    const { b, send, posted } = bridge();
    b.message({ source: page, data: { mattersPrintAvailable: true } });
    b.message({ source: page, data: { mattersPrintAvailable: "yes" } });
    expect(send.mock.calls).toEqual([
      [CHANNEL_PRINT_AVAILABLE, true],
      [CHANNEL_PRINT_AVAILABLE, false],
    ]);
    b.ask("print");
    b.ask("rm -rf");
    expect(posted).toEqual([{ mattersPrintAsk: "print" }]);
  });
});
