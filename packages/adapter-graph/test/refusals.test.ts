import { failureDetailOf, mailErrorKind } from "@matters/core";
import { describe, expect, it } from "vitest";
import { GraphConnector, loopbackGraphBase, RefusedTokens, retryAfterMs } from "../src/index.ts";
import { ACCOUNT, harness, mail, TOKEN, target } from "./support.ts";

/** Everything an error could carry to a log or a screen. */
const everything = (error: unknown) =>
  JSON.stringify({ message: (error as Error).message, ...(error as object) }) + String(error);

async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("it did not fail");
}

describe("Graph's refusals become the reasons the screens know (ADR 0136, rule 11)", () => {
  it("401: the first is retried as a failed request, the second for the same token is signInAgain", async () => {
    const h = await harness();
    h.server.addMessage("inbox", mail("a"));
    h.server.tokens.clear();
    const first = await failureOf(() => h.sync());
    expect(mailErrorKind(first)).toBe("other");
    expect((first as { name: string }).name).toBe("GraphTokenRefusedError");
    const second = await failureOf(() => h.sync());
    expect(mailErrorKind(second)).toBe("auth");
    expect(failureDetailOf(second)?.refusal).toBe("signInAgain");
    // A renewed token that works is taken at once.
    h.server.tokens.add("renewed-token");
    await h.sync("renewed-token");
    expect((await h.messages()).length).toBe(1);
    for (const e of [first, second]) expect(everything(e)).not.toContain(TOKEN);
  });

  it("403: notAllowed, with Graph's own sentence for showing and not in the message", async () => {
    const h = await harness();
    h.server.refusals.push({
      status: 403,
      code: "ErrorAccessDenied",
      message: `Access is denied. Check credentials and try again. ${TOKEN}`,
    });
    const error = await failureOf(() => h.sync());
    expect(mailErrorKind(error)).toBe("auth");
    expect(failureDetailOf(error)).toEqual({
      refusal: "notAllowed",
      serverText: "Access is denied. Check credentials and try again. ***",
    });
    expect((error as Error).message).not.toContain("Access is denied");
    expect(everything(error)).not.toContain(TOKEN);
  });

  it("429 and 503 with a short Retry-After are waited out inside the adapter", async () => {
    const h = await harness();
    h.server.addMessage("inbox", mail("a"));
    h.server.refusals.push({ status: 429, retryAfterS: 2 }, { status: 503, retryAfterS: 1 });
    await h.sync();
    expect(h.waits).toEqual([2000, 1000]);
    expect((await h.messages()).length).toBe(1);
  });

  it("429 that lasts is surfaced as throttled, 503 as unavailable; a long Retry-After at once", async () => {
    const h = await harness();
    for (let i = 0; i < 4; i++) h.server.refusals.push({ status: 429, retryAfterS: 1 });
    const throttled = await failureOf(() => h.sync());
    expect(mailErrorKind(throttled)).toBe("auth");
    expect(failureDetailOf(throttled)?.refusal).toBe("throttled");
    expect(h.waits).toEqual([1000, 1000, 1000]);

    h.server.refusals.push({ status: 503, retryAfterS: 600 });
    const unavailable = await failureOf(() => h.sync());
    expect(failureDetailOf(unavailable)?.refusal).toBe("unavailable");
    expect((unavailable as { retryAfterMs?: number }).retryAfterMs).toBe(600_000);
    expect(h.waits.length).toBe(3);
  });

  it("a dropped connection is unreachable, without the token", async () => {
    const h = await harness();
    h.server.refusals.push({ drop: "beforeBody" });
    const error = await failureOf(() => h.sync());
    expect(mailErrorKind(error)).toBe("unreachable");
    expect(everything(error)).not.toContain(TOKEN);
  });

  it("a server that cannot be reached is unreachable", async () => {
    const h = await harness();
    const baseUrl = h.server.baseUrl;
    await h.server.stop();
    const connector = new GraphConnector({ parser: { parse: async () => ({}) as never }, baseUrl });
    const connection = await connector.connect(target());
    const error = await failureOf(() => connection.sync.listFolders(ACCOUNT));
    expect(mailErrorKind(error)).toBe("unreachable");
  });

  it("410 and other failures carry the status, never Graph's text", async () => {
    const h = await harness();
    h.server.refusals.push({ status: 400, code: "BadRequest", message: `bad ${TOKEN}` });
    const error = await failureOf(() => h.sync());
    expect(mailErrorKind(error)).toBe("other");
    expect((error as Error).message).toBe("Microsoft Graph answered 400 (BadRequest)");
  });

  it("takes only a Graph target with a token", async () => {
    const h = await harness();
    await expect(
      h.connector.connect({
        server: { host: "imap.example.org", port: 993, security: "tls", username: "me" },
        credential: { kind: "password", username: "me", password: "secret" },
      }),
    ).rejects.toThrow(/does not move over Microsoft Graph/);
    await expect(
      h.connector.connect({
        transport: "graph",
        credential: { kind: "password", username: "me", password: "secret" },
      }),
    ).rejects.toMatchObject({ kind: "credentials" });
  });
});

describe("the book of refused tokens (rule 11)", () => {
  it("alone, counts a second refusal of the same token as the second", () => {
    const book = new RefusedTokens();
    expect(book.refused("t1")).toBe(false);
    expect(book.wasRefused("t1")).toBe(true);
    expect(book.refused("t1")).toBe(true);
  });

  it("with the vault renewing, ends the sign-in only when the renewed token is refused", () => {
    const book = new RefusedTokens({ renewedByVault: true });
    expect(book.refused("t1")).toBe(false);
    // Work that still held the token while the retry was fetched: retried again, not ended.
    expect(book.refused("t1")).toBe(false);
    expect(book.wasRefused("t1")).toBe(true);
    book.renewedAfterRefusal("t2");
    expect(book.wasRefused("t2")).toBe(false);
    expect(book.refused("t2")).toBe(true);
    // A vault with nothing to renew with hands out the same token: its next refusal ends it.
    expect(book.refused("t3")).toBe(false);
    book.renewedAfterRefusal("t3");
    expect(book.wasRefused("t3")).toBe(false);
    expect(book.refused("t3")).toBe(true);
  });
});

describe("the address of the service (rule 12)", () => {
  it("can be replaced only by a loopback http address", () => {
    expect(loopbackGraphBase("http://127.0.0.1:4000/v1.0/")).toBe("http://127.0.0.1:4000/v1.0");
    for (const bad of [
      "https://graph.microsoft.com/v1.0",
      "http://graph.example.org/v1.0",
      "http://user:pw@127.0.0.1/v1.0",
      "http://127.0.0.1/v1.0?x=1",
      "not a url",
    ]) {
      expect(() => loopbackGraphBase(bad)).toThrow(/loopback/);
    }
  });

  it("reads Retry-After as seconds or a date", () => {
    expect(retryAfterMs("7")).toBe(7000);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6000);
    expect(retryAfterMs(null)).toBeUndefined();
    expect(retryAfterMs("soon")).toBeUndefined();
  });
});
