import type { Message } from "@matters/core";
import { describe, expect, it } from "vitest";
import { mailMenu } from "../src/renderer/listMenu.ts";

const row = (over: Partial<Message> & { seen?: boolean } = {}) =>
  ({
    key: 1,
    threadId: "t1",
    accountId: "a",
    flags: { seen: over.seen ?? true },
    ...over,
  }) as unknown as Message;
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
