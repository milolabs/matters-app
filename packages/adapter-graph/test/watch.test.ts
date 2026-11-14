import { PostalMimeParser } from "@matters/adapter-mime";
import {
  ManualClock,
  type StandInGraphServer,
  settle,
  startStandInGraphServer,
} from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { GraphConnector, RefusedTokens, WATCH_INTERVAL_MS } from "../src/index.ts";
import { mail, TOKEN, target } from "./support.ts";

const servers: StandInGraphServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Lets the clock run a poll whose requests go over real sockets. */
async function tick(clock: ManualClock, ms = WATCH_INTERVAL_MS) {
  await clock.advance(ms);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 2));
    await settle();
  }
}

async function setup(before: (server: StandInGraphServer) => void = () => {}) {
  const server = await startStandInGraphServer({ token: TOKEN });
  servers.push(server);
  before(server);
  const clock = new ManualClock();
  const connector = new GraphConnector({
    parser: new PostalMimeParser(),
    baseUrl: server.baseUrl,
    refusedTokens: new RefusedTokens(),
    schedule: (run, ms) => clock.setTimeout(run, ms),
    now: () => Date.UTC(2026, 10, 14),
  });
  const changes: number[] = [];
  const closed: unknown[] = [];
  const watch = await connector.watchInbox(target(), {
    onChange: () => changes.push(clock.now()),
    onClosed: (error) => closed.push(error),
  });
  return { server, clock, watch, changes, closed };
}

describe("watching the inbox by asking (ADR 0136, rule 10)", () => {
  it("asks the inbox's delta link every 30 seconds; only an answer with rows is a change", async () => {
    const t = await setup();
    // An old message is not news: the watch tracks mail from its start on.
    expect(t.clock.pendingDelays()).toEqual([WATCH_INTERVAL_MS]);
    await tick(t.clock);
    expect(t.changes).toEqual([]);
    t.server.addMessage("inbox", mail("new"), { receivedMs: Date.UTC(2026, 10, 15) });
    await tick(t.clock);
    expect(t.changes.length).toBe(1);
    await tick(t.clock);
    expect(t.changes.length).toBe(1);
    const asked = t.server.requestsTo("/mailFolders/inbox/messages/delta").length;
    expect(t.server.requestsTo("$deltatoken=").length).toBe(3);
    expect(asked).toBe(1);
    await t.watch.close();
    expect(t.clock.pendingDelays()).toEqual([]);
    expect(t.closed).toEqual([]);
  });

  it("says a change for mail that came while the opening round ran", async () => {
    const t = await setup((server) =>
      server.addMessage("inbox", mail("during"), { receivedMs: Date.UTC(2026, 10, 15) }),
    );
    await settle();
    expect(t.changes.length).toBe(1);
    await tick(t.clock);
    expect(t.changes.length).toBe(1);
    await t.watch.close();
  });

  it("obeys a long Retry-After, and starts over on an expired link with a change", async () => {
    const t = await setup();
    t.server.refusals.push({ status: 429, retryAfterS: 300 });
    await tick(t.clock);
    expect(t.clock.pendingDelays()).toEqual([300_000]);
    expect(t.closed).toEqual([]);
    t.server.expireDeltaTokens();
    await tick(t.clock, 300_000);
    expect(t.changes.length).toBe(1);
    expect(t.clock.pendingDelays()).toEqual([WATCH_INTERVAL_MS]);
    await t.watch.close();
  });

  it("ends with onClosed on a failure that will not pass by itself", async () => {
    const t = await setup();
    t.server.refusals.push({ status: 403, message: "Access is denied." });
    await tick(t.clock);
    expect(t.closed.length).toBe(1);
    expect((t.closed[0] as { kind: string }).kind).toBe("auth");
    expect(t.clock.pendingDelays()).toEqual([]);
  });

  it("rides out the network failing twice, and ends on the third time", async () => {
    const t = await setup();
    t.server.refusals.push({ drop: "beforeBody" }, { drop: "beforeBody" });
    await tick(t.clock);
    await tick(t.clock);
    expect(t.closed).toEqual([]);
    await tick(t.clock);
    expect(t.closed).toEqual([]);
    for (let i = 0; i < 3; i++) t.server.refusals.push({ drop: "beforeBody" });
    await tick(t.clock);
    await tick(t.clock);
    await tick(t.clock);
    expect(t.closed.length).toBe(1);
    expect((t.closed[0] as { kind: string }).kind).toBe("unreachable");
  });
});
