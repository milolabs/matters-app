import { describe, expect, it } from "vitest";
import { firstScreenReady } from "../src/renderer/firstScreen.ts";

const ready = {
  accountsLoaded: true,
  listLoaded: true,
  hasMessages: true,
  threadOpen: true,
  aiOn: true,
  thingsLoaded: true,
};

describe("firstScreenReady (ADR 0070, rule 3)", () => {
  it("is ready when everything the first screen shows is here", () => {
    expect(firstScreenReady(ready)).toBe(true);
  });

  it("waits for the accounts, the list and the open thread", () => {
    expect(firstScreenReady({ ...ready, accountsLoaded: false })).toBe(false);
    expect(firstScreenReady({ ...ready, listLoaded: false })).toBe(false);
    expect(firstScreenReady({ ...ready, threadOpen: false })).toBe(false);
  });

  it("waits for the list of things only with AI on", () => {
    expect(firstScreenReady({ ...ready, thingsLoaded: false })).toBe(false);
    expect(firstScreenReady({ ...ready, aiOn: false, thingsLoaded: false })).toBe(true);
  });

  it("has no thread to wait for in an empty mailbox", () => {
    expect(firstScreenReady({ ...ready, hasMessages: false, threadOpen: false })).toBe(true);
  });
});
