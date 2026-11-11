// What the Move list offers, as a pure function of the thread and the account's folders (ADR 0044,
// rule 17). Pure, so the order, the exclusions and the filter are tested without a page.
import type { Label, Message, MoveTarget } from "@matters/core";
import { foldText, isHiddenMailbox, planMove, resolvePlace } from "@matters/core";

export interface MovePlace {
  /** What the list shows. */
  readonly name: string;
  readonly target: MoveTarget;
}

/**
 * Inbox, Archive, then the account's other folders alphabetically. Sent and Drafts are never
 * offered, and neither is a place the whole thread is in already: so the inbox is missing from
 * the list of a thread that sits in it, and always there for one in Trash or Spam.
 * `hidden` says the messages of Trash and Spam count, as they do when the thread is looked at
 * from there.
 */
export function movePlaces(
  messages: readonly Message[],
  folders: readonly Label[],
  hidden: boolean,
): MovePlace[] {
  const wanted = messages.filter((m) => hidden || !isHiddenMailbox(m.mailboxes ?? 0));
  const offered = (target: MoveTarget) => {
    const place = resolvePlace(folders, target);
    return (
      wanted.length === 0 ||
      wanted.some(
        (m) =>
          planMove(
            { labelIds: m.labelIds, mailboxes: m.mailboxes ?? 0 },
            "move",
            place,
            folders,
          ) !== null,
      )
    );
  };
  const named = (role: "inbox" | "archive", name: string): MovePlace[] => {
    const target: MoveTarget = { role };
    return offered(target) ? [{ name, target }] : [];
  };
  const others = folders
    .filter((f) => !["inbox", "sent", "drafts", "archive"].includes(f.role))
    .map((f): MovePlace => ({ name: f.name, target: { folderId: f.id } }))
    .filter((p) => offered(p.target))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...named("inbox", "Inbox"), ...named("archive", "Archive"), ...others];
}

/** The places whose names start with what was typed, ignoring case and accents. */
export function filterPlaces(places: readonly MovePlace[], typed: string): MovePlace[] {
  const want = foldText(typed).trim();
  if (want === "") return [...places];
  const starts = places.filter((p) => foldText(p.name).startsWith(want));
  const inside = places.filter((p) => !starts.includes(p) && foldText(p.name).includes(want));
  return [...starts, ...inside];
}
