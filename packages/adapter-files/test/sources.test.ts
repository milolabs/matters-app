import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSourceFiles } from "../src/index.ts";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "matters-sources-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const noop = () => {};
const text = (s: string) => new TextEncoder().encode(s);
const chunks = (...parts: Uint8Array[]) =>
  (async function* () {
    for (const p of parts) yield p;
  })();

describe("a message saved as a file (ADR 0145, rule 2)", () => {
  it("is written byte for byte, readable by the person alone, with no execute bit", async () => {
    const target = join(dir, "Lunch 2026-11-16.eml");
    const seen: number[] = [];
    const written = await createSourceFiles().write(
      target,
      true,
      chunks(text("From: a\r\n"), text("\r\nbody")),
      (n) => seen.push(n),
    );
    expect(written).toBe(15);
    expect(seen).toEqual([9, 15]);
    expect(readFileSync(target, "latin1")).toBe("From: a\r\n\r\nbody");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["Lunch 2026-11-16.eml"]);
  });

  it("leaves nothing behind when it is stopped part way, and nothing under the name", async () => {
    const target = join(dir, "Big.eml");
    const controller = new AbortController();
    const stream = (async function* () {
      yield text("part one");
      controller.abort();
      yield text("part two");
    })();
    await expect(
      createSourceFiles().write(target, true, stream, noop, controller.signal),
    ).rejects.toBeDefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("leaves nothing behind when the connection breaks", async () => {
    const target = join(dir, "Broken.eml");
    const stream = (async function* () {
      yield text("half a message");
      throw new Error("the socket closed");
    })();
    await expect(createSourceFiles().write(target, true, stream, noop)).rejects.toThrow(
      "the socket closed",
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("never replaces a file without being told to, and keeps it whole", async () => {
    const target = join(dir, "01 Lunch.eml");
    writeFileSync(target, "the person's own file");
    await expect(
      createSourceFiles().write(target, false, chunks(text("new")), noop),
    ).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(target, "utf8")).toBe("the person's own file");
    expect(readdirSync(dir)).toEqual(["01 Lunch.eml"]);
  });

  it("replaces a file when the dialog asked", async () => {
    const target = join(dir, "Lunch.eml");
    writeFileSync(target, "old");
    await createSourceFiles().write(target, true, chunks(text("new")), noop);
    expect(readFileSync(target, "utf8")).toBe("new");
    expect(readdirSync(dir)).toEqual(["Lunch.eml"]);
  });
});
