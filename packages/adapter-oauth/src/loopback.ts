import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { sameSecret } from "./pkce.ts";

/** Runs `run` after `ms`; returns what cancels it. Tests pass a manual clock's. */
export type Schedule = (run: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** How long the listener waits for the browser (ADR 0133, rule 2). */
export const REDIRECT_TIMEOUT_MS = 5 * 60_000;

/** What came back to the loopback address, or why nothing did. */
export type RedirectAnswer =
  | { readonly kind: "code"; readonly code: string }
  /** The authorization server's `error`, with its description when it gave one. */
  | { readonly kind: "error"; readonly error: string; readonly description?: string }
  /** Five minutes passed, or the sign-in was cancelled. */
  | { readonly kind: "ended"; readonly why: "timeout" | "aborted" };

export interface RedirectListener {
  /** `http://localhost:<port>/`, the redirect the authorization request names. */
  readonly redirectUri: string;
  readonly port: number;
  /** Whether `::1` listens too, on the same port. */
  readonly ipv6: boolean;
  /** Settles once; never rejects. The listener is closed by then. */
  readonly answer: Promise<RedirectAnswer>;
  /** Closes now; a pending answer becomes `aborted`. */
  close(): void;
}

export interface ListenOptions {
  readonly state: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly schedule?: Schedule;
  /** Tests only: the port to try first; the system picks otherwise, and after a taken one. */
  readonly port?: number;
}

const BIND_TRIES = 5;

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

/**
 * Listens on `127.0.0.1` at `port` (0: the system picks) and on `::1` at the same port.
 * `taken` when IPv4 took the port but another program holds it on `::1`; nothing listens then.
 */
async function bindLoopback(
  handle: Handler,
  port: number,
): Promise<
  { readonly servers: Server[]; readonly port: number; readonly ipv6: boolean } | "taken"
> {
  const first = createServer(handle);
  await new Promise<void>((resolve, reject) => {
    first.once("error", reject);
    first.listen(port, "127.0.0.1", () => {
      first.off("error", reject);
      resolve();
    });
  });
  first.on("error", () => {});
  const actual = (first.address() as AddressInfo).port;
  const second = createServer(handle);
  const ipv6 = await new Promise<true | string>((resolve) => {
    second.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? "error"));
    second.listen(actual, "::1", () => resolve(true));
  });
  if (ipv6 === true) {
    second.on("error", () => {});
    return { servers: [first, second], port: actual, ipv6: true };
  }
  if (ipv6 === "EADDRINUSE") {
    await new Promise<void>((resolve) => first.close(() => resolve()));
    return "taken";
  }
  return { servers: [first], port: actual, ipv6: false };
}

/** The plain page the browser shows; it says nothing of the result (rule 2). */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Matters</title></head>
<body style="font: 15px system-ui, sans-serif; margin: 3em; max-width: 32em">
<p>You can close this tab and go back to Matters.</p>
</body></html>
`;

/**
 * Listens for the one answer of a browser sign-in (ADR 0133, rule 2; RFC 8252, section 7.3):
 * on `127.0.0.1` at a port the system picks and, where the system has it, on `::1` at the same
 * port, so `localhost` reaches it whichever address the browser tries first. It takes one GET of
 * `/` whose `state` matches, answers it with a plain page, and closes. Anything else gets 404 and
 * changes nothing, so a page that guesses the port cannot end the sign-in. It closes after
 * 5 minutes, or when `signal` aborts.
 */
export async function listenForRedirect(options: ListenOptions): Promise<RedirectListener> {
  const schedule = options.schedule ?? defaultSchedule;
  const servers: Server[] = [];
  let settle: (answer: RedirectAnswer) => void = () => {};
  let settled = false;
  let cancelTimer: () => void = () => {};
  const answer = new Promise<RedirectAnswer>((resolve) => {
    settle = (value) => {
      if (settled) return;
      settled = true;
      cancelTimer();
      options.signal?.removeEventListener("abort", onAbort);
      for (const server of servers) {
        server.close();
        server.closeAllConnections();
      }
      resolve(value);
    };
  });
  const onAbort = () => settle({ kind: "ended", why: "aborted" });

  const handle = (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    if (
      settled ||
      request.method !== "GET" ||
      url.pathname !== "/" ||
      !sameSecret(url.searchParams.get("state"), options.state)
    ) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      response.end("Not found\n");
      return;
    }
    const code = url.searchParams.get("code");
    const error = url.searchParams.get("error");
    const description = url.searchParams.get("error_description");
    const result: RedirectAnswer =
      code !== null && code !== "" && error === null
        ? { kind: "code", code }
        : {
            kind: "error",
            error: error ?? "invalid_request",
            ...(description === null ? {} : { description }),
          };
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      connection: "close",
    });
    response.end(PAGE, () => settle(result));
  };

  // A port another program holds on `::1` is not ours to share: the browser may try `::1` first
  // and hand the answer to that program. The code is useless to it without the verifier, but the
  // sign-in would never finish, so another port is taken. A system without IPv6 has no such
  // program, and the IPv4 listener is enough there.
  let bound = await bindLoopback(handle, options.port ?? 0);
  for (let tries = 1; bound === "taken" && tries < BIND_TRIES; tries++) {
    bound = await bindLoopback(handle, 0);
  }
  if (bound === "taken") throw new Error("No free loopback port for the sign-in");
  servers.push(...bound.servers);
  const { port, ipv6 } = bound;

  if (options.signal?.aborted) settle({ kind: "ended", why: "aborted" });
  else {
    options.signal?.addEventListener("abort", onAbort, { once: true });
    cancelTimer = schedule(
      () => settle({ kind: "ended", why: "timeout" }),
      options.timeoutMs ?? REDIRECT_TIMEOUT_MS,
    );
  }

  return {
    redirectUri: `http://localhost:${port}/`,
    port,
    ipv6,
    answer,
    close: () => settle({ kind: "ended", why: "aborted" }),
  };
}
