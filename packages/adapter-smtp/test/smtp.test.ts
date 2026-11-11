import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PostalMimeParser } from "@matters/adapter-mime";
import type { MailTarget, MimeSource, SubmitWatch } from "@matters/core";
import { bytesSource } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import { NodemailerComposer, NodemailerSubmit } from "../src/index.ts";
import { type SmtpSink, startSmtpSink } from "./support/smtpSink.ts";

const sinks: SmtpSink[] = [];
afterEach(async () => {
  for (const s of sinks.splice(0)) await s.stop();
});
const sink = async (o: Parameters<typeof startSmtpSink>[0] = {}) => {
  const s = await startSmtpSink(o);
  sinks.push(s);
  return s;
};

const target = (
  s: SmtpSink,
  over: Partial<MailTarget["server"]> = {},
  password = s.password,
): MailTarget => ({
  server: { host: s.host, port: s.port, security: "none", username: s.user, ...over },
  credential: { kind: "password", username: s.user, password },
});
const envelope = {
  from: "me@example.com",
  recipients: ["anna@northwind.example", "hidden@example.com"],
};
const raw = new TextEncoder().encode(
  "Message-ID: <x@example.com>\r\nSubject: Test\r\n\r\nHello\r\n",
);

const rawSource = bytesSource(raw);

const plain = new NodemailerSubmit({ allowInsecure: true });

describe("NodemailerComposer", () => {
  const compose = () =>
    new NodemailerComposer().compose({
      from: { name: "Miłosz Sobczak", address: "me@example.com" },
      to: [{ name: "Anna Kowalska", address: "anna@northwind.example" }],
      cc: [{ address: "boss@northwind.example" }],
      subject: "Re: Wycena zażółć",
      inReplyTo: "<a1@northwind.example>",
      references: ["<root@northwind.example>", "<a1@northwind.example>"],
      html: "<p>Cześć <strong>Anno</strong></p>",
      text: "Cześć **Anno**",
      dateMs: Date.UTC(2026, 10, 3, 12, 5, 7),
    });

  it("sets a Message-ID of our own at the sender's domain, once per message", async () => {
    const a = await compose();
    const b = await compose();
    expect(a.messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(a.messageId).not.toBe(b.messageId);
  });

  it("builds a multipart/alternative with the Markdown source as text and the HTML", async () => {
    const { raw: bytes, messageId } = await compose();
    const parsed = await new PostalMimeParser().parse(bytes);
    expect(parsed.messageId).toBe(messageId);
    expect(parsed.inReplyTo).toBe("<a1@northwind.example>");
    expect(parsed.references).toEqual(["<root@northwind.example>", "<a1@northwind.example>"]);
    expect(parsed.subject).toBe("Re: Wycena zażółć");
    expect(parsed.text.trim()).toBe("Cześć **Anno**");
    expect(parsed.from).toEqual({ name: "Miłosz Sobczak", address: "me@example.com" });
    expect(parsed.cc).toEqual([{ address: "boss@northwind.example" }]);
    const text = Buffer.from(bytes).toString("utf8");
    expect(text).toMatch(/Content-Type: multipart\/alternative/);
    expect(text).toMatch(/Content-Type: text\/plain/);
    expect(text).toMatch(/Content-Type: text\/html/);
    expect(text).toMatch(/\r\nDate: Tue, 03 Nov 2026 12:05:07 \+0000/);
  });

  it("writes no Bcc header", async () => {
    expect(Buffer.from((await compose()).raw).toString("utf8")).not.toMatch(/^bcc:/im);
  });

  it("uses CRLF line ends throughout", async () => {
    expect(Buffer.from((await compose()).raw).toString("latin1")).not.toMatch(/[^\r]\n/);
  });
});

describe("NodemailerSubmit", () => {
  it("hands over exactly the bytes it was given, with the envelope and the login", async () => {
    const s = await sink();
    const result = await plain.submit(target(s), envelope, rawSource);
    expect(result).toMatchObject({ kind: "accepted" });
    expect(s.received).toHaveLength(1);
    expect(s.received[0]).toMatchObject({
      from: "me@example.com",
      recipients: ["anna@northwind.example", "hidden@example.com"],
      user: "me",
    });
    expect(s.received[0]?.raw.toString("utf8")).toBe(Buffer.from(raw).toString("utf8"));
  });

  it("when every recipient is refused it is a definite rejection with the code", async () => {
    const s = await sink();
    s.script.rejectRcpt = () => 550;
    const result = await plain.submit(target(s), envelope, rawSource);
    expect(result).toMatchObject({ kind: "rejected", code: 550 });
    expect(s.received).toHaveLength(0);
  });

  it("when only some recipients are refused the others still get it, and the refused are named", async () => {
    const s = await sink();
    s.script.rejectRcpt = (a) => (a.startsWith("anna") ? 550 : undefined);
    const result = await plain.submit(target(s), envelope, rawSource);
    expect(result).toMatchObject({ kind: "accepted", refused: ["anna@northwind.example"] });
    expect(s.received[0]?.recipients).toEqual(["hidden@example.com"]);
  });

  it("a refusal at the end of the data is definite too, 5xx and 4xx", async () => {
    const s = await sink();
    for (const code of [554, 451]) {
      s.script.rejectData = code;
      expect(await plain.submit(target(s), envelope, rawSource)).toMatchObject({
        kind: "rejected",
        code,
      });
    }
    expect(s.received).toHaveLength(0);
  });

  it("a refused login is a rejection and never shows the password", async () => {
    const s = await sink();
    const result = await plain.submit(target(s, {}, "wrong-password-xyz"), envelope, rawSource);
    expect(result.kind).toBe("rejected");
    expect(JSON.stringify(result)).not.toContain("wrong-password-xyz");
    expect(s.received).toHaveLength(0);
  });

  it("nothing listening is a rejection (nothing was sent)", async () => {
    const s = await sink();
    const result = await plain.submit(target(s, { port: 1 }), envelope, rawSource);
    expect(result.kind).toBe("rejected");
  });

  it("a connection that dies before the data is a rejection, not an open outcome", async () => {
    const s = await sink();
    s.script.dropAtMailFrom = true;
    expect((await plain.submit(target(s), envelope, rawSource)).kind).toBe("rejected");
    expect(s.received).toHaveLength(0);
  });

  it("a connection that dies after the data is unknown, however it was received", async () => {
    const s = await sink();
    s.script.dropAfterData = true;
    const result = await plain.submit(target(s), envelope, rawSource);
    expect(result.kind).toBe("unknown");
    expect(s.received).toHaveLength(1);
  });

  it("a timeout while waiting for the answer to the data is unknown", async () => {
    const s = await sink();
    s.script.stallAfterData = true;
    const quick = new NodemailerSubmit({ allowInsecure: true, socketTimeoutMs: 400 });
    const started = Date.now();
    const result = await quick.submit(target(s), envelope, rawSource);
    expect(result.kind).toBe("unknown");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("refuses plaintext unless the test opt-in is on, without touching the server", async () => {
    const s = await sink();
    const strict = new NodemailerSubmit({ allowInsecure: false });
    const result = await strict.submit(target(s), envelope, rawSource);
    expect(result).toMatchObject({ kind: "rejected" });
    expect(s.received).toHaveLength(0);
  });

  it("honours MATTERS_ALLOW_INSECURE_SMTP=1 as the opt-in", async () => {
    const s = await sink();
    const before = process.env.MATTERS_ALLOW_INSECURE_SMTP;
    try {
      delete process.env.MATTERS_ALLOW_INSECURE_SMTP;
      expect((await new NodemailerSubmit().submit(target(s), envelope, rawSource)).kind).toBe(
        "rejected",
      );
      process.env.MATTERS_ALLOW_INSECURE_SMTP = "1";
      expect((await new NodemailerSubmit().submit(target(s), envelope, rawSource)).kind).toBe(
        "accepted",
      );
    } finally {
      if (before === undefined) delete process.env.MATTERS_ALLOW_INSECURE_SMTP;
      else process.env.MATTERS_ALLOW_INSECURE_SMTP = before;
    }
  });

  it("STARTTLS is required: a server that does not offer it is refused", async () => {
    const s = await sink({ starttls: false });
    const result = await plain.submit(target(s, { security: "starttls" }), envelope, rawSource);
    expect(result.kind).toBe("rejected");
    expect(s.received).toHaveLength(0);
  });

  it("STARTTLS works, and a certificate nobody trusts is refused", async () => {
    const s = await sink({ starttls: true });
    const trusting = new NodemailerSubmit({ tls: { rejectUnauthorized: false } });
    expect(
      (await trusting.submit(target(s, { security: "starttls" }), envelope, rawSource)).kind,
    ).toBe("accepted");
    expect(s.received).toHaveLength(1);

    const strict = new NodemailerSubmit();
    expect(
      (await strict.submit(target(s, { security: "starttls" }), envelope, rawSource)).kind,
    ).toBe("rejected");
    expect(s.received).toHaveLength(1);
  });

  it("only passwords are supported", async () => {
    const s = await sink();
    const t: MailTarget = { ...target(s), credential: { kind: "oauth2", accessToken: "tok" } };
    expect((await plain.submit(t, envelope, rawSource)).kind).toBe("rejected");
  });
});

describe("NodemailerSubmit.verify", () => {
  it("logs in without sending anything", async () => {
    const s = await sink();
    // A server that announces no SIZE has no known limit.
    expect(await plain.verify(target(s))).toEqual({ ok: true, limitBytes: null });
    expect(s.received).toEqual([]);
  });

  it("calls a wrong password a refused login, without repeating it", async () => {
    const s = await sink();
    const check = await plain.verify(target(s, {}, "wrong-secret"));
    expect(check).toMatchObject({ ok: false, kind: "auth" });
    expect(JSON.stringify(check)).not.toContain("wrong-secret");
  });

  it("calls a closed port unreachable", async () => {
    const s = await sink();
    const check = await plain.verify(target(s, { port: 1 }));
    expect(check).toMatchObject({ ok: false, kind: "unreachable" });
  });

  it("refuses an unencrypted server unless the test opt-in is set", async () => {
    const s = await sink();
    const check = await new NodemailerSubmit({ allowInsecure: false }).verify(target(s));
    expect(check).toMatchObject({ ok: false, kind: "tls" });
  });
});

/** A message of CRLF lines (no line starts with a dot), as `size` bytes in chunks of `chunk`. */
function lines(size: number): Uint8Array {
  const line = "The quick brown fox jumps over the lazy dog 0123456789\r\n";
  const bytes = new Uint8Array(size);
  const encoded = new TextEncoder().encode(line);
  for (let i = 0; i < size; i++) bytes[i] = encoded[i % encoded.length] as number;
  // end on a line end, so nothing is added to a last line
  bytes[size - 2] = 13;
  bytes[size - 1] = 10;
  return bytes;
}

function streamOf(
  bytes: Uint8Array,
  options: { chunk?: number; pauseAfterFirst?: Promise<void>; opened?: { count: number } } = {},
): MimeSource {
  const chunk = options.chunk ?? 64 * 1024;
  return {
    size: bytes.byteLength,
    open: () =>
      (async function* () {
        if (options.opened) options.opened.count++;
        for (let at = 0; at < bytes.byteLength; at += chunk) {
          yield bytes.subarray(at, at + chunk);
          if (at === 0 && options.pauseAfterFirst) await options.pauseAfterFirst;
        }
      })(),
  };
}

describe("NodemailerSubmit streams a message (ADR 0041)", () => {
  it("sends a large message exactly, with its size on MAIL FROM, and reports the bytes", async () => {
    const s = await sink({ size: 50_000_000 });
    const bytes = lines(3_000_000);
    const progress: [number, number][] = [];
    const watch: SubmitWatch = { onProgress: (sent, total) => progress.push([sent, total]) };
    const result = await plain.submit(
      target(s),
      { ...envelope, size: bytes.byteLength },
      streamOf(bytes),
      watch,
    );
    expect(result).toMatchObject({ kind: "accepted" });
    expect(s.received[0]?.declaredSize).toBe(bytes.byteLength);
    expect(Buffer.compare(s.received[0]?.raw ?? Buffer.alloc(0), Buffer.from(bytes))).toBe(0);
    // many steps, each larger than the one before, ending at the whole
    expect(progress.length).toBeGreaterThan(10);
    expect(progress.every(([, total]) => total === bytes.byteLength)).toBe(true);
    expect(progress.map(([sent]) => sent)).toEqual(
      [...progress.map(([sent]) => sent)].sort((a, b) => a - b),
    );
    expect(progress.at(-1)).toEqual([bytes.byteLength, bytes.byteLength]);
  });

  it("awaits beforeDataEnd after the last byte was read and before the server could have the end", async () => {
    const s = await sink();
    const bytes = lines(500_000);
    const seen: { sent: number; received: number }[] = [];
    let sent = 0;
    const result = await plain.submit(target(s), envelope, streamOf(bytes), {
      onProgress: (n) => {
        sent = n;
      },
      beforeDataEnd: async () => {
        await new Promise((r) => setTimeout(r, 30));
        seen.push({ sent, received: s.received.length });
      },
    });
    expect(result.kind).toBe("accepted");
    expect(seen).toEqual([{ sent: bytes.byteLength, received: 0 }]);
  });

  it("a beforeDataEnd that throws stops the send: rejected, and the server never gets the end", async () => {
    const s = await sink();
    const result = await plain.submit(target(s), envelope, rawSource, {
      beforeDataEnd: async () => {
        throw new Error("disk is full");
      },
    });
    expect(result).toMatchObject({ kind: "rejected" });
    expect((result as { reason: string }).reason).toMatch(/disk is full/);
    expect(s.received).toHaveLength(0);
  });

  it("a source that cannot be read is a rejection, not a lost connection", async () => {
    const s = await sink();
    const broken: MimeSource = {
      size: 100,
      open: () =>
        (async function* () {
          yield new Uint8Array(10);
          throw new Error("the spool file is gone");
        })(),
    };
    const result = await plain.submit(target(s), envelope, broken);
    expect(result).toMatchObject({ kind: "rejected" });
    expect((result as { reason: string }).reason).toMatch(/spool file is gone/);
    expect(s.received).toHaveLength(0);
  });

  describe("the size, before any byte", () => {
    it("a server that announces a limit is not sent a larger message at all", async () => {
      const s = await sink({ size: 100_000 });
      const opened = { count: 0 };
      const limits: (number | null)[] = [];
      const bytes = lines(500_000);
      const result = await plain.submit(
        target(s),
        { ...envelope, size: bytes.byteLength },
        streamOf(bytes, { opened }),
        { onServerLimit: (n) => limits.push(n) },
      );
      expect(result).toMatchObject({ kind: "rejected", tooLarge: true });
      expect(limits).toEqual([100_000]);
      expect(opened.count).toBe(0);
      expect(s.dataBytes()).toBe(0);
      expect(s.received).toHaveLength(0);
    });

    it("a server that refuses the declared SIZE says 552 before the data", async () => {
      // it announces a limit it does not keep to, so the refusal comes from the server
      const s = await sink({ size: 50_000_000 });
      s.script.refuseSizeAbove = 1000;
      const opened = { count: 0 };
      const bytes = lines(50_000);
      const result = await plain.submit(
        target(s),
        { ...envelope, size: bytes.byteLength },
        streamOf(bytes, { opened }),
      );
      expect(result).toMatchObject({ kind: "rejected", code: 552, tooLarge: true });
      expect(opened.count).toBe(0);
      expect(s.dataBytes()).toBe(0);
    });

    it("a message within the limit goes", async () => {
      const s = await sink({ size: 1_000_000 });
      const bytes = lines(200_000);
      const result = await plain.submit(
        target(s),
        { ...envelope, size: bytes.byteLength },
        streamOf(bytes),
      );
      expect(result.kind).toBe("accepted");
    });

    it("tells no limit when the server announces none, and the limit on verify", async () => {
      const none = await sink();
      const limits: (number | null)[] = [];
      await plain.submit(target(none), envelope, rawSource, {
        onServerLimit: (n) => limits.push(n),
      });
      expect(limits).toEqual([null]);
      const some = await sink({ size: 26_214_400 });
      expect(await plain.verify(target(some))).toEqual({ ok: true, limitBytes: 26_214_400 });
    });
  });

  describe("how far the message got decides what a broken connection means (rule 13)", () => {
    it("lost while the data goes out is interrupted: the end was never written", async () => {
      const s = await sink();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const bytes = lines(2_000_000);
      let ended = 0;
      const run = plain.submit(target(s), envelope, streamOf(bytes, { pauseAfterFirst: held }), {
        beforeDataEnd: async () => {
          ended++;
        },
      });
      await until(() => s.dataBytes() > 0);
      s.dropConnections();
      await sleep(30);
      release();
      const result = await run;
      expect(result.kind).toBe("interrupted");
      expect(ended).toBe(0);
      expect(s.received).toHaveLength(0);
    });

    it("lost after the last byte was handed over is unknown", async () => {
      const s = await sink();
      s.script.dropAfterData = true;
      let ended = 0;
      const result = await plain.submit(target(s), envelope, streamOf(lines(100_000)), {
        beforeDataEnd: async () => {
          ended++;
        },
      });
      expect(result.kind).toBe("unknown");
      expect(ended).toBe(1);
      expect(s.received).toHaveLength(1);
    });

    it("a refusal at the end of the data is still the server's answer, not a lost connection", async () => {
      const s = await sink();
      s.script.rejectData = 554;
      const result = await plain.submit(target(s), envelope, streamOf(lines(100_000)));
      expect(result).toMatchObject({ kind: "rejected", code: 554 });
    });

    it("the wait for the answer is 1 s longer for every megabyte", async () => {
      const s = await sink();
      s.script.stallAfterData = true;
      const quick = new NodemailerSubmit({ allowInsecure: true, socketTimeoutMs: 300 });
      const started = Date.now();
      const result = await quick.submit(target(s), envelope, streamOf(lines(2_000_000)));
      const waited = Date.now() - started;
      expect(result.kind).toBe("unknown");
      // 300 ms and 2 MB: not the flat 300 ms, and well under what a longer message would wait
      expect(waited).toBeGreaterThan(1800);
      expect(waited).toBeLessThan(6000);
    });
  });

  describe("abort (rules 14 and 15)", () => {
    it("closes the connection while the data goes out, and nothing is delivered", async () => {
      const s = await sink();
      const controller = new AbortController();
      let release: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const run = plain.submit(
        target(s),
        envelope,
        streamOf(lines(2_000_000), { pauseAfterFirst: held }),
        { signal: controller.signal, beforeDataEnd: async () => {} },
      );
      await until(() => s.dataBytes() > 0);
      controller.abort("stop");
      const result = await run;
      release();
      expect(result).toEqual({ kind: "aborted" });
      await until(() => s.connections().open === 0);
      expect(s.received).toHaveLength(0);
    });

    it("before it connects, it does not connect", async () => {
      const s = await sink();
      const controller = new AbortController();
      controller.abort("quit");
      const result = await plain.submit(target(s), envelope, rawSource, {
        signal: controller.signal,
      });
      expect(result).toEqual({ kind: "aborted" });
      expect(s.connections().total).toBe(0);
    });

    it("while it logs in, it stops there", async () => {
      const s = await sink();
      const controller = new AbortController();
      const run = plain.submit(target(s), envelope, rawSource, { signal: controller.signal });
      controller.abort("stop");
      expect(await run).toEqual({ kind: "aborted" });
      expect(s.received).toHaveLength(0);
    });

    it("once the data has ended it is ignored and the answer is awaited", async () => {
      const s = await sink();
      const controller = new AbortController();
      const result = await plain.submit(target(s), envelope, rawSource, {
        signal: controller.signal,
        beforeDataEnd: async () => {
          controller.abort("quit");
        },
      });
      expect(result.kind).toBe("accepted");
      expect(s.received).toHaveLength(1);
    });
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(condition: () => boolean) {
  for (let i = 0; i < 2000; i++) {
    if (condition()) return;
    await sleep(2);
  }
  throw new Error("timed out");
}

describe("NodemailerComposer.composeToStream (ADR 0041, rule 9)", () => {
  const input = {
    from: { name: "Miłosz Sobczak", address: "me@example.com" },
    to: [{ name: "Anna Kowalska", address: "anna@northwind.example" }],
    cc: [{ address: "boss@northwind.example" }],
    subject: "Re: Wycena zażółć",
    inReplyTo: "<a1@northwind.example>",
    references: ["<root@northwind.example>", "<a1@northwind.example>"],
    html: "<p>Cześć</p>",
    text: "Cześć",
    dateMs: Date.UTC(2026, 10, 3, 12, 5, 7),
  };
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), "matters-compose-"));
    dirs.push(d);
    return d;
  };
  const read = async (stream: AsyncIterable<Uint8Array>) => {
    const parts: Buffer[] = [];
    for await (const c of stream) parts.push(Buffer.from(c));
    return Buffer.concat(parts);
  };

  it("builds the same message as compose, with the file read from disk", async () => {
    const dir = temp();
    const path = join(dir, "stored-copy-id");
    const content = Buffer.from("Zawartość pliku\n".repeat(5000));
    writeFileSync(path, content);
    const composer = new NodemailerComposer();
    const { stream, messageId } = composer.composeToStream(input, [
      { path, filename: "Wycena ąę.txt" },
    ]);
    const raw = await read(stream);
    const parsed = await new PostalMimeParser().parse(new Uint8Array(raw));
    expect(parsed.messageId).toBe(messageId);
    expect(messageId).toMatch(/^<[0-9a-f-]{36}@example\.com>$/);
    expect(parsed.inReplyTo).toBe("<a1@northwind.example>");
    expect(parsed.references).toEqual(["<root@northwind.example>", "<a1@northwind.example>"]);
    expect(parsed.subject).toBe("Re: Wycena zażółć");
    expect(parsed.text.trim()).toBe("Cześć");
    expect(parsed.cc).toEqual([{ address: "boss@northwind.example" }]);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0]).toMatchObject({
      filename: "Wycena ąę.txt",
      mimeType: "text/plain",
      size: content.byteLength,
      inline: false,
    });
    const text = raw.toString("latin1");
    expect(text).toMatch(/Content-Type: multipart\/mixed/);
    expect(text).not.toMatch(/^bcc:/im);
    expect(text).not.toMatch(/[^\r]\n/);
    // the part is the file in base64, 76 characters to a line
    const wrapped = content.toString("base64").replace(/(.{76})/g, "$1\r\n");
    expect(text).toContain(wrapped.slice(0, 2000));
  });

  it("without files it is the plain multipart/alternative", async () => {
    const { stream } = new NodemailerComposer().composeToStream(input, []);
    const text = (await read(stream)).toString("utf8");
    expect(text).toMatch(/Content-Type: multipart\/alternative/);
    expect(text).not.toMatch(/multipart\/mixed/);
  });

  it("a file that is gone makes the stream fail, not the whole process", async () => {
    const { stream } = new NodemailerComposer().composeToStream(input, [
      { path: join(temp(), "nope"), filename: "x.bin" },
    ]);
    await expect(read(stream)).rejects.toBeDefined();
  });

  it("refuses a sender without a domain, like compose", () => {
    expect(() =>
      new NodemailerComposer().composeToStream({ ...input, from: { address: "nobody" } }, []),
    ).toThrow(/domain/);
  });
});
