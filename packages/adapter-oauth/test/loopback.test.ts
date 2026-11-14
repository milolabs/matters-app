import { createServer } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { ManualClock } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { listenForRedirect, type RedirectListener, type Schedule } from "../src/index.ts";

const open: RedirectListener[] = [];
afterEach(() => {
  for (const l of open.splice(0)) l.close();
});

async function listen(options: { state?: string; signal?: AbortSignal; schedule?: Schedule } = {}) {
  const clock = new ManualClock();
  const listener = await listenForRedirect({
    state: options.state ?? "the-state",
    schedule: options.schedule ?? ((run, ms) => clock.setTimeout(run, ms)),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  open.push(listener);
  return { listener, clock, base: `http://127.0.0.1:${listener.port}` };
}

const pending = (p: Promise<unknown>) =>
  Promise.race([p.then(() => "settled"), new Promise((r) => setTimeout(() => r("pending"), 30))]);

describe("listenForRedirect (ADR 0133, rule 2)", () => {
  it("names http://localhost on a port the system picked", async () => {
    const { listener } = await listen();
    expect(listener.redirectUri).toBe(`http://localhost:${listener.port}/`);
    expect(listener.port).toBeGreaterThan(0);
  });

  it("takes the request whose state matches, answers a plain page, and closes", async () => {
    const { listener, base } = await listen();
    const page = await fetch(`${base}/?code=abc&state=the-state`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(await page.text()).toMatch(/go back to Matters/);
    expect(await listener.answer).toEqual({ kind: "code", code: "abc" });
    await expect(fetch(`${base}/?code=abc&state=the-state`)).rejects.toThrow();
  });

  it("listens on ::1 at the same port where the system has it", async () => {
    const { listener } = await listen();
    if (!listener.ipv6) return;
    const page = await fetch(`http://[::1]:${listener.port}/?code=six&state=the-state`);
    expect(page.status).toBe(200);
    expect(await listener.answer).toEqual({ kind: "code", code: "six" });
  });

  it("answers 404 to a wrong state, another path or another method, and keeps waiting", async () => {
    const { listener, base } = await listen();
    for (const [url, init] of [
      [`${base}/?code=abc&state=other-state`, {}],
      [`${base}/?code=abc`, {}],
      [`${base}/favicon.ico`, {}],
      [`${base}/callback?code=abc&state=the-state`, {}],
      [`${base}/?code=abc&state=the-state`, { method: "POST" }],
    ] as const) {
      expect((await fetch(url, init)).status).toBe(404);
    }
    expect(await pending(listener.answer)).toBe("pending");
    await fetch(`${base}/?code=right&state=the-state`);
    expect(await listener.answer).toEqual({ kind: "code", code: "right" });
  });

  it("answers 404 to a request line that is not a URL, and keeps waiting", async () => {
    const { listener, base } = await listen();
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = connect(listener.port, "127.0.0.1", () => {
        socket.write("GET //x:port/?state=the-state HTTP/1.1\r\nHost: localhost\r\n\r\n");
      });
      let text = "";
      socket.on("data", (chunk) => {
        text += chunk.toString("latin1");
      });
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    expect(raw).toMatch(/^HTTP\/1\.1 404/);
    expect(await pending(listener.answer)).toBe("pending");
    await fetch(`${base}/?code=right&state=the-state`);
    expect(await listener.answer).toEqual({ kind: "code", code: "right" });
  });

  it("passes the authorization server's error on", async () => {
    const { listener, base } = await listen();
    await fetch(`${base}/?error=access_denied&error_description=No+thanks&state=the-state`);
    expect(await listener.answer).toEqual({
      kind: "error",
      error: "access_denied",
      description: "No thanks",
    });
  });

  it("ends after 5 minutes", async () => {
    const { listener, clock, base } = await listen();
    expect(clock.pendingDelays()).toEqual([5 * 60_000]);
    await clock.advance(5 * 60_000 - 1);
    expect(await pending(listener.answer)).toBe("pending");
    await clock.advance(1);
    expect(await listener.answer).toEqual({ kind: "ended", why: "timeout" });
    await expect(fetch(`${base}/?code=late&state=the-state`)).rejects.toThrow();
  });

  it("ends when the signal aborts, and cancels its timer", async () => {
    const controller = new AbortController();
    const { listener, clock, base } = await listen({ signal: controller.signal });
    controller.abort();
    expect(await listener.answer).toEqual({ kind: "ended", why: "aborted" });
    expect(clock.pendingDelays()).toEqual([]);
    await expect(fetch(`${base}/?code=x&state=the-state`)).rejects.toThrow();
  });

  it("takes another port when another program holds this one on ::1", async () => {
    const other = createServer((_request, response) => response.end("not Matters"));
    const hasIpv6 = await new Promise<boolean>((resolve) => {
      other.once("error", () => resolve(false));
      other.listen({ port: 0, host: "::1", ipv6Only: true }, () => resolve(true));
    });
    if (!hasIpv6) return;
    try {
      const taken = (other.address() as AddressInfo).port;
      const listener = await listenForRedirect({ state: "the-state", port: taken });
      open.push(listener);
      expect(listener.port).not.toBe(taken);
      expect(listener.ipv6).toBe(true);
      const page = await fetch(`http://[::1]:${listener.port}/?code=abc&state=the-state`);
      expect(await page.text()).toMatch(/go back to Matters/);
      expect(await listener.answer).toEqual({ kind: "code", code: "abc" });
    } finally {
      other.close();
    }
  });

  it("ends at once for a signal that already aborted", async () => {
    const { listener } = await listen({ signal: AbortSignal.abort() });
    expect(await listener.answer).toEqual({ kind: "ended", why: "aborted" });
  });
});
