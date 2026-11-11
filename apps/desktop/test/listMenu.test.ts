import type { Message, Thing } from "@matters/core";
import { describe, expect, it } from "vitest";
import { mailMenu, thingMenu } from "../src/renderer/listMenu.ts";

const row = (over: Partial<Message> & { seen?: boolean } = {}) =>
  ({
    key: 1,
    threadId: "t1",
    accountId: "a",
    flags: { seen: over.seen ?? true },
    ...over,
  }) as unknown as Message;
const thing = (threadId: string, accountId = "a") => ({ threadId, accountId }) as unknown as Thing;
const actions = (menu: { sections: readonly (readonly { action: string }[])[] }) =>
  menu.sections.flat().map((i) => i.action);

describe("the menu of mail (ADR 0056, rule 4)", () => {
  it("offers one row everything, and the sender when a filter can be written", () => {
    const menu = mailMenu([row()], { deletesForever: false, senderName: "Anna" });
    expect(actions(menu)).toEqual([
      "reply",
      "replyAll",
      "forward",
      "unread",
      "archive",
      "delete",
      "spam",
      "move",
      "fromSender",
    ]);
    expect(menu.sections.flat().at(-1)).toMatchObject({ label: "Show mail from Anna" });
    expect(menu.heading).toBeUndefined();
  });

  it("offers several only what fits several, and counts threads, not rows", () => {
    const menu = mailMenu(
      [
        row({ key: 1, seen: false }),
        row({ key: 2, threadId: "t1" }),
        row({ key: 3, threadId: "t2" }),
      ],
      { deletesForever: false, senderName: "Anna" },
    );
    expect(menu.heading).toBe("2 threads");
    expect(actions(menu)).toEqual(["read", "unread", "archive", "delete", "spam", "move"]);
  });

  it("is Delete forever in Trash", () => {
    const item = mailMenu([row()], { deletesForever: true })
      .sections.flat()
      .find((i) => i.action === "deleteForever");
    expect(item).toMatchObject({ label: "Delete forever", danger: true });
  });

  it("has no Move to… for a group across accounts: folders belong to an account", () => {
    const menu = mailMenu([row({ key: 1 }), row({ key: 2, threadId: "t2", accountId: "b" })], {
      deletesForever: false,
    });
    expect(menu.sections.flat().find((i) => i.action === "move")?.disabled).toBe(true);
  });
});

describe("the menu of things (ADR 0056, rule 5)", () => {
  const none = () => undefined;
  const idle = () => false;

  it("offers one thing its own words and what its work allows", () => {
    expect(actions(thingMenu([thing("t1")], none, idle))).toEqual([
      "reply",
      "replyAll",
      "forward",
      "closed",
      "later",
      "notImportant",
      "prepare",
      "archive",
      "delete",
      "spam",
      "move",
    ]);
    const draft = thingMenu([thing("t1")], () => ({ kind: "draft", body: "x" }) as never, idle);
    expect(actions(draft)).toContain("edit");
    expect(actions(draft)).not.toContain("prepare");
  });

  it("says it is preparing, and cannot be asked twice", () => {
    const item = thingMenu([thing("t1")], none, () => true)
      .sections.flat()
      .find((i) => i.action === "prepare");
    expect(item).toMatchObject({ label: "Preparing…", disabled: true });
  });

  it("never offers several anything that writes: each draft is read before it goes", () => {
    const menu = thingMenu([thing("t1"), thing("t2")], none, idle);
    expect(menu.heading).toBe("2 things");
    expect(actions(menu)).toEqual([
      "closed",
      "later",
      "notImportant",
      "archive",
      "delete",
      "spam",
      "move",
    ]);
  });
});
