import type { Label, LabelRole, Message } from "@matters/core";
import { MAILBOX_BIT } from "@matters/core";
import { makeMessage } from "@matters/testkit";
import { describe, expect, it } from "vitest";
import { moveKeyOf, plainKey } from "../src/renderer/keys.ts";
import { describeLine, refusedText, TOO_LATE } from "../src/renderer/moves.ts";
import { filterPlaces, movePlaces } from "../src/renderer/moveView.ts";

const folder = (id: string, role: LabelRole, name = id): Label => ({
  id,
  accountId: "acc1",
  name,
  role,
  exclusive: true,
});
const FOLDERS = [
  folder("INBOX", "inbox"),
  folder("Archive", "archive"),
  folder("Trash", "trash", "Kosz"),
  folder("Junk", "spam", "Spam"),
  folder("Sent", "sent", "Wysłane"),
  folder("Drafts", "drafts", "Szkice"),
  folder("Praca", "other"),
  folder("Faktury", "other"),
  folder("Żaby", "other"),
];
const at = (id: string, role: LabelRole): Message =>
  makeMessage({ labelIds: [id], mailboxes: MAILBOX_BIT[role] });

describe("the Move list (ADR 0044, rule 17)", () => {
  const names = (m: Message[], hidden = false) => movePlaces(m, FOLDERS, hidden).map((p) => p.name);

  it("is Inbox, Archive, then the folders alphabetically, with no Sent and no Drafts", () => {
    expect(names([at("Clients", "other")])).toEqual([
      "Inbox",
      "Archive",
      "Faktury",
      "Kosz",
      "Praca",
      "Spam",
      "Żaby",
    ]);
  });

  it("does not offer the folder the thread is in", () => {
    expect(names([at("INBOX", "inbox")])).not.toContain("Inbox");
    expect(names([at("Archive", "archive")])).not.toContain("Archive");
    expect(names([at("Praca", "other")])).not.toContain("Praca");
    // In two folders: each of them is still somewhere to move the other copy to.
    const two = makeMessage({ labelIds: ["INBOX", "Praca"], mailboxes: 65 });
    expect(names([two])).toEqual(expect.arrayContaining(["Inbox", "Praca"]));
  });

  it("always offers the Inbox for a thread in Trash or Spam, seen from there", () => {
    expect(names([at("Trash", "trash")], true)).toContain("Inbox");
    expect(names([at("Junk", "spam")], true)).toContain("Inbox");
    expect(names([at("Trash", "trash")], true)).not.toContain("Kosz");
  });

  it("leaves out deleted mail from a thread that is not looked at from Trash", () => {
    const mixed = [at("INBOX", "inbox"), at("Trash", "trash")];
    expect(names(mixed, false)).not.toContain("Inbox");
    expect(names(mixed, true)).toContain("Inbox");
  });

  it("names a target for each place: roles for the first two, ids for the rest", () => {
    const places = movePlaces([at("Clients", "other")], FOLDERS, false);
    expect(places[0]?.target).toEqual({ role: "inbox" });
    expect(places[1]?.target).toEqual({ role: "archive" });
    expect(places.find((p) => p.name === "Kosz")?.target).toEqual({ folderId: "Trash" });
  });

  it("offers Inbox and Archive when the account has no folders yet", () => {
    expect(movePlaces([at("Clients", "other")], [], false).map((p) => p.name)).toEqual([
      "Inbox",
      "Archive",
    ]);
  });

  it("filters by what is typed, ignoring case and accents, the starts of names first", () => {
    const places = movePlaces([at("Clients", "other")], FOLDERS, false);
    expect(filterPlaces(places, "").map((p) => p.name)).toHaveLength(places.length);
    expect(filterPlaces(places, "pr").map((p) => p.name)).toEqual(["Praca"]);
    expect(filterPlaces(places, "zab").map((p) => p.name)).toEqual(["Żaby"]);
    expect(filterPlaces(places, "żab").map((p) => p.name)).toEqual(["Żaby"]);
    expect(filterPlaces(places, "KOSZ").map((p) => p.name)).toEqual(["Kosz"]);
    // Later in the name still finds it, after those that start with it.
    expect(filterPlaces(places, "a").map((p) => p.name)).toEqual([
      "Archive",
      "Faktury",
      "Praca",
      "Spam",
      "Żaby",
    ]);
    expect(filterPlaces(places, "zzz")).toEqual([]);
  });
});

describe("the keys of moving (rule 5)", () => {
  const press = (key: string, over: Partial<Parameters<typeof plainKey>[0]> = {}) => ({
    key,
    isComposing: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    ...over,
  });
  const place = { composeOpen: false, inSearch: false, textTarget: false };
  const action = (key: string, over = {}, at = place) => {
    const k = plainKey(press(key, over), at);
    return k === null ? null : moveKeyOf(k);
  };

  it("names an action for each key", () => {
    expect(action("e")).toBe("archive");
    expect(action("Backspace")).toBe("delete");
    expect(action("Delete")).toBe("delete");
    expect(action("#")).toBe("delete");
    expect(action("!")).toBe("spam");
    expect(action("v")).toBe("pick");
    expect(action("E")).toBeNull();
    expect(action("x")).toBeNull();
  });

  it("lets Shift through, since # and ! are typed with it, and refuses the keys of commands", () => {
    expect(plainKey({ ...press("#"), shiftKey: true } as never, place)).toBe("#");
    expect(plainKey({ ...press("!"), shiftKey: true } as never, place)).toBe("!");
    for (const over of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }]) {
      for (const key of ["e", "Backspace", "#", "!", "v"]) expect(action(key, over)).toBeNull();
    }
  });

  it("gives nothing typed into a field, the query bar, or the composer", () => {
    for (const where of [
      { ...place, textTarget: true },
      { ...place, inSearch: true },
      { ...place, composeOpen: true },
    ]) {
      for (const key of ["e", "Backspace", "#", "!", "v"])
        expect(action(key, {}, where)).toBeNull();
    }
    expect(action("e", { isComposing: true })).toBeNull();
  });
});

describe("the words of the tray (rule 10 and 15)", () => {
  const line = {
    id: "op1",
    action: "archive" as const,
    count: 1,
    subject: "Hej",
    notBeforeMs: 10_000,
  };

  it("say what was done, with Undo while there are seconds left", () => {
    expect(describeLine(line, 7)).toEqual({
      line: "Archived",
      actions: ["undo"],
      announce: "Archived",
    });
    expect(describeLine(line, 0).actions).toEqual([]);
    expect(describeLine({ ...line, action: "delete" }, 3).line).toBe("Moved to Trash");
    expect(describeLine({ ...line, action: "spam" }, 3).line).toBe("Marked as spam");
    expect(describeLine({ ...line, action: "move", place: "Praca" }, 3).line).toBe(
      "Moved to Praca",
    );
  });

  it("say why a move did not stand", () => {
    expect(refusedText("archive")).toBe("Couldn't move: the server refused.");
    expect(refusedText("purge")).toBe("Couldn't delete: the server refused.");
    expect(TOO_LATE).toMatch(/^Too late to undo/);
  });
});
