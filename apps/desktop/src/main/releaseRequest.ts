// The one request to the project's site (ADR 0137, rules 3, 4 and 8): a GET of the release file
// that says nothing about the person, read with a size limit and a time limit. Electron's `net`
// is handed in, so the limits can be tested without a network.
import { RELEASE_FILE_LIMIT, RELEASE_TIMEOUT_MS, RELEASE_USER_AGENT } from "@matters/core";
import type { ReleaseOutcome } from "./release.ts";

/** What this reads of Electron's `IncomingMessage`. */
export interface ResponseLike {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "aborted", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}

/** What this uses of Electron's `ClientRequest`. */
export interface RequestLike {
  setHeader(name: string, value: string): void;
  on(event: "response", listener: (response: ResponseLike) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "redirect", listener: () => void): unknown;
  abort(): void;
  end(): void;
}

export interface ReleaseRequestDeps {
  /** A GET of `url` with no cookies and no credentials, redirects refused (main's `net.request`). */
  open(url: string): RequestLike;
  readonly limitBytes?: number;
  readonly timeoutMs?: number;
}

const header = (headers: Record<string, string | string[]>, name: string): string | null => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" ? one : null;
};

/**
 * Asks for the file once. `User-Agent` is the word `Matters` and nothing else; `If-None-Match` is
 * sent when an ETag is known. A body over the limit, a request that has not ended in time, a
 * redirect or an answer other than 200 or 304 is a failed check, never "newest".
 */
export function requestReleaseFile(
  deps: ReleaseRequestDeps,
  url: string,
  etag: string | null,
): Promise<ReleaseOutcome> {
  const limit = deps.limitBytes ?? RELEASE_FILE_LIMIT;
  return new Promise((resolve) => {
    let done = false;
    let request: RequestLike | null = null;
    const finish = (outcome: ReleaseOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (outcome.kind === "failed") {
        try {
          request?.abort();
        } catch {
          // Already ended.
        }
      }
      resolve(outcome);
    };
    const timer = setTimeout(
      () => finish({ kind: "failed", failure: "no-answer" }),
      deps.timeoutMs ?? RELEASE_TIMEOUT_MS,
    );
    try {
      request = deps.open(url);
    } catch {
      finish({ kind: "failed", failure: "no-answer" });
      return;
    }
    request.setHeader("User-Agent", RELEASE_USER_AGENT);
    if (etag !== null) request.setHeader("If-None-Match", etag);
    request.on("redirect", () => finish({ kind: "failed", failure: "redirect" }));
    request.on("error", (error) =>
      finish({
        kind: "failed",
        failure: /redirect/i.test(error.message) ? "redirect" : "no-answer",
      }),
    );
    request.on("response", (response) => {
      if (response.statusCode === 304) {
        finish({ kind: "same" });
        return;
      }
      if (response.statusCode !== 200) {
        finish({ kind: "failed", failure: "status" });
        return;
      }
      const length = Number(header(response.headers, "content-length") ?? "0");
      if (length > limit) {
        finish({ kind: "failed", failure: "too-big" });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > limit) finish({ kind: "failed", failure: "too-big" });
        else chunks.push(chunk);
      });
      response.on("end", () =>
        finish({
          kind: "fresh",
          text: Buffer.concat(chunks).toString("utf8"),
          etag: header(response.headers, "etag"),
        }),
      );
      response.on("aborted", () => finish({ kind: "failed", failure: "no-answer" }));
      response.on("error", () => finish({ kind: "failed", failure: "no-answer" }));
    });
    request.end();
  });
}
