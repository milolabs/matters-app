import type {
  Account,
  ExpungeResult,
  FlagOutcome,
  FlagResult,
  MailAttachmentPort,
  MailFlagsPort,
  MailMovePort,
  MessageLocation,
  MoveAction,
  MoveResult,
  MoveTarget,
  PartDownload,
  SentCopy,
  SentFolderPort,
  SentMatch,
} from "@matters/core";
import { type GraphClient, odataString } from "./client.ts";
import { GraphRequestError } from "./errors.ts";
import type { GraphFolders } from "./folders.ts";
import { decodePart, findPart } from "./mimeParts.ts";

const messagePath = (itemId: string) => `/me/messages/${encodeURIComponent(itemId)}`;

/** How Graph took a request about one copy (rule 7): `404` stale, `403` rejected. */
function outcomeOf(status: number): FlagOutcome {
  if (status === 404) return "stale";
  if (status === 403) return "rejected";
  return "done";
}

/** A refusal that is about the request, not the connection: a retry would be refused alike. */
function refusedRequest(error: unknown): boolean {
  return (
    error instanceof GraphRequestError &&
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 408
  );
}

/** Read state over Graph: one `PATCH` per copy (ADR 0136, rule 7). */
export class GraphFlags implements MailFlagsPort {
  private readonly client: GraphClient;

  constructor(client: GraphClient) {
    this.client = client;
  }

  async setSeen(
    locations: readonly MessageLocation[],
    seen: boolean,
  ): Promise<readonly FlagResult[]> {
    const out: FlagResult[] = [];
    for (const location of locations) {
      // A copy without an id is not Graph's: nothing here can reach it.
      if (location.itemId === undefined) {
        out.push({ location, outcome: "stale" });
        continue;
      }
      try {
        const answer = await this.client.json(messagePath(location.itemId), {
          method: "PATCH",
          json: { isRead: seen },
          allow404: true,
          allow403: true,
        });
        out.push({ location, outcome: outcomeOf(answer.status) });
      } catch (error) {
        if (refusedRequest(error)) out.push({ location, outcome: "rejected" });
        else throw error;
      }
    }
    return out;
  }
}

/** The well-known folder a role moves to (rule 7). */
const ROLE_DESTINATION = {
  inbox: "inbox",
  archive: "archive",
  trash: "deleteditems",
  spam: "junkemail",
} as const;

/**
 * Moves over Graph (ADR 0136, rule 7; ADR 0044, rules 13 to 16): `POST .../move` to a well-known
 * folder for Archive, Trash and Junk, and `DELETE` only for a copy in Deleted Items. The moved
 * copy's number is the store's to give, so `moved` comes without a location and the next sync
 * finds the copy as a known message.
 */
export class GraphMoves implements MailMovePort {
  private readonly client: GraphClient;
  private readonly folders: GraphFolders;

  constructor(client: GraphClient, folders: GraphFolders) {
    this.client = client;
    this.folders = folders;
  }

  async move(
    locations: readonly MessageLocation[],
    _action: MoveAction,
    target: MoveTarget,
  ): Promise<readonly MoveResult[]> {
    const destinationId = "role" in target ? ROLE_DESTINATION[target.role] : target.folderId;
    const out: MoveResult[] = [];
    for (const location of locations) {
      if (location.itemId === undefined) {
        out.push({ location, outcome: { kind: "stale" } });
        continue;
      }
      try {
        const answer = await this.client.json(`${messagePath(location.itemId)}/move`, {
          method: "POST",
          json: { destinationId },
          allow404: true,
          allow403: true,
        });
        const kind = outcomeOf(answer.status);
        out.push({ location, outcome: kind === "done" ? { kind: "moved" } : { kind } });
      } catch (error) {
        if (refusedRequest(error)) out.push({ location, outcome: { kind: "rejected" } });
        else throw error;
      }
    }
    return out;
  }

  async expunge(locations: readonly MessageLocation[]): Promise<readonly ExpungeResult[]> {
    const out: ExpungeResult[] = [];
    let trash: string | null | undefined;
    for (const location of locations) {
      trash ??= await this.folders.wellKnownId("deleteditems");
      // Deleting for good happens only in Deleted Items (ADR 0044, rule 16): nothing is sent.
      if (location.itemId === undefined || trash === null || location.folderId !== trash) {
        out.push({ location, outcome: "rejected" });
        continue;
      }
      try {
        // The id stays the same when the message moves (immutable ids), so `DELETE` would reach
        // it wherever it is now: it is asked where the message is first, and one restored from
        // Deleted Items meanwhile is stale here, as an expunged UID is in IMAP (rule 16).
        const where = await this.client.json(
          `${messagePath(location.itemId)}?$select=parentFolderId`,
          { allow404: true, allow403: true },
        );
        const parent = (where.body as { parentFolderId?: unknown } | null)?.parentFolderId;
        if (where.status === 403 || where.status === 404 || parent !== trash) {
          out.push({ location, outcome: where.status === 403 ? "rejected" : "stale" });
          continue;
        }
        const answer = await this.client.json(messagePath(location.itemId), {
          method: "DELETE",
          allow404: true,
          allow403: true,
        });
        out.push({ location, outcome: outcomeOf(answer.status) });
      } catch (error) {
        if (refusedRequest(error)) out.push({ location, outcome: "rejected" });
        else throw error;
      }
    }
    return out;
  }
}

/**
 * The Sent folder over Graph (ADR 0136, rule 9): Microsoft keeps the copy itself (`savesSent`),
 * so `append` is never called, and the copy is found by its `Message-ID`.
 */
export class GraphSentFolder implements SentFolderPort {
  private readonly client: GraphClient;

  constructor(client: GraphClient) {
    this.client = client;
  }

  async append(_account: Account, _raw: Uint8Array): Promise<SentCopy> {
    throw new GraphRequestError("Microsoft keeps its own copy of sent mail");
  }

  async findByMessageId(_account: Account, messageId: string): Promise<SentMatch | null> {
    const filter = encodeURIComponent(`internetMessageId eq ${odataString(messageId)}`);
    const answer = await this.client.json(
      `/me/mailFolders/sentitems/messages?$filter=${filter}&$select=id&$top=1`,
    );
    const value = (answer.body as { value?: unknown } | null)?.value;
    const first = Array.isArray(value) ? (value[0] as { id?: unknown } | undefined) : undefined;
    // The number of the copy in Sent is the store's to give: sync finds it as a known message.
    return typeof first?.id === "string" && first.id !== "" ? { providerId: first.id } : null;
  }
}

/** Slices of a decoded part handed to the reader. */
const CHUNK = 64 * 1024;

/**
 * Files over Graph (ADR 0136, rule 8): the message's MIME is fetched again and the one part is
 * cut out of it, with the part ids the sync gave (`attachmentsOfMime`). The whole message is held
 * while the part is read.
 */
export class GraphAttachments implements MailAttachmentPort {
  private readonly client: GraphClient;

  constructor(client: GraphClient) {
    this.client = client;
  }

  async download(
    location: MessageLocation,
    partId: string,
    signal?: AbortSignal,
  ): Promise<PartDownload> {
    if (location.itemId === undefined) return { kind: "gone" };
    const raw = await this.client.bytes(`${messagePath(location.itemId)}/$value`, signal);
    if (raw === null) return { kind: "gone" };
    const part = findPart(raw, partId);
    if (part === undefined) return { kind: "gone" };
    const bytes = decodePart(raw, part);
    return { kind: "found", content: slices(bytes, signal) };
  }
}

async function* slices(bytes: Uint8Array, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
  for (let at = 0; at < bytes.length; at += CHUNK) {
    if (signal?.aborted) throw new GraphRequestError("The download was stopped");
    yield bytes.subarray(at, Math.min(bytes.length, at + CHUNK));
  }
}
