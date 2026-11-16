import { settle } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { RuntimeKeys } from "../src/backend/runtimeKeys.ts";

// ADR 0141, rules 5 and 6: the commands of a runtime's key one at a time, and the ticket of the
// key a turn began on.

/** A command that waits until it is let go, and says when it started. */
function held(log: string[], name: string) {
  let go: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    go = resolve;
  });
  return {
    go: () => go(),
    run: async () => {
      log.push(`${name} starts`);
      await gate;
      log.push(`${name} ends`);
      return name;
    },
  };
}

describe("the keys of the runtimes (ADR 0141)", () => {
  it("runs the commands of one runtime one at a time, in the order they were asked for", async () => {
    const keys = new RuntimeKeys();
    const log: string[] = [];
    const first = held(log, "save");
    const second = held(log, "reading");
    const a = keys.serial("api", first.run);
    const b = keys.serial("api", second.run);
    await settle();
    expect(log).toEqual(["save starts"]);
    second.go();
    await settle();
    expect(log).toEqual(["save starts"]);
    first.go();
    expect(await a).toBe("save");
    expect(await b).toBe("reading");
    expect(log).toEqual(["save starts", "save ends", "reading starts", "reading ends"]);
  });

  it("runs the next command after one that failed", async () => {
    const keys = new RuntimeKeys();
    const failed = keys.serial("api", async () => {
      await settle();
      throw new Error("vault refused");
    });
    const next = keys.serial("api", async () => "ran");
    await expect(failed).rejects.toThrow("vault refused");
    expect(await next).toBe("ran");
    // And the queue stays usable after it.
    expect(await keys.serial("api", async () => "again")).toBe("again");
  });

  it("does not make the commands of one runtime wait on another's", async () => {
    const keys = new RuntimeKeys();
    const log: string[] = [];
    const slow = held(log, "api");
    const a = keys.serial("api", slow.run);
    const b = keys.serial("other", async () => "other");
    expect(await b).toBe("other");
    slow.go();
    expect(await a).toBe("api");
  });

  it("holds a ticket until the runtime has a new key, and stops what runs on it then", () => {
    const keys = new RuntimeKeys();
    const ticket = keys.ticket("api");
    const signal = keys.stopSignal("api");
    const other = keys.ticket("other");
    expect(keys.holds(ticket)).toBe(true);
    keys.next("api");
    expect(keys.holds(ticket)).toBe(false);
    expect(signal.aborted).toBe(true);
    // Another runtime's key is its own.
    expect(keys.holds(other)).toBe(true);
    // What begins on the new key holds, and its signal is not aborted.
    expect(keys.holds(keys.ticket("api"))).toBe(true);
    expect(keys.stopSignal("api").aborted).toBe(false);
  });

  it("lets background work go only while the key holds and its switch was not turned off since", () => {
    const keys = new RuntimeKeys();
    const ticket = keys.ticket("api");
    expect(keys.mayGoInBackground(ticket)).toBe(true);
    keys.readingOff("api");
    // The key still holds, for what the person asked; nothing in the background goes on it.
    expect(keys.holds(ticket)).toBe(true);
    expect(keys.mayGoInBackground(ticket)).toBe(false);
    // A ticket taken after the switch went off reads it off, and may go once it is on again.
    expect(keys.mayGoInBackground(keys.ticket("api"))).toBe(true);
    const later = keys.ticket("api");
    keys.next("api");
    expect(keys.mayGoInBackground(later)).toBe(false);
    expect(keys.mayGoInBackground(keys.ticket("other"))).toBe(true);
  });

  it("writes what a ticket's turn found only while the ticket holds as the write begins", async () => {
    const keys = new RuntimeKeys();
    const ticket = keys.ticket("api");
    const written: string[] = [];
    const write = async () => {
      written.push("rule");
      return 7;
    };
    expect(await keys.keep(ticket, write)).toEqual({ value: 7 });
    keys.next("api");
    expect(await keys.keep(ticket, write)).toBeNull();
    expect(written).toEqual(["rule"]);
  });

  it("holds no ticket while a key is written, and none taken before or meanwhile once it is", async () => {
    const keys = new RuntimeKeys();
    const before = keys.ticket("api");
    const other = keys.ticket("other");
    const log: string[] = [];
    const vault = held(log, "vault");
    let meanwhile = keys.ticket("api");
    const writing = keys.change("api", async () => {
      meanwhile = keys.ticket("api");
      await vault.run();
    });
    let quiet = false;
    void keys.quiet("api").then(() => {
      quiet = true;
    });
    await settle();
    // Not even the key before, which the vault still keeps, nor a ticket taken now.
    expect(keys.holds(before)).toBe(false);
    expect(keys.holds(meanwhile)).toBe(false);
    expect(keys.holds(keys.ticket("api"))).toBe(false);
    expect(keys.mayGoInBackground(meanwhile)).toBe(false);
    expect(quiet).toBe(false);
    // Another runtime's key is its own.
    expect(keys.holds(other)).toBe(true);
    // The write and the new key are one step: at no moment after does a ticket from before hold.
    let heldOnce = false;
    const watch = (async () => {
      for (let i = 0; i < 20; i++) {
        heldOnce ||= keys.holds(before) || keys.holds(meanwhile);
        await Promise.resolve();
      }
    })();
    vault.go();
    await writing;
    await watch;
    expect(heldOnce).toBe(false);
    expect(keys.holds(before) || keys.holds(meanwhile)).toBe(false);
    expect(quiet).toBe(true);
    expect(keys.holds(keys.ticket("api"))).toBe(true);
  });

  it("ends a change whose write failed, so the key after it holds", async () => {
    const keys = new RuntimeKeys();
    await expect(
      keys.change("api", async () => {
        throw new Error("vault refused");
      }),
    ).rejects.toThrow("vault refused");
    expect(keys.holds(keys.ticket("api"))).toBe(true);
    await keys.quiet("api");
  });
});
