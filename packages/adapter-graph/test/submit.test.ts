import type { MimeSource } from "@matters/core";
import { type StandInGraphServer, startStandInGraphServer } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import { addressesIn, bccHeader, GraphSubmitter, RefusedTokens } from "../src/index.ts";
import { instantSchedule, mail, TOKEN, target } from "./support.ts";

const servers: StandInGraphServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

async function setup() {
  const server = await startStandInGraphServer({ token: TOKEN });
  servers.push(server);
  const submitter = new GraphSubmitter({
    baseUrl: server.baseUrl,
    refusedTokens: new RefusedTokens(),
    schedule: instantSchedule(),
  });
  return { server, submitter };
}

/** The message in pieces of `chunk` bytes, as a spool file is read. */
function source(text: string, chunk = 64): MimeSource {
  const bytes = Buffer.from(text);
  return {
    size: bytes.length,
    async *open() {
      for (let at = 0; at < bytes.length; at += chunk) yield bytes.subarray(at, at + chunk);
    },
  };
}

const message = mail("out-1", {
  to: "Ann <ann@example.org>, bob@example.org",
  body: "x".repeat(5000),
});
const envelope = {
  from: "me@outlook.example",
  recipients: ["ann@example.org", "Bob@example.org", "hidden@example.net"],
};

describe("sending over Graph's sendMail (ADR 0136, rule 9)", () => {
  it("sends the MIME as base64 with a Bcc header for the hidden recipients; 202 is accepted", async () => {
    const { server, submitter } = await setup();
    const progress: number[] = [];
    let endedAt = -1;
    const result = await submitter.submit(target(), envelope, source(message), {
      onProgress: (sent) => progress.push(sent),
      beforeDataEnd: async () => {
        endedAt = progress.at(-1) ?? -1;
      },
    });
    expect(result).toEqual({ kind: "accepted", response: "202 Accepted" });
    const [sent] = server.sent;
    expect(sent?.bcc).toEqual(["hidden@example.net"]);
    expect(sent?.mime.endsWith(message)).toBe(true);
    expect(server.requestsTo("/me/sendMail")[0]).toMatchObject({
      method: "POST",
      contentType: "text/plain",
      bearer: true,
    });
    expect(progress.at(-1)).toBe(Buffer.byteLength(message));
    expect(endedAt).toBe(Buffer.byteLength(message));
    // Microsoft files the Sent copy itself.
    expect(
      [...server.messages.values()].some((m) => m.folderId === server.wellKnown.sentitems),
    ).toBe(true);
  });

  it("adds no Bcc when every recipient is in To or Cc", async () => {
    const { server, submitter } = await setup();
    await submitter.submit(
      target(),
      { ...envelope, recipients: ["ann@example.org", "bob@example.org"] },
      source(message),
    );
    expect(server.sent[0]?.bcc).toEqual([]);
    expect(server.sent[0]?.mime).toBe(message);
  });

  it("refusals: 401 and 403 rejected, 413 too large, 503 rejected, 500 unknown", async () => {
    const { server, submitter } = await setup();
    const cases: [number, string | undefined, object][] = [
      [403, "ErrorAccessDenied", { kind: "rejected", code: 403 }],
      [413, undefined, { kind: "rejected", code: 413, tooLarge: true }],
      [400, "ErrorMessageSizeExceeded", { kind: "rejected", code: 400, tooLarge: true }],
      [503, undefined, { kind: "rejected", code: 503 }],
      [500, undefined, { kind: "unknown" }],
    ];
    for (const [status, code, expected] of cases) {
      server.refusals.push({ status, ...(code === undefined ? {} : { code }) });
      expect(await submitter.submit(target(), envelope, source(message))).toMatchObject(expected);
    }
    server.tokens.clear();
    const refused = await submitter.submit(target(), envelope, source(message));
    expect(refused).toMatchObject({ kind: "rejected", code: 401 });
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    expect(server.sent).toEqual([]);
  });

  it("a connection lost after the body is unknown; before it, interrupted", async () => {
    const { server, submitter } = await setup();
    server.refusals.push({ drop: "afterBody" });
    expect(await submitter.submit(target(), envelope, source(message))).toMatchObject({
      kind: "unknown",
    });
    server.refusals.push({ drop: "beforeBody" });
    const early = await submitter.submit(target(), envelope, source(message.repeat(200), 4096));
    expect(["interrupted", "unknown"]).toContain(early.kind);
  });

  it("beforeDataEnd that throws sends no complete body: rejected", async () => {
    const { server, submitter } = await setup();
    const result = await submitter.submit(target(), envelope, source(message), {
      beforeDataEnd: async () => {
        throw new Error("the mark could not be written");
      },
    });
    expect(result).toMatchObject({ kind: "rejected" });
    expect(server.sent).toEqual([]);
  });

  it("an abort before the end of the body is aborted, and nothing is sent", async () => {
    const { server, submitter } = await setup();
    const controller = new AbortController();
    const result = await submitter.submit(target(), envelope, source(message, 512), {
      signal: controller.signal,
      onProgress: (sent) => {
        if (sent > 1000) controller.abort();
      },
    });
    expect(result).toEqual({ kind: "aborted" });
    expect(server.sent).toEqual([]);
    const already = new AbortController();
    already.abort();
    expect(
      await submitter.submit(target(), envelope, source(message), { signal: already.signal }),
    ).toEqual({ kind: "aborted" });
  });

  it("verify reads the Sent Items folder with the token", async () => {
    const { server, submitter } = await setup();
    expect(await submitter.verify(target())).toEqual({ ok: true });
    expect(server.requestsTo("/me/mailFolders/sentitems").length).toBe(1);
    server.refusals.push({ status: 403, message: "The mailbox is not enabled for this API." });
    expect(await submitter.verify(target())).toMatchObject({
      ok: false,
      kind: "auth",
      detail: { refusal: "notAllowed", serverText: "The mailbox is not enabled for this API." },
    });
    expect(
      await submitter.verify({
        server: { host: "h", port: 1, security: "tls", username: "u" },
        credential: target().credential,
      }),
    ).toMatchObject({ ok: false });
  });
});

describe("whom the headers name", () => {
  it("reads addresses from To and Cc, quoted names and comments aside", () => {
    expect(
      addressesIn('"Doe, John" <John@Example.org>, ann@example.org (Ann), "x@y" <z@example.org>'),
    ).toEqual(["john@example.org", "ann@example.org", "z@example.org"]);
    expect(
      bccHeader("To: a@example.org\r\nCc: b@example.org\r\n", [
        "a@example.org",
        "c@example.org",
        "d@example.org",
      ]),
    ).toBe("Bcc: c@example.org,\r\n d@example.org\r\n");
  });
});
