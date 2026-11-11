import type { MoveOperation } from "@matters/core";
import { describe, expect, it } from "vitest";
import { summariseMoves } from "../src/backend/moveSummary.ts";

const op = (key: number, over: Partial<MoveOperation> = {}): MoveOperation => ({
  key,
  accountId: "acc1",
  operationId: "a",
  action: "archive",
  target: "role:archive",
  labelsBefore: ["INBOX"],
  mailboxesBefore: 1,
  attempts: 0,
  nextAttemptMs: 10_000,
  createdAtMs: 0,
  rev: 1,
  ...over,
});
const folders = [{ id: "Clients", accountId: "acc1", name: "Klienci" }];

describe("the moves the tray shows (ADR 0044, rule 10)", () => {
  it("makes one line of the rows of an action, with the time its window ends", () => {
    expect(summariseMoves([op(1), op(2, { nextAttemptMs: 10_500 })], folders)).toEqual([
      { id: "a", action: "archive", count: 2, notBeforeMs: 10_500 },
    ]);
  });

  it("orders the actions by when they end, and names the folder of a move", () => {
    const rows = [
      op(1, { operationId: "late", nextAttemptMs: 20_000 }),
      op(2, {
        operationId: "early",
        action: "move",
        target: "folder:Clients",
        nextAttemptMs: 11_000,
      }),
      op(3, { operationId: "inbox", action: "move", target: "role:inbox", nextAttemptMs: 12_000 }),
    ];
    expect(summariseMoves(rows, folders).map((s) => [s.id, s.place])).toEqual([
      ["early", "Klienci"],
      ["inbox", "Inbox"],
      ["late", undefined],
    ]);
  });

  it("leaves out an action with a row that was tried, a deletion for good, and nothing at all", () => {
    expect(summariseMoves([op(1), op(2, { attempts: 1 })], folders)).toEqual([]);
    expect(summariseMoves([op(1, { action: "purge", target: "" })], folders)).toEqual([]);
    expect(summariseMoves([], folders)).toEqual([]);
  });

  it("names a folder it has not heard of by its id", () => {
    const rows = [op(1, { action: "move", target: "folder:Gone" })];
    expect(summariseMoves(rows, folders)[0]?.place).toBe("Gone");
  });
});
