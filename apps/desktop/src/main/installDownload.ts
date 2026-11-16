// The downloads of an install (ADR 0140, rule 3): one release file to a file on disk, over https,
// with redirects followed only to GitHub's hosts for release files, a size limit, a time limit,
// and a stop when no byte comes for a while or the person cancels. Electron's `net` is handed in,
// so the limits can be tested without a network. And the SHA-256 of a file on disk.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, rmSync } from "node:fs";
import {
  type DownloadLimits,
  INSTALL_MAX_REDIRECTS,
  isInstallRedirect,
  RELEASE_USER_AGENT,
} from "@matters/core";

/** What this reads of Electron's `IncomingMessage`. */
export interface DownloadResponseLike {
  readonly statusCode: number;
  readonly headers: Record<string, string | string[]>;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "end" | "aborted", listener: () => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  pause?(): unknown;
  resume?(): unknown;
}

/** What this uses of Electron's `ClientRequest`, made with `redirect: "manual"`. */
export interface DownloadRequestLike {
  setHeader(name: string, value: string): void;
  on(event: "response", listener: (response: DownloadResponseLike) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(
    event: "redirect",
    listener: (statusCode: number, method: string, redirectUrl: string) => void,
  ): unknown;
  followRedirect(): void;
  abort(): void;
  end(): void;
}

export type DownloadFailure =
  | "download"
  | "status"
  | "redirect"
  | "too-big"
  | "timeout"
  | "cancelled";

export type DownloadResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly failure: DownloadFailure };

export interface DownloadDeps {
  /** A GET of `url` with no cookies, no credentials, redirects by hand (main's `net.request`). */
  open(url: string): DownloadRequestLike;
  /** Where a redirect may lead; GitHub's hosts for release files unless a test says otherwise. */
  readonly allowRedirect?: (url: string) => boolean;
}

const header = (headers: Record<string, string | string[]>, name: string): string | null => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" ? one : null;
};

/**
 * Downloads `url` to `path`. Only a 200 is a file; a `Content-Length` over the limit is refused
 * before a byte is written, and a body that grows past it is cut off. A file that did not come
 * whole is removed. `progress` hears the bytes so far and the size the server gave.
 */
export function downloadToFile(
  deps: DownloadDeps,
  url: string,
  path: string,
  limits: DownloadLimits,
  progress: (received: number, total: number | null) => void,
  signal: AbortSignal,
): Promise<DownloadResult> {
  const allowRedirect = deps.allowRedirect ?? isInstallRedirect;
  return new Promise((resolve) => {
    let done = false;
    let request: DownloadRequestLike | null = null;
    let file: ReturnType<typeof createWriteStream> | null = null;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: DownloadResult) => {
      if (done) return;
      done = true;
      clearTimeout(whole);
      clearTimeout(idle);
      signal.removeEventListener("abort", onAbort);
      if (!result.ok) {
        try {
          request?.abort();
        } catch {
          // Already ended.
        }
      }
      const settle = () => {
        if (!result.ok) rmSync(path, { force: true });
        resolve(result);
      };
      if (file === null) settle();
      else if (result.ok) file.end(settle);
      else {
        // Closed first: a stream that is still opening would make the file after it was removed.
        file.once("close", settle);
        file.destroy();
      }
    };
    const fail = (failure: DownloadFailure) => finish({ ok: false, failure });
    const quiet = () => {
      clearTimeout(idle);
      idle = setTimeout(() => fail("timeout"), limits.idleMs);
    };
    const whole = setTimeout(() => fail("timeout"), limits.ms);
    const onAbort = () => fail("cancelled");
    if (signal.aborted) {
      fail("cancelled");
      return;
    }
    signal.addEventListener("abort", onAbort);
    quiet();
    try {
      request = deps.open(url);
    } catch {
      fail("download");
      return;
    }
    let redirects = 0;
    request.setHeader("User-Agent", RELEASE_USER_AGENT);
    request.on("redirect", (_status, _method, to) => {
      redirects += 1;
      if (redirects > INSTALL_MAX_REDIRECTS || !allowRedirect(to)) {
        fail("redirect");
        return;
      }
      quiet();
      request?.followRedirect();
    });
    request.on("error", () => fail("download"));
    request.on("response", (response) => {
      if (response.statusCode !== 200) {
        fail("status");
        return;
      }
      const said = header(response.headers, "content-length");
      const given = said !== null && /^\d{1,15}$/.test(said) ? Number(said) : null;
      const total = given !== null && Number.isSafeInteger(given) ? given : null;
      if (total !== null && total > limits.bytes) {
        fail("too-big");
        return;
      }
      const out = createWriteStream(path, { mode: 0o600 });
      file = out;
      out.on("error", () => fail("download"));
      out.on("drain", () => response.resume?.());
      let received = 0;
      progress(0, total);
      response.on("data", (chunk) => {
        if (done) return;
        quiet();
        received += chunk.length;
        if (received > limits.bytes || (total !== null && received > total)) {
          fail("too-big");
          return;
        }
        if (!out.write(chunk)) response.pause?.();
        progress(received, total);
      });
      response.on("end", () => {
        if (total !== null && received !== total) fail("download");
        else finish({ ok: true, bytes: received });
      });
      response.on("aborted", () => fail("download"));
      response.on("error", () => fail("download"));
    });
    request.end();
  });
}

/** The SHA-256 of a file, in lower-case hex. */
export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}
