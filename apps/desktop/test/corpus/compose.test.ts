// Corpus, compose tier (ADR 0047): hostile content goes through the real send path (draft, queue,
// Markdown render, MIME composer, SMTP submission) into a real SMTP server in this process, and
// the bytes it received are inspected. Only the sync connector, the clock and the file worker are fakes.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MarkdownComposeRenderer } from "@matters/adapter-compose";
import { PostalMimeParser } from "@matters/adapter-mime";
import { NodemailerComposer, NodemailerSubmit } from "@matters/adapter-smtp";
import {
  buildForward,
  buildReply,
  type DraftContent,
  type ProcessDeps,
  processOutbox,
  requestSend,
  type StoredAccount,
  saveDraft,
  UNDO_WINDOW_MS,
} from "@matters/core";
import {
  createInMemoryStorage,
  FakeFileWork,
  FakeMailConnector,
  FakeMailSync,
  InMemoryCredentialStore,
  makeMessage,
} from "@matters/testkit";
import type { Check } from "@matters/testkit/corpus";
import { afterEach, describe } from "vitest";
import {
  type SmtpSink,
  startSmtpSink,
} from "../../../../packages/adapter-smtp/test/support/smtpSink.ts";
import { runTier } from "./support/run.ts";

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⠀ㅤᅟᅠﾠ  -   ]/u;
const T0 = 1_800_000_000_000;
const sinks: SmtpSink[] = [];
afterEach(async () => {
  for (const s of sinks.splice(0)) await s.stop();
});

const ACCOUNT_ADDRESS = "me@example.com";

/** Draft in, bytes out: the whole send path against a fresh SMTP server. */
async function send(content: Partial<DraftContent>) {
  const sink = await startSmtpSink();
  sinks.push(sink);
  const storage = createInMemoryStorage();
  const account: StoredAccount = {
    id: "acc1",
    address: ACCOUNT_ADDRESS,
    displayName: "Me",
    imap: { host: "127.0.0.1", port: 1, security: "none", username: "me" },
    smtp: { host: sink.host, port: sink.port, security: "none", username: sink.user },
    createdAtMs: 1,
  };
  await storage.accounts.add(account);
  const credentials = new InMemoryCredentialStore();
  await credentials.set("acc1", { kind: "password", username: sink.user, password: sink.password });
  const state = { now: T0, ids: 0 };
  const deps: ProcessDeps = {
    drafts: storage.drafts,
    outbox: storage.outbox,
    store: storage.store,
    accounts: storage.accounts,
    credentials,
    renderer: new MarkdownComposeRenderer(),
    composer: new NodemailerComposer(),
    submit: new NodemailerSubmit({ allowInsecure: true, socketTimeoutMs: 2000 }),
    connector: new FakeMailConnector(new FakeMailSync(["INBOX", "Sent"], [])),
    ingest: storage,
    attachments: storage.attachments,
    files: new FakeFileWork(),
    carriers: [],
    sha256: (t) => createHash("sha256").update(t, "utf8").digest("hex"),
    newId: () => `id${++state.ids}`,
    now: () => state.now,
    onChange: () => {},
    onAttachmentsChanged: () => {},
    onAttachmentProgress: () => {},
    wakeOutbox: () => {},
    onTransferStart: () => {},
    onTransferEnd: () => {},
    onSendProgress: () => {},
  };
  const base: DraftContent = {
    accountId: "acc1",
    from: { name: "Me", address: ACCOUNT_ADDRESS },
    to: [{ name: "Anna", address: "anna@example.org" }],
    cc: [],
    bcc: [],
    subject: "Hello",
    bodyMarkdown: "Hi.",
    inReplyTo: "",
    references: [],
  };
  let blocked = "";
  try {
    const draft = await saveDraft(deps, { content: { ...base, ...content } });
    await requestSend(deps, draft.id);
    state.now += UNDO_WINDOW_MS + 1000;
    await processOutbox(deps, { lane: "small" });
  } catch (error) {
    // The send path itself refused the draft (a layer above the wire): nothing reaches the sink.
    blocked = error instanceof Error ? error.message : String(error);
  }
  const sent = sink.received[0];
  return { sink, sent, blocked, raw: sent ? sent.raw.toString("latin1") : "" };
}

/** A probe that expects the mail to arrive fails loudly when it did not: no check passes on silence. */
async function delivered(content: Partial<DraftContent>) {
  const r = await send(content);
  if (!r.sent)
    throw new Error(
      `the message never reached the SMTP server (send path said: ${r.blocked || "nothing"})`,
    );
  return r;
}

const parser = new PostalMimeParser();
const headerBlock = (raw: string) => raw.split(/\r?\n\r?\n/)[0] ?? "";
const headerNames = (raw: string) =>
  headerBlock(raw)
    .split(/\r?\n/)
    .filter((l) => /^[^\s]/.test(l))
    .map((l) => l.split(":")[0]?.toLowerCase() ?? "");
const injected = (raw: string) =>
  headerNames(raw).some((n) => n === "x-evil" || n === "bcc" || n === "x-injected");

const HOSTILE_NAME = "[Click here](https://example.org/x) and <b>bold</b>";
const hasWebAnchor = (html: string | undefined) => /<a\s[^>]*href="https?:/i.test(html ?? "");

async function reply(from: { name: string; address: string }, subject: string, bodyText: string) {
  const message = makeMessage({
    from,
    subject,
    messageIdHeader: "<orig@corpus.test>",
    dateMs: Date.UTC(2026, 10, 4, 10, 0),
    to: [{ name: "Me", address: ACCOUNT_ADDRESS }],
  });
  return buildReply({
    mode: "reply",
    account: { id: "acc1", address: ACCOUNT_ADDRESS, displayName: "Me" },
    ownAddresses: [],
    message,
    bodyText,
    earlier: [],
  });
}

async function probe(id: string): Promise<Record<string, unknown>> {
  switch (id) {
    case "compose-subject-crlf-injection": {
      const r = await delivered({ subject: "Hello\r\nBcc: spy@example.net\r\nX-Evil: 1" });
      return {
        injectedHeaderInSentBytes: injected(r.raw),
        bccHeaderInSentBytes: headerNames(r.raw).includes("bcc"),
      };
    }
    case "compose-display-name-crlf-injection": {
      const r = await delivered({
        from: { name: "Me\r\nX-Evil: 1", address: ACCOUNT_ADDRESS },
        to: [{ name: "A\r\nX-Evil: 2", address: "anna@example.org" }],
        cc: [{ name: "B\nX-Evil: 3", address: "bob@example.org" }],
      });
      return { injectedHeaderInSentBytes: injected(r.raw) };
    }
    case "compose-address-crlf-injection": {
      const r = await send({
        to: [{ address: "a@example.org>\r\nRSET\r\nMAIL FROM:<x@example.net" }],
      });
      const s = r.sink;
      const odd = s.received.some(
        (m) => m.recipients.some((x) => /[\r\n]/.test(x)) || /[\r\n]/.test(m.from),
      );
      return {
        extraSmtpCommandsSeen: s.received.length > 1 || odd,
        injectedHeaderInSentBytes: injected(r.raw),
      };
    }
    case "compose-bcc-never-in-bytes": {
      const r = await delivered({
        bcc: [{ name: "Hidden", address: "hidden-recipient@example.net" }],
      });
      return {
        bccAddressInSentBytes: r.raw.includes("hidden-recipient@example.net"),
        bccInEnvelope: r.sent?.recipients.includes("hidden-recipient@example.net") ?? false,
      };
    }
    case "compose-reply-attribution-name-markdown": {
      const draft = await reply(
        { name: "[Click here](https://example.org/x)", address: "orig@example.org" },
        "Question",
        "Plain text.",
      );
      const r = await delivered({ ...draft, to: [{ address: "orig@example.org" }] });
      return {
        linkInSentHtml: hasWebAnchor((await parser.parse(Buffer.from(r.raw, "latin1"))).html),
      };
    }
    case "compose-reply-quoted-body-markdown": {
      const draft = await reply(
        { name: "Orig", address: "orig@example.org" },
        "Question",
        "Please [pay here](https://example.org/p) today.",
      );
      const r = await delivered({ ...draft, to: [{ address: "orig@example.org" }] });
      return {
        linkInSentHtml: hasWebAnchor((await parser.parse(Buffer.from(r.raw, "latin1"))).html),
      };
    }
    case "compose-forward-header-escaped": {
      const message = makeMessage({
        from: { name: HOSTILE_NAME, address: "orig@example.org" },
        to: [{ name: "[x](https://example.org/y)", address: "me@example.com" }],
        subject: "[Subject](https://example.org/z) https://example.org/w",
        dateMs: Date.UTC(2026, 10, 4, 10, 0),
      });
      const draft = buildForward({
        account: { id: "acc1", address: ACCOUNT_ADDRESS, displayName: "Me" },
        message,
        bodyText: "body",
      });
      const r = await delivered({ ...draft, to: [{ address: "friend@example.org" }] });
      return {
        linkInSentHtml: hasWebAnchor((await parser.parse(Buffer.from(r.raw, "latin1"))).html),
      };
    }
    case "compose-markdown-raw-html": {
      const md = [
        "<script>parent.__pwned=1</script>",
        '<img src="http://canary.test/x" onerror="parent.__pwned=1">',
        "[x](javascript:parent.__pwned=1) [y](data:text/html;base64,eA==) [z](vbscript:x)",
        "![i](http://canary.test/img.png)",
        '<a href="javascript:1">raw</a>',
      ].join("\n\n");
      const r = await delivered({ bodyMarkdown: md });
      const html = (await parser.parse(Buffer.from(r.raw, "latin1"))).html ?? "";
      // Real elements only: escaped text such as "&lt;img onerror=" is the source shown as text.
      return {
        activeMarkupInSentHtml:
          /<script|<img|<[a-z][^>]*\son[a-z]+\s*=|href="(?:javascript|data|vbscript):/i.test(html),
      };
    }
    case "compose-reply-subject-from-hostile": {
      const draft = await reply(
        { name: "Orig", address: "orig@example.org" },
        "Invoice ‮gnp.exe‬\r\nBcc: victim@example.org",
        "text",
      );
      const r = await delivered({ ...draft, to: [{ address: "orig@example.org" }] });
      const parsed = await parser.parse(Buffer.from(r.raw, "latin1"));
      return {
        injectedHeaderInSentBytes: injected(r.raw),
        subjectClean: !INVISIBLE.test(parsed.subject),
      };
    }
    case "compose-attachment-name-injection": {
      const dir = mkdtempSync(join(tmpdir(), "matters-corpus-"));
      try {
        const file = join(dir, "data.bin");
        writeFileSync(file, "harmless corpus attachment text\n");
        const composer = new NodemailerComposer();
        const { stream } = composer.composeToStream(
          {
            from: { address: ACCOUNT_ADDRESS },
            to: [{ address: "anna@example.org" }],
            cc: [],
            subject: "files",
            inReplyTo: "",
            references: [],
            html: "<p>x</p>",
            text: "x",
            dateMs: T0,
          },
          [
            { path: file, filename: 'a"\r\nX-Evil: 1.txt' },
            { path: file, filename: "..\\..\\b\r\nBcc: spy@example.net.txt" },
          ],
        );
        const chunks: Buffer[] = [];
        for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
        const raw = Buffer.concat(chunks);
        const text = raw.toString("latin1");
        const parsed = await parser.parse(new Uint8Array(raw));
        return {
          injectedHeaderInSentBytes: /^(?:x-evil|bcc):/im.test(text),
          filenameParameterIntact:
            parsed.attachments.length === 2 &&
            parsed.attachments.every((a) => a.filename !== undefined),
        };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    case "compose-from-address-not-the-account": {
      const r = await send({ from: { name: "Me", address: "ceo@example.net" } });
      const parsed = r.raw ? await parser.parse(Buffer.from(r.raw, "latin1")) : undefined;
      return { fromInSentBytes: parsed?.from?.address ?? null };
    }
    default:
      throw new Error(`no probe for ${id}`);
  }
}

describe("corpus compose tier", () => {
  runTier("compose", async (c, _checks: readonly Check[]) => probe(c.id), { timeoutMs: 30_000 });
});
