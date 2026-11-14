import {
  errorBodyOf,
  GraphAuthError,
  GraphLinkError,
  GraphRequestError,
  GraphTokenRefusedError,
  GraphUnreachableError,
  graphSentence,
  type RefusedTokens,
  safeCode,
  scrubbed,
} from "./errors.ts";

/** Microsoft Graph v1.0: the one address the adapter sends requests to (ADR 0136, rule 12). */
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

/** Runs `run` after `ms`; returns how to cancel it. Tests pass a manual clock. */
export type Schedule = (run: () => void, ms: number) => () => void;

export const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * The address to use in place of Graph's: only a plain http address on this machine (rule 12, as
 * ADR 0133, rule 13), which is what the testkit's stand-in has. Anything else throws, so no
 * setting can send the token to another server.
 */
export function loopbackGraphBase(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("The Graph address must be a loopback http address");
  }
  if (
    parsed.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(parsed.hostname) ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new Error("The Graph address must be a loopback http address");
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
}

/** How long a `Retry-After` the adapter waits out itself; a longer one is surfaced at once. */
export const MAX_RETRY_WAIT_MS = 60_000;
/** Waits per request before a `429` or `503` is surfaced. */
export const MAX_RETRIES = 3;
/** Without `Retry-After`, a `429` or `503` waits this long. */
const DEFAULT_RETRY_MS = 5_000;

/** `Retry-After` in milliseconds: seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

export interface GraphClientOptions {
  readonly base: string;
  readonly token: string;
  readonly refused: RefusedTokens;
  readonly schedule: Schedule;
  /** Rows per delta page (`Prefer: odata.maxpagesize`). */
  readonly pageSize: number;
  /** Cuts every request of the connection short (`MailConnection.abort`). */
  readonly signal?: AbortSignal;
}

export interface GraphRequest {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly json?: unknown;
  /** Ask for this many rows per page. */
  readonly paged?: boolean;
  readonly signal?: AbortSignal;
  /** `404` comes back as an answer, not an error. */
  readonly allow404?: boolean;
  /** `403` comes back as an answer, not an error. */
  readonly allow403?: boolean;
}

export interface GraphAnswer {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Requests to Graph with one token (ADR 0136, rules 11 and 12). Every request carries
 * `Prefer: IdType="ImmutableId"`, goes to the base address only, and turns Graph's refusals
 * into errors with a `kind`; none of them holds the token. A `429` or `503` is waited out here
 * when `Retry-After` is short, a few times, then surfaced.
 */
export class GraphClient {
  readonly base: string;
  private readonly token: string;
  private readonly refused: RefusedTokens;
  private readonly schedule: Schedule;
  private readonly pageSize: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: GraphClientOptions) {
    this.base = options.base;
    this.token = options.token;
    this.refused = options.refused;
    this.schedule = options.schedule;
    this.pageSize = options.pageSize;
    this.signal = options.signal;
  }

  get secrets(): readonly string[] {
    return [this.token];
  }

  /**
   * The URL for a path under the base, or a link Graph returned, which must point at the base
   * (rule 12): anything else throws `GraphLinkError` and nothing is sent.
   */
  url(pathOrLink: string): string {
    if (pathOrLink.startsWith("/")) return `${this.base}${pathOrLink}`;
    let link: URL;
    let base: URL;
    try {
      link = new URL(pathOrLink);
      base = new URL(this.base);
    } catch {
      throw new GraphLinkError();
    }
    const prefix = `${base.pathname.replace(/\/+$/, "")}/`;
    if (
      link.origin !== base.origin ||
      link.username !== "" ||
      link.password !== "" ||
      !link.pathname.startsWith(prefix)
    ) {
      throw new GraphLinkError();
    }
    return link.href;
  }

  headers(extra: Record<string, string> = {}, paged = false): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      prefer: paged
        ? `IdType="ImmutableId", odata.maxpagesize=${this.pageSize}`
        : 'IdType="ImmutableId"',
      ...extra,
    };
  }

  /** A JSON request; the answer's body is parsed JSON, or null when there is none. */
  async json(pathOrLink: string, request: GraphRequest = {}): Promise<GraphAnswer> {
    const response = await this.send(pathOrLink, request);
    const text = await this.read(() => response.text());
    let body: unknown = null;
    if (text !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (response.ok) return { status: response.status, body };
    if (response.status === 404 && request.allow404) return { status: 404, body };
    if (response.status === 403 && request.allow403) return { status: 403, body };
    throw this.failure(response, body);
  }

  /** The answer's bytes (`$value`); null for a `404`. */
  async bytes(path: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const response = await this.send(path, signal === undefined ? {} : { signal });
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      return null;
    }
    if (!response.ok) {
      const text = await this.read(() => response.text()).catch(() => "");
      let body: unknown = null;
      try {
        body = JSON.parse(text);
      } catch {}
      throw this.failure(response, body);
    }
    return new Uint8Array(await this.read(() => response.arrayBuffer()));
  }

  /** Turns an answer that is not a success into the error rule 11 names. */
  failure(response: { status: number; headers: Headers }, body: unknown): Error {
    const status = response.status;
    const error = errorBodyOf(body);
    const code = safeCode(error.code);
    if (status === 401) {
      return this.refused.refused(this.token)
        ? new GraphAuthError(401, "signInAgain", graphSentence(error, this.secrets))
        : new GraphTokenRefusedError();
    }
    if (status === 403)
      return new GraphAuthError(403, "notAllowed", graphSentence(error, this.secrets));
    if (status === 429 || status === 503) {
      const wait = retryAfterMs(response.headers.get("retry-after"));
      return new GraphAuthError(
        status,
        status === 429 ? "throttled" : "unavailable",
        graphSentence(error, this.secrets),
        wait,
      );
    }
    return new GraphRequestError(
      `Microsoft Graph answered ${status}${code === undefined ? "" : ` (${code})`}`,
      "other",
      status,
      code,
    );
  }

  private async send(pathOrLink: string, request: GraphRequest): Promise<Response> {
    const url = this.url(pathOrLink);
    const method = request.method ?? "GET";
    const signal = joinSignals(this.signal, request.signal);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetch(url, {
          method,
          headers: this.headers(
            request.json === undefined ? {} : { "content-type": "application/json" },
            request.paged === true,
          ),
          ...(request.json === undefined ? {} : { body: JSON.stringify(request.json) }),
          ...(signal === undefined ? {} : { signal }),
          redirect: "error",
        });
      } catch (error) {
        if (signal?.aborted)
          throw new GraphUnreachableError("The request to Microsoft Graph was stopped");
        throw new GraphUnreachableError(
          `Microsoft Graph could not be reached: ${scrubbed(causeOf(error), this.secrets)}`,
        );
      }
      if (response.status !== 429 && response.status !== 503) return response;
      const wait = retryAfterMs(response.headers.get("retry-after")) ?? DEFAULT_RETRY_MS;
      if (attempt >= MAX_RETRIES || wait > MAX_RETRY_WAIT_MS) return response;
      await response.body?.cancel().catch(() => {});
      await sleep(this.schedule, wait, signal);
    }
  }

  private async read<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      throw new GraphUnreachableError(
        `The answer of Microsoft Graph broke off: ${scrubbed(causeOf(error), this.secrets)}`,
      );
    }
  }
}

/** Node's fetch hides the socket's error in `cause`. */
function causeOf(error: unknown): unknown {
  const cause = (error as { cause?: unknown } | null)?.cause;
  return cause instanceof Error ? cause : error;
}

export function joinSignals(
  a: AbortSignal | undefined,
  b: AbortSignal | undefined,
): AbortSignal | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return AbortSignal.any([a, b]);
}

/** Waits `ms` on the schedule; a fired signal ends the wait with `GraphUnreachableError`. */
export function sleep(schedule: Schedule, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new GraphUnreachableError("The request to Microsoft Graph was stopped"));
      return;
    }
    const stop = () => {
      cancel();
      reject(new GraphUnreachableError("The request to Microsoft Graph was stopped"));
    };
    const cancel = schedule(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  });
}

/** `'` doubled, as OData string literals want it. */
export function odataString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
