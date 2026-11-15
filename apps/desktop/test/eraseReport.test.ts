import type { EraseResult, Holding, HoldingOutcome } from "@matters/core";
import { describe, expect, it } from "vitest";
import { eraseReport } from "../src/main/eraseReport.ts";

const holding = (id: string, group: Holding["group"], place: Holding["place"]): Holding => ({
  id,
  group,
  place,
  step: "signIns",
});
const outcome = (holding: Holding, outcome: HoldingOutcome) => ({ holding, outcome });
const result = (outcomes: EraseResult["outcomes"] = []): EraseResult => ({
  startedAtMs: 100,
  endedAtMs: 350,
  earlierCopy: false,
  outcomes,
});
const vault = holding("vault", "signIns", {
  kind: "data",
  name: "credentials.json",
  match: "exact",
});
const key = holding("key", "signIns", { kind: "keychain", which: "current" });
const db = holding("db", "mail", { kind: "database", suffix: "" });

describe("the erase result shown to the person (ADR 0138, rule 11)", () => {
  it("succeeds for an already empty installation without inventing erased groups", () => {
    expect(eraseReport(result([outcome(vault, { kind: "absent" })]))).toEqual({
      ok: true,
      bytes: 0,
      ms: 250,
      earlierCopy: false,
      groups: [],
      left: [],
      keys: 0,
      markerLeft: false,
    });
  });

  it("aggregates only erased bytes in review order, counts erased keys, and preserves the earlier-copy choice", () => {
    const r = {
      ...result([
        outcome(db, { kind: "gone", bytes: 100 }),
        outcome(key, { kind: "gone", bytes: 0 }),
        outcome(vault, { kind: "gone", bytes: 20 }),
      ]),
      earlierCopy: true,
    };
    expect(eraseReport(r)).toEqual({
      ok: true,
      bytes: 120,
      ms: 250,
      earlierCopy: true,
      groups: [
        { group: "signIns", bytes: 20 },
        { group: "mail", bytes: 100 },
      ],
      left: [],
      keys: 1,
      markerLeft: false,
    });
  });

  it("reports each leftover reason and location without counting it as erased", () => {
    const r = result([
      outcome(db, { kind: "gone", bytes: 100 }),
      outcome(vault, {
        kind: "left",
        reason: "refused",
        bytes: 20,
        where: "/data/credentials.json",
      }),
      outcome(key, { kind: "left", reason: "keychainRefused", bytes: 0, where: null }),
    ]);
    expect(eraseReport(r, true)).toEqual({
      ok: false,
      bytes: 100,
      ms: 250,
      earlierCopy: false,
      groups: [{ group: "mail", bytes: 100 }],
      keys: 0,
      markerLeft: true,
      left: [
        {
          group: "signIns",
          kind: "path",
          reason: "refused",
          bytes: 20,
          where: "/data/credentials.json",
        },
        { group: "signIns", kind: "key", reason: "keychainRefused", bytes: 0, where: null },
      ],
    });
  });

  it("does not expose internal holding names or paths of successfully erased files", () => {
    const secret = holding("private-holding-id", "files", {
      kind: "data",
      name: "private-file-name",
      match: "exact",
    });
    const report = eraseReport(result([outcome(secret, { kind: "gone", bytes: 42 })]));
    expect(report.groups).toEqual([{ group: "files", bytes: 42 }]);
    expect(JSON.stringify(report)).not.toContain("private");
  });
});
