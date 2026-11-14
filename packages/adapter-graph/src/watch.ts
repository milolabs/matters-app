import type { MailWatch, MailWatchHandlers } from "@matters/core";
import type { GraphClient, Schedule } from "./client.ts";
import { GraphAuthError, GraphUnreachableError } from "./errors.ts";
import { nextLinkOf } from "./folders.ts";
import { isExpiredSync } from "./sync.ts";

/** How often the inbox's delta link is asked (ADR 0136, rule 10). */
export const WATCH_INTERVAL_MS = 30_000;
/** Failures of the network in a row after which the watch ends and the caller opens another. */
const UNREACHABLE_IN_A_ROW = 3;

const deltaLinkOf = (body: unknown): string | undefined => {
  const link = (body as Record<string, unknown> | null)?.["@odata.deltaLink"];
  return typeof link === "string" && link !== "" ? link : undefined;
};

/** Pages through one round; true when any row came, and the link that starts the next. */
async function round(client: GraphClient, first: string, signal: AbortSignal) {
  let changed = false;
  for (let link = first; ; ) {
    const { body } = await client.json(link, { paged: true, signal });
    const value = (body as { value?: unknown } | null)?.value;
    if (Array.isArray(value) && value.length > 0) changed = true;
    const next = nextLinkOf(body);
    if (next !== undefined) {
      link = next;
      continue;
    }
    const delta = deltaLinkOf(body);
    if (delta === undefined)
      throw new GraphUnreachableError("Microsoft Graph ended a page without a link");
    client.url(delta);
    return { changed, delta };
  }
}

/**
 * Watches the inbox by asking (ADR 0136, rule 10): a round of delta query that tracks mail from
 * now on (`receivedDateTime ge` the start) gives a link, which is asked every 30 seconds; an
 * answer with rows calls `onChange`. `Retry-After` on a `429` or `503` stretches the wait. A
 * refused token or mailbox, or the network failing three times in a row, ends the watch with
 * `onClosed`. An expired link starts a new round and calls `onChange`, since what changed in
 * between is not known.
 */
export async function watchInbox(
  client: GraphClient,
  schedule: Schedule,
  handlers: MailWatchHandlers,
  nowMs: number,
): Promise<MailWatch> {
  const controller = new AbortController();
  const since = new Date(nowMs).toISOString();
  const firstLink = `/me/mailFolders/inbox/messages/delta?$select=id&$filter=receivedDateTime+ge+${since}`;
  const opening = await round(client, firstLink, controller.signal);
  let link = opening.delta;
  let closing = false;
  let cancel: (() => void) | null = null;
  let unreachable = 0;

  const end = (error?: unknown) => {
    if (closing) return;
    closing = true;
    cancel?.();
    handlers.onClosed(error);
  };

  const poll = async () => {
    cancel = null;
    if (closing) return;
    let wait = WATCH_INTERVAL_MS;
    try {
      const answer = await round(client, link, controller.signal);
      link = answer.delta;
      unreachable = 0;
      if (answer.changed && !closing) handlers.onChange();
    } catch (error) {
      if (closing) return;
      if (isExpiredSync(error)) {
        try {
          link = (await round(client, firstLink, controller.signal)).delta;
          if (!closing) handlers.onChange();
        } catch (again) {
          end(again);
          return;
        }
      } else if (
        error instanceof GraphAuthError &&
        (error.detail.refusal === "throttled" || error.detail.refusal === "unavailable")
      ) {
        // Graph asked for a longer pause than the client waits out itself: it passes by itself.
        wait = Math.max(WATCH_INTERVAL_MS, error.retryAfterMs ?? 2 * WATCH_INTERVAL_MS);
      } else if (error instanceof GraphUnreachableError && ++unreachable < UNREACHABLE_IN_A_ROW) {
        // The network comes back by itself; asking again at the next tick costs nothing.
      } else {
        end(error);
        return;
      }
    }
    if (!closing) cancel = schedule(() => void poll(), wait);
  };
  cancel = schedule(() => void poll(), WATCH_INTERVAL_MS);
  // Mail that came while the opening round ran is in that round, before its delta link: no poll
  // would ever report it, so it is a change now.
  if (opening.changed) {
    queueMicrotask(() => {
      if (!closing) handlers.onChange();
    });
  }

  return {
    async close() {
      closing = true;
      cancel?.();
      controller.abort();
    },
  };
}
