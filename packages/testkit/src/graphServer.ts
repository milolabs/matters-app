import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/** One request the stand-in was given. The token is not kept: `bearer` says whether it matched. */
export interface GraphServerRequest {
  readonly method: string;
  /** Path and query as sent, below `/v1.0`, decoded: `/me/messages/abc/$value`. */
  readonly path: string;
  readonly prefer: string;
  readonly contentType: string;
  /** The `Authorization` header was a bearer token the stand-in accepts. */
  readonly bearer: boolean;
}

/** An answer the stand-in gives instead of the real one, once, to the first request it matches. */
export interface ScriptedGraphRefusal {
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
  /** Seconds, sent as `Retry-After`. */
  readonly retryAfterS?: number;
  /**
   * Instead of an answer, the connection is cut: before the request body was read, or after it
   * was read in full.
   */
  readonly drop?: "beforeBody" | "afterBody";
  /** Which request it is for; any request when absent. */
  readonly match?: (request: GraphServerRequest) => boolean;
}

/** One message `sendMail` was given, decoded from base64. */
export interface GraphSentMail {
  readonly mime: string;
  /** Addresses of its `Bcc` header, lower case. */
  readonly bcc: readonly string[];
}

export interface StandInGraphMessage {
  readonly id: string;
  folderId: string;
  readonly mime: Uint8Array;
  isRead: boolean;
  flagged: boolean;
  readonly receivedMs: number;
  /** Bumped by every change the folder's delta reports. */
  changedSeq: number;
}

export interface StandInGraphFolder {
  readonly id: string;
  readonly displayName: string;
  readonly parentId: string | null;
  readonly wellKnownName?: string;
}

export interface StandInGraphServer {
  /** Pass this as the adapter's `baseUrl`: `http://127.0.0.1:<port>/v1.0`. */
  readonly baseUrl: string;
  /** Bearer tokens it takes; add or remove to script refusals of a token. */
  readonly tokens: Set<string>;
  /** Folder ids of the well-known folders: `inbox`, `sentitems`, `drafts`, `deleteditems`, `junkemail`, `archive`. */
  readonly wellKnown: Readonly<Record<string, string>>;
  readonly folders: Map<string, StandInGraphFolder>;
  readonly messages: Map<string, StandInGraphMessage>;
  /** Every request, in order. */
  readonly requests: GraphServerRequest[];
  /** What `sendMail` was given, in order. */
  readonly sent: GraphSentMail[];
  /** Answered first, first in first out, each to the first request it matches. */
  readonly refusals: ScriptedGraphRefusal[];
  /** Largest page a delta round gives, whatever `odata.maxpagesize` asks. */
  maxPageSize: number;
  /**
   * Properties a delta row of a message leaves out, as a row may carry only what changed (the
   * delta query overview); `GET /me/messages/{id}` still has them.
   */
  readonly deltaOmits: Set<string>;
  /** Links in answers start with this; a test sets another host to try the adapter's guard. */
  linkBase: string;
  /** Largest `sendMail` body taken (base64 characters); beyond it `413`. */
  maxSendBytes: number;
  addFolder(displayName: string, parentId?: string | null): string;
  /** A new message in a folder (an id or a well-known name). Returns its immutable id. */
  addMessage(
    folder: string,
    mime: string | Uint8Array,
    options?: {
      readonly isRead?: boolean;
      readonly flagged?: boolean;
      readonly receivedMs?: number;
    },
  ): string;
  /** Moves a message; its id stays the same (immutable ids). */
  move(id: string, folder: string): void;
  setRead(id: string, isRead: boolean): void;
  /** Deletes a message outright, as another app would. */
  remove(id: string): void;
  /** Every delta and skip token given so far stops working (410, as an expired sync state). */
  expireDeltaTokens(): void;
  /** Requests whose path contains this text. */
  requestsTo(text: string): GraphServerRequest[];
  /**
   * Resolves once no connection to the stand-in is open and what those connections sent has
   * been handled: after it, `sent` and `requests` hold everything a finished or dropped request
   * left. A connection kept alive holds it back.
   */
  settled(): Promise<void>;
  stop(): Promise<void>;
}

interface Round {
  readonly folderId: string;
  /** Rows of the round, in the order they are given. */
  readonly rows: readonly Record<string, unknown>[];
  readonly endSeq: number;
  readonly filterSinceMs: number | null;
  readonly select: readonly string[] | null;
}

const WELL_KNOWN_FOLDERS: readonly [string, string][] = [
  ["inbox", "Inbox"],
  ["sentitems", "Sent Items"],
  ["drafts", "Drafts"],
  ["deleteditems", "Deleted Items"],
  ["junkemail", "Junk Email"],
  ["archive", "Archive"],
];

const opaque = (prefix: string) => `${prefix}${randomBytes(18).toString("base64url")}=`;

function json(
  response: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const text = body === undefined ? "" : JSON.stringify(body);
  // Always JSON and never sniffed: what a request sent comes back in some answers.
  response.writeHead(status, {
    ...headers,
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  response.end(text);
}

const errorBody = (code: string, message: string) => ({ error: { code, message } });

function bccOf(mime: string): string[] {
  const head = mime.split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => /^bcc:/i.test(l));
  if (line === undefined) return [];
  return line
    .slice(4)
    .split(",")
    .map((a) => (/<([^>]+)>/.exec(a)?.[1] ?? a).trim().toLowerCase())
    .filter((a) => a !== "");
}

function messageIdOf(mime: Uint8Array): string {
  const head =
    Buffer.from(mime)
      .toString("latin1")
      .split(/\r?\n\r?\n/)[0] ?? "";
  const unfolded = head.replace(/\r?\n[ \t]+/g, " ");
  const line = unfolded.split(/\r?\n/).find((l) => /^message-id:/i.test(l));
  return line?.slice("message-id:".length).trim() ?? "";
}

/**
 * A stand-in for Microsoft Graph's mail API (ADR 0136, rule 14) on the loopback address: folders
 * and their children, messages as MIME with immutable ids, delta query per folder with skip and
 * delta tokens and `@removed`, read state, moves, delete, `sendMail` with a Sent Items copy,
 * `$filter` by `internetMessageId`, and scripted refusals. It takes only a bearer token in
 * `tokens` and requests that carry `Prefer: IdType="ImmutableId"`, and records every request.
 */
export async function startStandInGraphServer(
  options: {
    readonly token?: string;
    /**
     * Also takes a token this says yes to: a window test passes the tokens its stand-in
     * authorization server issued, which come into being while the app runs.
     */
    readonly accepts?: (token: string) => boolean;
  } = {},
): Promise<StandInGraphServer> {
  let seq = 0;
  const removedLog = new Map<string, { id: string; seq: number }[]>();
  const deltaTokens = new Map<
    string,
    { folderId: string; seq: number; filterSinceMs: number | null; select: string[] | null }
  >();
  const skipTokens = new Map<string, { round: Round; offset: number }>();
  const wellKnown: Record<string, string> = {};

  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent)
        json(response, 500, errorBody("InternalServerError", "The stand-in failed."));
      else response.destroy();
    });
  });
  const open = new Set<Socket>();
  const waitingForNone: (() => void)[] = [];
  server.on("connection", (socket) => {
    open.add(socket);
    socket.once("close", () => {
      open.delete(socket);
      if (open.size > 0) return;
      // One turn more, for the handler of what the last connection sent.
      setImmediate(() => {
        if (open.size === 0) for (const done of waitingForNone.splice(0)) done();
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}/v1.0`;

  const folderOf = (name: string): StandInGraphFolder | undefined =>
    self.folders.get(wellKnown[name.toLowerCase()] ?? name);

  const self: StandInGraphServer = {
    baseUrl,
    tokens: new Set([options.token ?? "graph-test-token"]),
    wellKnown,
    folders: new Map(),
    messages: new Map(),
    requests: [],
    sent: [],
    refusals: [],
    maxPageSize: 1000,
    deltaOmits: new Set(),
    linkBase: baseUrl,
    maxSendBytes: 4 * 1024 * 1024,
    addFolder(displayName, parentId = null) {
      const id = opaque("AAMkFolder");
      self.folders.set(id, { id, displayName, parentId });
      removedLog.set(id, []);
      return id;
    },
    addMessage(folder, mime, opts = {}) {
      const target = folderOf(folder);
      if (!target) throw new Error(`no folder ${folder}`);
      const id = opaque("AAMkMessage");
      self.messages.set(id, {
        id,
        folderId: target.id,
        mime: typeof mime === "string" ? Buffer.from(mime) : mime,
        isRead: opts.isRead ?? false,
        flagged: opts.flagged ?? false,
        receivedMs: opts.receivedMs ?? Date.now() + seq,
        changedSeq: ++seq,
      });
      return id;
    },
    move(id, folder) {
      const m = self.messages.get(id);
      const target = folderOf(folder);
      if (!m || !target) throw new Error(`cannot move ${id} to ${folder}`);
      if (m.folderId === target.id) return;
      removedLog.get(m.folderId)?.push({ id, seq: ++seq });
      m.folderId = target.id;
      m.changedSeq = ++seq;
    },
    setRead(id, isRead) {
      const m = self.messages.get(id);
      if (!m) throw new Error(`no message ${id}`);
      m.isRead = isRead;
      m.changedSeq = ++seq;
    },
    remove(id) {
      const m = self.messages.get(id);
      if (!m) return;
      self.messages.delete(id);
      removedLog.get(m.folderId)?.push({ id, seq: ++seq });
    },
    expireDeltaTokens() {
      deltaTokens.clear();
      skipTokens.clear();
    },
    requestsTo(text) {
      return self.requests.filter((r) => r.path.includes(text));
    },
    settled: () =>
      new Promise<void>((resolve) => {
        if (open.size === 0) setImmediate(resolve);
        else waitingForNone.push(resolve);
      }),
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
  for (const [name, displayName] of WELL_KNOWN_FOLDERS) {
    const id = self.addFolder(displayName);
    wellKnown[name] = id;
    self.folders.set(id, { id, displayName, parentId: null, wellKnownName: name });
  }

  function row(m: StandInGraphMessage, select: readonly string[] | null): Record<string, unknown> {
    const full: Record<string, unknown> = {
      id: m.id,
      isRead: m.isRead,
      isDraft: false,
      flag: { flagStatus: m.flagged ? "flagged" : "notFlagged" },
      receivedDateTime: new Date(m.receivedMs).toISOString(),
      parentFolderId: m.folderId,
      internetMessageId: messageIdOf(m.mime),
    };
    if (select === null) return full;
    const out: Record<string, unknown> = { id: m.id };
    for (const key of select) if (key in full) out[key] = full[key];
    return out;
  }

  function folderJson(f: StandInGraphFolder) {
    return {
      id: f.id,
      displayName: f.displayName,
      parentFolderId: f.parentId,
      childFolderCount: [...self.folders.values()].filter((c) => c.parentId === f.id).length,
    };
  }

  function startRound(
    folderId: string,
    sinceSeq: number | null,
    filterSinceMs: number | null,
    select: string[] | null,
  ): Round {
    const inFolder = [...self.messages.values()]
      .filter((m) => m.folderId === folderId)
      .filter((m) => sinceSeq === null || m.changedSeq > sinceSeq)
      .filter((m) => filterSinceMs === null || m.receivedMs >= filterSinceMs || sinceSeq !== null)
      .sort((a, b) => b.receivedMs - a.receivedMs);
    const present = new Set(inFolder.map((m) => m.id));
    const removed =
      sinceSeq === null
        ? []
        : (removedLog.get(folderId) ?? [])
            .filter((r) => r.seq > sinceSeq && !present.has(r.id))
            .filter((r) => self.messages.get(r.id)?.folderId !== folderId)
            .map((r) => r.id);
    return {
      folderId,
      rows: [
        ...inFolder.map((m) => row(m, select)),
        ...[...new Set(removed)].map((id) => ({ id, "@removed": { reason: "deleted" } })),
      ],
      endSeq: seq,
      filterSinceMs,
      select,
    };
  }

  function pageOf(state: { round: Round; offset: number }, pageSize: number) {
    const { round } = state;
    const size = Math.max(1, Math.min(pageSize, self.maxPageSize));
    const rows = round.rows.slice(state.offset, state.offset + size).map((r) => {
      if (r["@removed"] !== undefined || self.deltaOmits.size === 0) return r;
      return Object.fromEntries(Object.entries(r).filter(([key]) => !self.deltaOmits.has(key)));
    });
    const offset = state.offset + rows.length;
    const path = `${self.linkBase}/me/mailFolders/${encodeURIComponent(round.folderId)}/messages/delta`;
    if (offset < round.rows.length) {
      const token = randomBytes(9).toString("hex");
      skipTokens.set(token, { round, offset });
      return { value: rows, "@odata.nextLink": `${path}?$skiptoken=${token}` };
    }
    const token = randomBytes(9).toString("hex");
    deltaTokens.set(token, {
      folderId: round.folderId,
      seq: round.endSeq,
      filterSinceMs: round.filterSinceMs,
      select: round.select ? [...round.select] : null,
    });
    return { value: rows, "@odata.deltaLink": `${path}?$deltatoken=${token}` };
  }

  async function readBody(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", baseUrl);
    const path =
      decodeURIComponent(url.pathname.replace(/^\/v1\.0/, "")) + decodeURIComponent(url.search);
    const prefer = String(request.headers.prefer ?? "");
    const auth = String(request.headers.authorization ?? "");
    const presented = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
    const bearer =
      presented !== undefined &&
      (self.tokens.has(presented) || options.accepts?.(presented) === true);
    const seen: GraphServerRequest = {
      method: request.method ?? "GET",
      path,
      prefer,
      contentType: String(request.headers["content-type"] ?? ""),
      bearer,
    };
    self.requests.push(seen);

    const scripted = self.refusals.findIndex((r) => r.match === undefined || r.match(seen));
    if (scripted >= 0) {
      const [refusal] = self.refusals.splice(scripted, 1);
      if (refusal?.drop === "beforeBody") {
        request.socket.destroy();
        return;
      }
      if (refusal?.drop === "afterBody") {
        await readBody(request);
        request.socket.destroy();
        return;
      }
      await readBody(request);
      const status = refusal?.status ?? 500;
      json(
        response,
        status,
        errorBody(refusal?.code ?? `Status${status}`, refusal?.message ?? "Scripted refusal."),
        refusal?.retryAfterS === undefined ? {} : { "retry-after": String(refusal.retryAfterS) },
      );
      return;
    }

    if (!bearer) {
      await readBody(request);
      json(
        response,
        401,
        errorBody("InvalidAuthenticationToken", "Access token is empty or invalid."),
      );
      return;
    }
    if (!/IdType="ImmutableId"/.test(prefer)) {
      await readBody(request);
      // The stand-in's own refusal: the real service answers with mutable ids instead.
      json(
        response,
        400,
        errorBody("StandInNeedsImmutableIds", 'Prefer: IdType="ImmutableId" is missing.'),
      );
      return;
    }
    const segments = url.pathname
      .replace(/^\/v1\.0\/me\//, "")
      .split("/")
      .map((s) => decodeURIComponent(s));
    const method = request.method ?? "GET";
    const query = url.searchParams;
    const pageSize = Number(/odata\.maxpagesize=(\d+)/.exec(prefer)?.[1] ?? "10");

    const body = await readBody(request);
    let sentJson: Record<string, unknown> = {};
    if (seen.contentType.startsWith("application/json")) {
      try {
        sentJson = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
      } catch {
        json(response, 400, errorBody("BadRequest", "Unreadable JSON."));
        return;
      }
    }

    // POST /me/sendMail
    if (method === "POST" && segments.length === 1 && segments[0] === "sendMail") {
      if (!seen.contentType.startsWith("text/plain")) {
        json(response, 400, errorBody("RequestBodyRead", "Expected MIME as text/plain."));
        return;
      }
      if (body.length > self.maxSendBytes) {
        json(response, 413, errorBody("RequestEntityTooLarge", "The request is too large."));
        return;
      }
      const text = body.toString("latin1");
      if (!/^[A-Za-z0-9+/=\r\n]*$/.test(text) || text.replace(/[\r\n]/g, "").length % 4 !== 0) {
        json(
          response,
          400,
          errorBody(
            "ErrorMimeContentInvalidBase64String",
            "Invalid base64 string for MIME content.",
          ),
        );
        return;
      }
      const mime = Buffer.from(text, "base64");
      self.sent.push({ mime: mime.toString("utf8"), bcc: bccOf(mime.toString("utf8")) });
      self.addMessage("sentitems", mime, { isRead: true });
      response.writeHead(202);
      response.end();
      return;
    }

    if (segments[0] === "mailFolders") {
      // GET /me/mailFolders
      if (segments.length === 1 && method === "GET") {
        const all = [...self.folders.values()].filter((f) => f.parentId === null);
        const skip = Number(query.get("$skip") ?? "0");
        const top = 4;
        const page = all.slice(skip, skip + top);
        json(response, 200, {
          value: page.map(folderJson),
          ...(skip + top < all.length
            ? { "@odata.nextLink": `${self.linkBase}/me/mailFolders?$skip=${skip + top}` }
            : {}),
        });
        return;
      }
      const folder = folderOf(segments[1] ?? "");
      if (!folder) {
        json(
          response,
          404,
          errorBody("ErrorItemNotFound", "The specified object was not found in the store."),
        );
        return;
      }
      if (segments.length === 2 && method === "GET") {
        json(response, 200, folderJson(folder));
        return;
      }
      if (segments[2] === "childFolders" && method === "GET") {
        json(response, 200, {
          value: [...self.folders.values()].filter((f) => f.parentId === folder.id).map(folderJson),
        });
        return;
      }
      if (segments[2] === "messages" && segments[3] === "delta" && method === "GET") {
        const skipToken = query.get("$skiptoken");
        const deltaToken = query.get("$deltatoken");
        if (skipToken !== null) {
          const state = skipTokens.get(skipToken);
          if (!state) {
            json(response, 410, errorBody("SyncStateNotFound", "The sync state was not found."));
            return;
          }
          json(response, 200, pageOf(state, pageSize));
          return;
        }
        if (deltaToken !== null) {
          const state = deltaTokens.get(deltaToken);
          if (!state || state.folderId !== folder.id) {
            json(response, 410, errorBody("SyncStateNotFound", "The sync state was not found."));
            return;
          }
          const round = startRound(folder.id, state.seq, state.filterSinceMs, state.select);
          json(response, 200, pageOf({ round, offset: 0 }, pageSize));
          return;
        }
        const filter = query.get("$filter");
        const since = filter === null ? null : /receivedDateTime ge (\S+)/.exec(filter)?.[1];
        const select = query.get("$select");
        const round = startRound(
          folder.id,
          null,
          since ? Date.parse(since) : null,
          select ? select.split(",") : null,
        );
        json(response, 200, pageOf({ round, offset: 0 }, pageSize));
        return;
      }
      if (segments[2] === "messages" && segments.length === 3 && method === "GET") {
        const filter = query.get("$filter") ?? "";
        const match = /^internetMessageId eq '((?:[^']|'')*)'$/.exec(filter);
        const wanted = match?.[1]?.replaceAll("''", "'");
        const found = [...self.messages.values()].filter(
          (m) =>
            m.folderId === folder.id && (wanted === undefined || messageIdOf(m.mime) === wanted),
        );
        json(response, 200, { value: found.map((m) => ({ id: m.id })) });
        return;
      }
    }

    if (segments[0] === "messages" && segments[1] !== undefined) {
      const m = self.messages.get(segments[1]);
      if (!m) {
        json(
          response,
          404,
          errorBody("ErrorItemNotFound", "The specified object was not found in the store."),
        );
        return;
      }
      if (segments.length === 2 && method === "GET") {
        const select = query.get("$select");
        json(response, 200, row(m, select ? select.split(",") : null));
        return;
      }
      if (segments[2] === "$value" && method === "GET") {
        response.writeHead(200, { "content-type": "text/plain" });
        response.end(Buffer.from(m.mime));
        return;
      }
      if (segments.length === 2 && method === "PATCH") {
        if (typeof sentJson.isRead === "boolean" && sentJson.isRead !== m.isRead) {
          self.setRead(m.id, sentJson.isRead);
        }
        json(response, 200, row(m, null));
        return;
      }
      if (segments[2] === "move" && method === "POST") {
        const destination = folderOf(String(sentJson.destinationId ?? ""));
        if (!destination) {
          json(response, 400, errorBody("ErrorInvalidIdMalformed", "Id is malformed."));
          return;
        }
        self.move(m.id, destination.id);
        json(response, 201, row(m, null));
        return;
      }
      // The real service keeps answering for a deleted message by its id for a while (it moves
      // to the recoverable items, or with `permanentDelete` beyond the person's reach); here both
      // take it out of the mailbox, and `requests` tells a test which one was asked.
      if (
        (segments.length === 2 && method === "DELETE") ||
        (segments[2] === "permanentDelete" && method === "POST")
      ) {
        self.remove(m.id);
        response.writeHead(204);
        response.end();
        return;
      }
    }
    json(response, 400, errorBody("BadRequest", `The stand-in does not know ${method} ${path}.`));
  }

  return self;
}
