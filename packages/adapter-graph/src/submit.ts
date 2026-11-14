import { type ClientRequest, request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type {
  MailSubmitPort,
  MailTarget,
  MimeSource,
  OutgoingCheck,
  SubmitEnvelope,
  SubmitResult,
  SubmitWatch,
} from "@matters/core";
import { failureDetailOf, mailErrorKind, scrubSecrets } from "@matters/core";
import {
  defaultSchedule,
  GRAPH_BASE,
  GraphClient,
  loopbackGraphBase,
  type Schedule,
} from "./client.ts";
import { errorBodyOf, RefusedTokens, safeCode, scrubbed } from "./errors.ts";
import { headersOf } from "./mimeParts.ts";

export interface GraphSubmitterOptions {
  /** Tests only: a loopback http address in place of Graph's (rule 12). */
  readonly baseUrl?: string;
  /** Share the connector's, so both count the same refused tokens (rule 11). */
  readonly refusedTokens?: RefusedTokens;
  /** The waits of `Retry-After` while verifying; tests pass a manual clock. */
  readonly schedule?: Schedule;
  /** No answer for this long once the body is sent: the submission is `unknown`. */
  readonly answerTimeoutMs?: number;
}

const NOT_GRAPH = "This account's mail is not sent through Microsoft Graph";
/** Graph's own words for a message it does not take for its size; assumed, see the report. */
const TOO_LARGE_CODE = /MessageSizeExceeded|RequestEntityTooLarge|MessageTooLarge|SizeLimit/i;
/** The longest header block read to find who the message names. */
const MAX_HEADER_BYTES = 1024 * 1024;

/** The addresses in a list of `To` or `Cc`, lower case. */
export function addressesIn(value: string): string[] {
  const out: string[] = [];
  // Quoted names may hold commas and `@`; they are not addresses.
  const text = value.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\([^()]*\)/g, " ");
  for (const piece of text.split(",")) {
    const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(piece);
    const bare = /([^\s<>:;,]+@[^\s<>:;,]+)/.exec(piece);
    const address = angle?.[1] ?? bare?.[1];
    if (address !== undefined) out.push(address.toLowerCase());
  }
  return out;
}

/** The `Bcc` header for the recipients the headers do not name (rule 9); empty when none. */
export function bccHeader(headerBlock: string, recipients: readonly string[]): string {
  const headers = headersOf(headerBlock);
  const named = new Set([
    ...addressesIn(headers.get("to") ?? ""),
    ...addressesIn(headers.get("cc") ?? ""),
    ...addressesIn(headers.get("bcc") ?? ""),
  ]);
  const hidden = [...new Set(recipients.map((r) => r.trim()).filter((r) => r !== ""))].filter(
    (r) => !named.has(r.toLowerCase()),
  );
  // One address per line, folded, so no line runs past the limit of RFC 5322.
  return hidden.length === 0 ? "" : `Bcc: ${hidden.join(",\r\n ")}\r\n`;
}

/** Base64 of a stream of bytes, in pieces, keeping what does not fill three bytes for later. */
class Base64Stream {
  private rest = Buffer.alloc(0);

  push(chunk: Uint8Array): Buffer {
    const all = Buffer.concat([this.rest, chunk]);
    const whole = all.length - (all.length % 3);
    this.rest = all.subarray(whole);
    return Buffer.from(all.subarray(0, whole).toString("base64"), "latin1");
  }

  end(): Buffer {
    const out = Buffer.from(this.rest.toString("base64"), "latin1");
    this.rest = Buffer.alloc(0);
    return out;
  }
}

/** Where the header block of a message ends, or -1 when the bytes do not reach it yet. */
function headerEnd(bytes: Buffer): number {
  const crlf = bytes.indexOf("\r\n\r\n");
  const lf = bytes.indexOf("\n\n");
  if (crlf >= 0 && (lf < 0 || crlf <= lf)) return crlf + 2;
  return lf >= 0 ? lf + 1 : -1;
}

/**
 * `MailSubmitPort` over Graph (ADR 0136, rule 9): `POST /me/sendMail` with the composer's MIME
 * as base64 (`Content-Type: text/plain`), and a `Bcc` header in front for the envelope's
 * recipients the headers do not name. `202` is `accepted`; Microsoft files the Sent copy.
 *
 * `SubmitWatch` over one HTTP request: `onProgress` counts the message's bytes as they are
 * written; `beforeDataEnd` is awaited before the last piece of the body, which is held back, so a
 * throw there sends no complete body and is `rejected`; `signal` destroys the request until the
 * body has ended and is ignored after. What cannot be told over HTTP: whether Graph read the body
 * as it came (a refusal comes only after the whole body, unlike SMTP's before DATA), and the
 * largest message Graph takes (`onServerLimit` is never called).
 */
export class GraphSubmitter implements MailSubmitPort {
  private readonly base: string;
  private readonly refused: RefusedTokens;
  private readonly schedule: Schedule;
  private readonly answerTimeoutMs: number;

  constructor(options: GraphSubmitterOptions = {}) {
    this.base = options.baseUrl === undefined ? GRAPH_BASE : loopbackGraphBase(options.baseUrl);
    this.refused = options.refusedTokens ?? new RefusedTokens();
    this.schedule = options.schedule ?? defaultSchedule;
    this.answerTimeoutMs = options.answerTimeoutMs ?? 120_000;
  }

  private client(target: MailTarget): GraphClient | null {
    if (target.transport !== "graph" || target.credential.kind !== "oauth2") return null;
    return new GraphClient({
      base: this.base,
      token: target.credential.accessToken,
      refused: this.refused,
      schedule: this.schedule,
      pageSize: 1,
    });
  }

  async verify(target: MailTarget): Promise<OutgoingCheck> {
    const client = this.client(target);
    if (client === null) return { ok: false, kind: "other", reason: NOT_GRAPH };
    try {
      await client.json("/me/mailFolders/sentitems?$select=id");
      return { ok: true };
    } catch (error) {
      const kind = mailErrorKind(error);
      const detail = failureDetailOf(error);
      return {
        ok: false,
        kind: kind === "auth" || kind === "unreachable" ? kind : "other",
        reason: scrubbed(error, client.secrets),
        ...(detail === undefined ? {} : { detail }),
      };
    }
  }

  async submit(
    target: MailTarget,
    envelope: SubmitEnvelope,
    source: MimeSource,
    watch?: SubmitWatch,
  ): Promise<SubmitResult> {
    const client = this.client(target);
    if (client === null || target.credential.kind !== "oauth2") {
      return { kind: "rejected", reason: NOT_GRAPH };
    }
    const token = target.credential.accessToken;
    const secrets = [token];
    const signal = watch?.signal;
    if (signal?.aborted) return { kind: "aborted" };

    // The header block comes first, to know whom it names; the rest is read as it is sent.
    const iterator = source.open()[Symbol.asyncIterator]();
    let head = Buffer.alloc(0);
    let finished = false;
    try {
      while (headerEnd(head) < 0 && head.length < MAX_HEADER_BYTES) {
        const next = await iterator.next();
        if (next.done) {
          finished = true;
          break;
        }
        head = Buffer.concat([head, next.value]);
      }
    } catch (error) {
      return {
        kind: "rejected",
        reason: scrubSecrets(`The message could not be read: ${scrubbed(error, secrets)}`, secrets),
      };
    }
    const end = headerEnd(head);
    const bcc = Buffer.from(
      bccHeader(head.toString("latin1", 0, end < 0 ? head.length : end), envelope.recipients),
      "utf8",
    );
    const total = bcc.length + source.size;
    const bodyLength = 4 * Math.ceil(total / 3);
    const url = new URL(`${this.base}/me/sendMail`);

    const progress = { ended: false };
    let early: IncomingMessage | null = null;
    const ANSWERED = new Error("answered");
    const encoder = new Base64Stream();
    const request: ClientRequest = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: "POST",
      headers: {
        ...client.headers({ "content-type": "text/plain", "content-length": String(bodyLength) }),
      },
    });
    const answer = new Promise<IncomingMessage>((resolve, reject) => {
      request.once("response", resolve);
      request.once("error", reject);
    });
    answer.then(
      (response) => {
        early = response;
      },
      () => {},
    );
    const write = (chunk: Buffer) =>
      new Promise<void>((resolve, reject) => {
        if (chunk.length === 0) {
          resolve();
          return;
        }
        request.write(chunk, (error) => (error ? reject(error) : resolve()));
      });
    const onAbort = () => {
      if (!progress.ended) request.destroy(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    let sourceError: unknown;
    try {
      try {
        let held = encoder.push(Buffer.concat([bcc, head]));
        let sent = head.length;
        watch?.onProgress?.(sent, source.size);
        while (!finished) {
          let next: IteratorResult<Uint8Array>;
          try {
            next = await iterator.next();
          } catch (error) {
            sourceError = error;
            throw error;
          }
          if (next.done) break;
          // One piece is always held back: the last one goes after `beforeDataEnd`.
          await Promise.race([write(held), answer]);
          if (early !== null) throw ANSWERED;
          held = encoder.push(next.value);
          sent += next.value.byteLength;
          watch?.onProgress?.(sent, source.size);
        }
        if (sent !== source.size) {
          sourceError = new Error(`it has ${sent} bytes, not the ${source.size} announced`);
          throw sourceError;
        }
        await Promise.race([write(held), answer]);
        if (early !== null) throw ANSWERED;
        const last = encoder.end();
        try {
          await watch?.beforeDataEnd?.();
        } catch (error) {
          sourceError = error;
          throw error;
        }
        if (signal?.aborted) throw new Error("aborted");
        progress.ended = true;
        await new Promise<void>((resolve, reject) =>
          request.end(last, () => resolve()).once("error", reject),
        );
      } catch (error) {
        // Graph answered before the body ended (a refused token): that answer is the verdict.
        const answered = early as IncomingMessage | null;
        if (answered !== null) {
          const verdict = await this.verdict(answered, client, secrets);
          request.destroy();
          return verdict;
        }
        request.destroy();
        if (signal?.aborted && !progress.ended) return { kind: "aborted" };
        if (sourceError !== undefined) {
          return {
            kind: "rejected",
            reason: scrubSecrets(
              `The message could not be read: ${scrubbed(sourceError, secrets)}`,
              secrets,
            ),
          };
        }
        if (progress.ended) return { kind: "unknown", reason: scrubbed(error, secrets) };
        return {
          kind: "interrupted",
          reason: `The connection to Microsoft Graph broke before the message was sent: ${scrubbed(error, secrets)}`,
        };
      }

      // The body has ended: whatever happens now, the answer is awaited (ADR 0041, rule 15).
      let timer: (() => void) | null = null;
      try {
        const timeout = new Promise<never>((_, reject) => {
          timer = defaultSchedule(
            () => reject(new Error("No answer came in time")),
            this.answerTimeoutMs,
          );
        });
        const response = await Promise.race([answer, timeout]);
        return await this.verdict(response, client, secrets);
      } catch (error) {
        request.destroy();
        return {
          kind: "unknown",
          reason: `The connection to Microsoft Graph broke after the message was sent: ${scrubbed(error, secrets)}`,
        };
      } finally {
        (timer as (() => void) | null)?.();
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      void iterator.return?.();
    }
  }

  /** Graph's answer as a `SubmitResult`, with the care SMTP's gets. */
  private async verdict(
    response: IncomingMessage,
    client: GraphClient,
    secrets: readonly string[],
  ): Promise<SubmitResult> {
    const status = response.statusCode ?? 0;
    const text = await readText(response).catch(() => "");
    if (status >= 200 && status < 300) {
      return { kind: "accepted", response: `${status} ${response.statusMessage ?? ""}`.trim() };
    }
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {}
    const code = safeCode(errorBodyOf(body).code);
    const headers = new Headers();
    const retry = response.headers["retry-after"];
    if (typeof retry === "string") headers.set("retry-after", retry);
    const failure = client.failure({ status, headers }, body);
    // A gateway that failed after the body may have handed it on: the result is not known.
    if (status === 500 || status === 502 || status === 504) {
      return { kind: "unknown", reason: scrubbed(failure, secrets) };
    }
    return {
      kind: "rejected",
      reason: scrubbed(failure, secrets),
      code: status,
      ...(status === 413 || TOO_LARGE_CODE.test(code ?? "") ? { tooLarge: true } : {}),
    };
  }
}

async function readText(response: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response) {
    size += (chunk as Buffer).length;
    if (size > 1024 * 1024) break;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}
