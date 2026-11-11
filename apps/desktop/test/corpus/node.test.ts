/// <reference path="../../../../packages/adapter-imap/test/hoodiecrow-imap.d.ts" />
// Corpus, node tier (ADR 0047): the real mail parser, the sender verdict, the image rules, reply
// and file-name code, over the committed messages. No network, no window. The HTML sanitizer needs
// a real browser and is exercised in tools/smoke-security.ts.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { constants, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PostalMimeParser, visibleText } from "@matters/adapter-mime";
import { registrableDomain } from "@matters/adapter-publicsuffix";
import {
  ANALYSIS_INSTRUCTIONS,
  ANALYZER_VERSION,
  acceptAnalysis,
  buildAnalysisRequest,
  decideImages,
  isRunnableFile,
  isTrustedAuthServ,
  nameFromType,
  type ParsedMessage,
  type PromptThread,
  replyRedirect,
  safeFileName,
} from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { type Check, caseBytes } from "@matters/testkit/corpus";
import { describe } from "vitest";
import { Admin } from "../../../../packages/adapter-imap/test/support/admin.ts";
import { Mailbox } from "../../../../packages/adapter-imap/test/support/harness.ts";
import { startHoodiecrow } from "../../../../packages/adapter-imap/test/support/hoodiecrow.ts";
import { mail } from "../../../../packages/adapter-imap/test/support/mail.ts";
import { textForPrompt } from "../../src/backend/agentService.ts";
import { ReceivedFiles } from "../../src/main/received.ts";
import { displayName } from "../../src/renderer/format.ts";
import { runTier } from "./support/run.ts";

const parser = new PostalMimeParser({ registrableDomain });
const OWN = ["reader@example.com"];
// "The receiving server" of the corpus (ADR 0048): the account is reader@example.com on
// imap.example.com, and its server writes `mx.example.com`. A forged header carries another id,
// `mx.example.org`, the sender's own domain.
const IMAP_HOST = "imap.example.com";
const context = {
  isTrustedAuthServ: (id: string) =>
    isTrustedAuthServ({ id, imapHost: IMAP_HOST, address: OWN[0] ?? "", registrableDomain }),
};

/** Characters that draw nothing or change what is read: controls, formats, separators, blanks. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}⠀ㅤᅟᅠﾠ  -   ]/u;

function addressIsClean(address: string): boolean {
  if (INVISIBLE.test(address) || /[<>()\\",;:\s]/.test(address)) return false;
  return address.split("@").length === 2;
}

const WINDOWS_FORBIDDEN = /[<>:"|?*\\/]/;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
function portable(name: string): boolean {
  return (
    name !== "" &&
    !INVISIBLE.test(name) &&
    !WINDOWS_FORBIDDEN.test(name) &&
    !/[. ]$/.test(name) &&
    !name.startsWith(".") &&
    !DEVICE.test(name) &&
    Buffer.byteLength(name) <= 200
  );
}

/** The real Save all over real files: every name lands inside the folder, none replaces another. */
async function saveAllSafe(names: readonly string[]): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), "matters-corpus-"));
  try {
    const cache = join(root, "cache");
    const out = join(root, "out");
    mkdirSync(out);
    names.forEach((name, i) => {
      const dir = join(cache, "1", String(i + 1));
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), `content ${i}`);
    });
    const files = new ReceivedFiles({
      cacheDir: cache,
      fetch: async () => ({ kind: "done" }),
      list: async (dir) =>
        readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          isFile: e.isFile(),
          isSymlink: e.isSymbolicLink(),
        })),
      copy: (from, to, overwrite) => copyFile(from, to, overwrite ? 0 : constants.COPYFILE_EXCL),
      quarantine: async () => {},
      openPath: async () => "",
      chooseSavePath: async () => undefined,
      chooseFolder: async () => out,
      log: () => {},
    });
    const answer = await files.saveAll(
      names.map((_, i) => ({ messageKey: 1, partId: String(i + 1) })),
    );
    if (answer.kind !== "saved" || answer.count !== names.length) return false;
    const written = readdirSync(out);
    const lower = new Set(written.map((n) => n.toLowerCase()));
    const contents = new Set(written.map((n) => readFileSync(join(out, n), "utf8")));
    return (
      written.length === names.length &&
      lower.size === written.length &&
      contents.size === names.length &&
      written.every((n) => resolve(join(out, n)).startsWith(`${resolve(out)}/`))
    );
  } catch {
    return false;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * One bad message between two good ones, through the real IMAP sync into a real database: does
 * the account still sync, and do the good messages arrive? (An in-process IMAP server.)
 */
async function syncSurvives(bytes: Buffer): Promise<{ finished: boolean; stored: number }> {
  const server = await startHoodiecrow([]);
  const admin = await Admin.connect(server.credentials);
  const box = new Mailbox(server.credentials, 20);
  try {
    await admin.append(
      "INBOX",
      mail({ id: "before", subject: "before", date: new Date(Date.UTC(2026, 10, 1, 8, 0)) }),
    );
    await admin.append("INBOX", bytes as unknown as string);
    await admin.append(
      "INBOX",
      mail({ id: "after", subject: "after", date: new Date(Date.UTC(2026, 10, 1, 9, 0)) }),
    );
    let finished = true;
    try {
      await box.sync();
    } catch {
      finished = false;
    }
    const stored = (await box.messages()).filter(
      (m) => m.subject === "before" || m.subject === "after",
    );
    return { finished, stored: stored.length };
  } finally {
    box.close();
    await admin.close();
    await server.stop();
  }
}

const PROMPT_NOW = Date.UTC(2026, 10, 5, 12);
/** Marker lines the way a reader of the prompt would see them: only white space and format characters before. */
const MARKER_LINE = /^[\s\p{Cf}]*\[Message \d+\]/u;
/** Zero-width and bidi characters, soft hyphen, and the tag characters. */
const HIDDEN_CHARS =
  /[\u00AD\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u{E0000}-\u{E007F}]/u;

interface QuoteArg {
  readonly quote: string;
  readonly message: number;
  readonly who?: "you" | "them";
}

/**
 * What a model is asked, built the way the service builds it from one parsed message (the real
 * parser, the real text selection, the real `buildAnalysisRequest`), and what the code does with an
 * answer that quotes `arg`: the real `acceptAnalysis` (ADR 0047, category `agent`).
 */
function agentMeasure(parsed: ParsedMessage | undefined, arg: (name: string) => unknown) {
  const text = parsed
    ? textForPrompt({
        text: parsed.text,
        ...(parsed.html === undefined ? {} : { html: parsed.html }),
        visibleText,
      })
    : "";
  const thread: PromptThread = {
    subject: parsed?.subject ?? "",
    messages: [
      {
        key: 1,
        dateMs: parsed?.dateMs ?? PROMPT_NOW,
        from: parsed?.from ?? { address: "unknown@example.invalid" },
        fromOwn: false,
        text,
      },
    ],
  };
  const request = buildAnalysisRequest(thread, PROMPT_NOW);
  const quoteAccepted = (name: string): boolean => {
    const a = arg(name) as QuoteArg | undefined;
    if (a === undefined) return false;
    const answer = {
      state: a.who === "you" ? "onYou" : "waiting",
      headline: "A model that followed the message",
      // The single message is the sender's, so by default the fact is the sender's own promise:
      // only the words are on trial. `who` puts the words in the person's mouth.
      facts: [{ kind: "promise", who: a.who ?? "them", message: a.message, quote: a.quote }],
      stakes: "none",
      confidence: 0.99,
      intent: "none",
      intentQuote: "",
      forYou: "generic",
      status: "open",
      category: "other",
    };
    const accepted = acceptAnalysis(answer, thread.messages, {
      threadId: "corpus",
      lastMessageKey: 1,
      analyzerVersion: ANALYZER_VERSION,
      analyzedAtMs: PROMPT_NOW,
    });
    return accepted !== null && accepted.facts.length > 0;
  };
  const marker = arg("mailOnlyInUntrusted") as string | undefined;
  const hidden = (arg("hiddenTextInPrompt") as string[] | undefined) ?? [];
  const shown = arg("visibleTextInPrompt") as string | undefined;
  return {
    promptInstructionsFixed: request.instructions === ANALYSIS_INSTRUCTIONS,
    mailOnlyInUntrusted:
      marker !== undefined &&
      request.untrusted.includes(marker) &&
      !request.instructions.includes(marker) &&
      !JSON.stringify(request.schema).includes(marker),
    promptMessageMarkers: request.untrusted.split("\n").filter((l) => MARKER_LINE.test(l)).length,
    hiddenTextInPrompt: hidden.filter((h) => request.untrusted.includes(h)),
    visibleTextInPrompt: shown !== undefined && request.untrusted.includes(shown),
    invisibleCharsInPrompt: HIDDEN_CHARS.test(request.untrusted),
    storedTextHasHiddenWords: /HIDDEN-[A-Z-]+/.test(parsed?.text ?? ""),
    fabricatedQuoteAccepted: quoteAccepted("fabricatedQuoteAccepted"),
    quoteOfMissingMessageAccepted: quoteAccepted("quoteOfMissingMessageAccepted"),
    joinedPassagesAccepted: quoteAccepted("joinedPassagesAccepted"),
    hiddenQuoteAccepted: quoteAccepted("hiddenQuoteAccepted"),
    forgedOwnPromiseAccepted: quoteAccepted("forgedOwnPromiseAccepted"),
    controlQuoteAccepted: quoteAccepted("controlQuoteAccepted"),
  };
}

const TEXT_URL = /data:(image\/[a-z+.-]+);base64/gi;

describe("corpus node tier", () => {
  runTier(
    "node",
    async (c, checks: readonly Check[]) => {
      const bytes = caseBytes(c);
      const started = performance.now();
      let parsed: ParsedMessage | undefined;
      let parseOk = true;
      try {
        parsed = await parser.parse(new Uint8Array(bytes), context);
      } catch {
        parseOk = false;
      }
      const ms = performance.now() - started;
      const from = parsed?.from;
      const label = from ? displayName(from) : "";
      const names = (parsed?.attachments ?? []).map((a) =>
        safeFileName(a.filename ?? "", nameFromType(a.mimeType)),
      );
      const arg = (name: string) =>
        checks.find((k) => k.name === name)?.arg as Record<string, string> | string | undefined;
      const message = parsed
        ? makeMessage({
            ...(from ? { from } : {}),
            replyTo: parsed.replyTo,
            senderAuth: parsed.senderAuth,
            subject: parsed.subject,
          })
        : undefined;
      const embeds = [...(parsed?.html ?? "").matchAll(TEXT_URL)].map((m) =>
        (m[1] ?? "").toLowerCase(),
      );
      const html = parsed?.html ?? "";
      const nameLooksLikeAddress = /[^\s@]+@[^\s@]+/.test(from?.name ?? "");
      const domainArg = (arg("imagesShownWithDomainRule") as Record<string, string> | undefined)
        ?.domain;

      const agent = c.category === "agent" ? agentMeasure(parsed, arg) : {};

      const wantsSync = checks.some((k) => k.name === "syncSurvives");
      const synced = wantsSync ? await syncSurvives(bytes) : { finished: true, stored: 2 };

      return {
        ...agent,
        syncSurvives: synced.finished && synced.stored === 2,
        parseOk,
        parsesWithinMs: parseOk && ms < 5000,
        fromAddress: from?.address ?? null,
        fromAddressIsNot: from?.address !== arg("fromAddressIsNot"),
        fromAddressClean: from ? addressIsClean(from.address) : true,
        fromAddressesShown: from ? [from.address] : [],
        fromDomainFlagged: from
          ? /^\p{ASCII}*$/u.test(from.address.slice(from.address.lastIndexOf("@")))
          : true,
        labelClean: !INVISIBLE.test(label),
        labelShowsAddress: from ? !nameLooksLikeAddress || label.includes(from.address) : true,
        senderAuth: parsed?.senderAuth,
        replyToAddresses: (parsed?.replyTo ?? []).map((p) => p.address),
        replyRedirectWarns: message ? replyRedirect(message, OWN) !== null : false,
        subject: parsed?.subject,
        subjectClean: !INVISIBLE.test(parsed?.subject ?? ""),
        subjectBounded: (parsed?.subject.length ?? 0) <= 1000,
        dateNotFarFuture:
          parsed?.dateMs === undefined || parsed.dateMs <= Date.now() + 2 * 86_400_000,
        referencesBounded: (parsed?.references.length ?? 0) <= 200,
        messageIdClean: !INVISIBLE.test(parsed?.messageId ?? ""),
        text: parsed?.text.trim(),
        htmlPresent: parsed?.html !== undefined,
        htmlHasScriptTag: /<script/i.test(html),
        htmlEmbeds: embeds,
        bothViewsKept: !!parsed && parsed.text.trim() !== "" && parsed.html !== undefined,
        htmlJoinsPartsInsideAttribute: /efail\?d=[^"]*SECRET-MARKER/.test(html),
        attachmentNames: names,
        attachmentNamesPortable: names.every(portable),
        attachmentNamesNonEmpty: names.every((n) => n !== ""),
        attachmentRunnable: names.map(isRunnableFile),
        attachmentCountBounded: names.length <= 1000,
        saveAllSafe: await saveAllSafe(names.slice(0, 150)),
        imagesShownWithDomainRule:
          domainArg === undefined || !from
            ? false
            : decideImages({
                address: from.address,
                domain: registrableDomain(from.address.slice(from.address.lastIndexOf("@") + 1)),
                verdict: parsed?.senderAuth ?? "unknown",
                rules: [{ scope: "domain", value: domainArg, decision: "allow", createdMs: 0 }],
                general: "ask",
              }).show,
      };
    },
    { timeoutMs: 60_000 },
  );
});
