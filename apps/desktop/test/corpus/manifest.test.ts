// The corpus keeps itself honest (ADR 0047): every case has a message or a scenario, every message
// has a case, every gap says what it is, and nothing can sit in the manifest without a runner.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  CATEGORIES,
  CORPUS_DIR,
  caseBytes,
  loadManifest,
  matches,
  SEVERITIES,
  TIERS,
} from "@matters/testkit/corpus";
import { describe, expect, it } from "vitest";

const cases = loadManifest();

function emlFiles(dir: string, base = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    return statSync(path).isDirectory() ? emlFiles(path, rel) : name.endsWith(".eml") ? [rel] : [];
  });
}

describe("corpus manifest", () => {
  it("has unique ids that match the file name and sit in their category", () => {
    const ids = cases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of cases) {
      expect(CATEGORIES, c.id).toContain(c.category);
      if (c.file) expect(c.file, c.id).toBe(`${c.category}/${c.id}.eml`);
    }
  });

  it("has a message (a file or a generator) for every case that is not a scenario, and no other", () => {
    for (const c of cases) {
      const scenario = c.category === "compose" || c.category === "transport";
      expect(!!c.file || !!c.generator, `${c.id} needs a message`).toBe(!scenario);
      if (c.file) expect(existsSync(join(CORPUS_DIR, c.file)), c.id).toBe(true);
      if (c.generator) expect(caseBytes(c).length, c.id).toBeGreaterThan(100);
    }
  });

  it("has no message file without a case", () => {
    const listed = new Set(cases.flatMap((c) => (c.file ? [c.file] : [])));
    expect(emlFiles(CORPUS_DIR).filter((f) => !listed.has(f))).toEqual([]);
  });

  it("names its sources, what it attacks and at least one tier with checks", () => {
    for (const c of cases) {
      expect(c.sources.length, c.id).toBeGreaterThan(0);
      expect(
        c.sources.every((s) => s.trim() !== ""),
        c.id,
      ).toBe(true);
      expect(c.attacks.length, c.id).toBeGreaterThan(10);
      const tiers = Object.entries(c.tiers);
      expect(tiers.length, `${c.id} has no tier`).toBeGreaterThan(0);
      for (const [tier, spec] of tiers) {
        expect(TIERS, c.id).toContain(tier);
        expect(spec?.checks.length ?? 0, `${c.id} ${tier}`).toBeGreaterThan(0);
      }
    }
  });

  it("describes every gap: severity, a reason, and a current value that is not the ideal", () => {
    for (const c of cases) {
      for (const spec of Object.values(c.tiers)) {
        for (const check of spec?.checks ?? []) {
          if (!check.gap) continue;
          expect(SEVERITIES, `${c.id} ${check.name}`).toContain(check.gap.severity);
          expect(check.gap.reason.length, `${c.id} ${check.name}`).toBeGreaterThan(20);
          expect(
            matches(check.ideal, check.gap.current),
            `${c.id} ${check.name}: the gap equals the ideal`,
          ).toBe(false);
        }
      }
    }
  });

  it("keeps the messages byte-exact: a .gitattributes marks them -text, and CRLF is present", () => {
    expect(readFileSync(join(CORPUS_DIR, ".gitattributes"), "utf8")).toMatch(/\*\.eml\s+-text/);
    const crlf = cases
      .filter((c) => c.file)
      .filter((c) => readFileSync(join(CORPUS_DIR, c.file as string)).includes("\r\n"));
    expect(crlf.length).toBeGreaterThan(100);
  });

  it("uses only reserved names and the canary token for hosts", () => {
    const allowed =
      /(?:example\.(?:com|org|net)|corpus\.test|canary\.test|[a-z0-9-]+\.test|[a-z0-9-]+\.invalid|www\.w3\.org|localhost)$/i;
    for (const c of cases.filter((x) => x.file)) {
      const text = caseBytes(c).toString("latin1");
      for (const m of text.matchAll(/\b(?:https?:\/\/|@)([a-z0-9][a-z0-9.-]*\.[a-z]{2,})/gi)) {
        // A host that goes on in non-ASCII letters is a deliberate lookalike; its ASCII part is not a host.
        if (text.charCodeAt((m.index ?? 0) + m[0].length) > 127) continue;
        expect(allowed.test(m[1] ?? ""), `${c.id}: ${m[1]} is a real-looking host`).toBe(true);
      }
    }
  });

  it("is written up: every case id on the standards page exists, and every known gap is on it", () => {
    const page = readFileSync(
      join(CORPUS_DIR, "..", "..", "..", "docs/security/standards.md"),
      "utf8",
    );
    const known = new Set(cases.map((c) => c.id));
    const mentioned = [
      ...page.matchAll(
        /`((?:identity|auth|html|mime|attachments|compose|transport|agent)-[a-z0-9-]+)`/g,
      ),
    ].map((m) => m[1] ?? "");
    expect(mentioned.filter((id) => !known.has(id))).toEqual([]);
    const gapped = cases
      .filter((c) => Object.values(c.tiers).some((t) => t?.checks.some((k) => k.gap)))
      .map((c) => c.id);
    expect(gapped.filter((id) => !page.includes(`\`${id}\``))).toEqual([]);
  });
});
