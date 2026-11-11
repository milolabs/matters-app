import { describe, expect, it } from "vitest";
import {
  asksForHidden,
  computeMailboxes,
  decodeTarget,
  describeMove,
  describeNothing,
  encodeTarget,
  isHiddenMailbox,
  type Label,
  type LabelRole,
  type LabelRoleOf,
  leavesView,
  MAILBOX_BIT,
  namesAPlace,
  parseQuery,
  planMove,
  resolvePlace,
  roleOfLabel,
  targetOf,
} from "../src/index.ts";

const folder = (id: string, role: LabelRole, exclusive = true, name = id): Label => ({
  id,
  accountId: "a",
  name,
  role,
  exclusive,
});
const IMAP = [
  folder("INBOX", "inbox"),
  folder("Archive", "archive"),
  folder("Trash", "trash"),
  folder("Junk", "spam"),
  folder("Sent", "sent"),
  folder("Drafts", "drafts"),
  folder("Clients", "other"),
];
const GMAIL = [
  folder("All", "archive", false),
  folder("GTrash", "trash", false),
  folder("GSpam", "spam", false),
];
const bits = (...roles: LabelRole[]) => roles.reduce((a, r) => a | MAILBOX_BIT[r], 0);
const root = (q: string) => parseQuery(q).root;
const labelRole: LabelRoleOf = (v) => IMAP.find((f) => f.id.toLowerCase() === v)?.role;

describe("mailboxes (ADR 0044, rule 2)", () => {
  it("are the roles of the folders the labels name, system labels by their names", () => {
    const roles = new Map(IMAP.map((f) => [f.id, f.role]));
    expect(computeMailboxes(["INBOX"], roles, [])).toBe(bits("inbox"));
    expect(computeMailboxes(["Trash", "Clients"], roles, [])).toBe(bits("trash", "other"));
    // No folders listed yet: the names of the system labels still count, anything else is `other`.
    expect(computeMailboxes(["inbox", "sent", "draft", "trash", "spam"], undefined, [])).toBe(
      bits("inbox", "sent", "drafts", "trash", "spam"),
    );
    expect(computeMailboxes(["Faktury"], undefined, [])).toBe(bits("other"));
    expect(computeMailboxes([], undefined, [])).toBe(0);
    expect(roleOfLabel("Wysłane", roles)).toBe("other");
  });

  it("count All Mail as archive only without the inbox label, and Trash and Spam from the copy", () => {
    const archive = [{ role: "archive" as const, exclusive: false }];
    expect(computeMailboxes(["inbox"], undefined, archive)).toBe(bits("inbox"));
    expect(computeMailboxes(["Faktury"], undefined, archive)).toBe(bits("other", "archive"));
    expect(computeMailboxes([], undefined, [{ role: "trash", exclusive: false }])).toBe(
      bits("trash"),
    );
    expect(computeMailboxes([], undefined, [{ role: "spam", exclusive: false }])).toBe(
      bits("spam"),
    );
  });

  it("hide Trash and Spam and nothing else", () => {
    expect(isHiddenMailbox(bits("trash"))).toBe(true);
    expect(isHiddenMailbox(bits("spam", "inbox"))).toBe(true);
    expect(isHiddenMailbox(bits("inbox", "archive", "sent", "drafts", "other"))).toBe(false);
    expect(isHiddenMailbox(0)).toBe(false);
  });
});

describe("targets", () => {
  it("round-trip through text, and refuse text that is neither", () => {
    for (const t of [
      { role: "archive" },
      { role: "inbox" },
      { folderId: "Clients/Acme" },
    ] as const) {
      expect(decodeTarget(encodeTarget(t))).toEqual(t);
    }
    expect(decodeTarget("role:sent")).toBeNull();
    expect(decodeTarget("")).toBeNull();
    expect(decodeTarget("x")).toBeNull();
  });

  it("are the role of each named action, and Move needs its own", () => {
    expect(targetOf("archive")).toEqual({ role: "archive" });
    expect(targetOf("delete")).toEqual({ role: "trash" });
    expect(targetOf("spam")).toEqual({ role: "spam" });
    expect(targetOf("move", { folderId: "x" })).toEqual({ folderId: "x" });
    expect(() => targetOf("move")).toThrow();
  });

  it("find the folder of a role, the first by id, and name the one to make when there is none", () => {
    expect(resolvePlace(IMAP, { role: "trash" })).toMatchObject({ id: "Trash", exists: true });
    expect(resolvePlace([], { role: "archive" })).toEqual({
      role: "archive",
      id: "Archive",
      name: "Archive",
      exists: false,
    });
    expect(resolvePlace([], { role: "spam" })).toMatchObject({ id: "Junk" });
    expect(resolvePlace(GMAIL, { role: "inbox" })).toMatchObject({ id: "inbox", exists: false });
    expect(resolvePlace(IMAP, { folderId: "Clients" })).toMatchObject({ role: "other" });
    expect(resolvePlace(IMAP, { folderId: "Gone" })).toMatchObject({
      exists: false,
      role: "other",
    });
    const two = [folder("B-archive", "archive"), folder("A-archive", "archive")];
    expect(resolvePlace(two, { role: "archive" }).id).toBe("A-archive");
  });
});

describe("planMove: what a move leaves the message holding (rule 5)", () => {
  const held = (labelIds: string[], ...roles: LabelRole[]) => ({
    labelIds,
    mailboxes: bits(...roles),
  });
  const plan = (
    h: ReturnType<typeof held>,
    action: Parameters<typeof planMove>[1],
    target = targetOf(action === "move" ? "move" : action, { role: "archive" }),
    folders: readonly Label[] = IMAP,
  ) => planMove(h, action, resolvePlace(folders, target), folders);

  describe("where folders are the places", () => {
    it("takes the message from every folder but Sent and Drafts", () => {
      expect(plan(held(["INBOX", "Clients"], "inbox", "other"), "archive")).toEqual({
        labelIds: ["Archive"],
        mailboxes: bits("archive"),
      });
      expect(plan(held(["INBOX", "Sent"], "inbox", "sent"), "archive")).toEqual({
        labelIds: ["Sent", "Archive"],
        mailboxes: bits("sent", "archive"),
      });
      expect(plan(held(["Drafts"], "drafts"), "spam")).toBeNull();
    });

    it("takes Sent and Drafts too for Delete", () => {
      expect(plan(held(["INBOX", "Sent"], "inbox", "sent"), "delete")).toEqual({
        labelIds: ["Trash"],
        mailboxes: bits("trash"),
      });
      expect(plan(held(["Sent"], "sent"), "delete")).toEqual({
        labelIds: ["Trash"],
        mailboxes: bits("trash"),
      });
    });

    it("leaves a message that is only at the target, and a message with nothing to take", () => {
      expect(plan(held(["Archive"], "archive"), "archive")).toBeNull();
      expect(plan(held(["Trash"], "trash"), "delete")).toBeNull();
      expect(plan(held([]), "archive")).toBeNull();
      // In the target and somewhere else: it still has to leave the somewhere else.
      expect(plan(held(["Archive", "INBOX"], "archive", "inbox"), "archive")).toEqual({
        labelIds: ["Archive"],
        mailboxes: bits("archive"),
      });
    });

    it("moves to a folder by its id, and out of Trash to the inbox", () => {
      expect(plan(held(["INBOX"], "inbox"), "move", { folderId: "Clients" })).toEqual({
        labelIds: ["Clients"],
        mailboxes: bits("other"),
      });
      expect(plan(held(["Trash"], "trash"), "move", { role: "inbox" })).toEqual({
        labelIds: ["INBOX"],
        mailboxes: bits("inbox"),
      });
      expect(plan(held(["Clients"], "other"), "move", { folderId: "Clients" })).toBeNull();
    });
  });

  describe("where labels are the places", () => {
    it("archives by taking the inbox label off and leaves the tags", () => {
      expect(
        plan(held(["inbox", "Clients"], "inbox", "other"), "archive", undefined, GMAIL),
      ).toEqual({ labelIds: ["Clients"], mailboxes: bits("archive", "other") });
      expect(plan(held([], "archive"), "archive", undefined, GMAIL)).toBeNull();
    });

    it("keeps Sent when archiving, and leaves nothing but the tags for Delete", () => {
      expect(plan(held(["inbox", "sent"], "inbox", "sent"), "archive", undefined, GMAIL)).toEqual({
        labelIds: ["sent"],
        mailboxes: bits("sent", "archive"),
      });
      expect(
        plan(held(["inbox", "Clients"], "inbox", "other"), "delete", undefined, GMAIL),
      ).toEqual({
        labelIds: ["Clients"],
        mailboxes: bits("trash", "other"),
      });
    });

    it("moves to a label by adding it and taking the inbox label off, and to the inbox by adding that", () => {
      expect(
        plan(held(["inbox"], "inbox"), "move", { folderId: "Work" }, [
          ...GMAIL,
          folder("Work", "other", false),
        ]),
      ).toEqual({ labelIds: ["Work"], mailboxes: bits("archive", "other") });
      expect(plan(held([], "archive"), "move", { role: "inbox" }, GMAIL)).toEqual({
        labelIds: ["inbox"],
        mailboxes: bits("inbox"),
      });
      // Restoring from Trash: the copy moves; the label side only notes where it will be.
      expect(plan(held([], "trash"), "archive", undefined, GMAIL)).toEqual({
        labelIds: [],
        mailboxes: bits("archive"),
      });
    });
  });

  it("is idempotent: planning from its own result plans nothing", () => {
    for (const action of ["archive", "delete", "spam"] as const) {
      const first = plan(held(["INBOX", "Clients"], "inbox", "other"), action) as {
        labelIds: string[];
        mailboxes: number;
      };
      expect(plan(first, action)).toBeNull();
    }
  });
});

describe("which views a moved thread leaves (rule 9)", () => {
  const leaves = (q: string, action: Parameters<typeof leavesView>[1]) =>
    leavesView(root(q), action, labelRole);

  it("leaves every view for Delete and Spam, except one that asks for what it moves to", () => {
    for (const q of ["", "from:anna", "is:unread", "in:inbox", "label:clients", "has:attachment"]) {
      expect(leaves(q, "delete"), q).toBe(true);
      expect(leaves(q, "spam"), q).toBe(true);
    }
    expect(leaves("in:trash", "delete")).toBe(false);
    expect(leaves("label:trash", "delete")).toBe(false);
    expect(leaves("in:spam", "spam")).toBe(false);
    expect(leaves("in:trash OR in:spam", "delete")).toBe(false);
    // Deleting from Spam leaves it: Trash is not what that view asks for.
    expect(leaves("in:spam", "delete")).toBe(true);
    expect(leaves("in:trash", "spam")).toBe(true);
  });

  it("leaves the views that name a place for Archive and Move, and no others", () => {
    for (const action of ["archive", "move"] as const) {
      expect(leaves("in:inbox", action)).toBe(true);
      expect(leaves("label:clients", action)).toBe(true);
      expect(leaves("in:archive anna", action)).toBe(true);
      expect(leaves("", action)).toBe(false);
      expect(leaves("is:unread", action)).toBe(false);
      expect(leaves("from:anna has:attachment", action)).toBe(false);
    }
  });

  it("looks at the whole tree: a negated place or one in a group is named too", () => {
    expect(namesAPlace(root("-in:inbox"))).toBe(true);
    expect(namesAPlace(root("(from:anna OR in:inbox)"))).toBe(true);
    expect(namesAPlace(root("from:anna"))).toBe(false);
    expect(namesAPlace(null)).toBe(false);
  });

  it("asks for Trash or Spam only in a positive place", () => {
    expect(asksForHidden(root("in:trash"), labelRole)).toBe(true);
    expect(asksForHidden(root("(in:spam OR in:inbox)"), labelRole)).toBe(true);
    expect(asksForHidden(root("label:junk"), labelRole)).toBe(true);
    expect(asksForHidden(root("-in:trash"), labelRole)).toBe(false);
    expect(asksForHidden(root("in:inbox"), labelRole)).toBe(false);
    expect(asksForHidden(root("label:clients"), labelRole)).toBe(false);
    expect(asksForHidden(root("label:junk"))).toBe(false);
    expect(asksForHidden(null)).toBe(false);
  });
});

describe("the words of the tray", () => {
  it("say what was done and what was already so", () => {
    expect(describeMove("archive")).toBe("Archived");
    expect(describeMove("delete")).toBe("Moved to Trash");
    expect(describeMove("spam")).toBe("Marked as spam");
    expect(describeMove("move", "Praca")).toBe("Moved to Praca");
    expect(describeMove("purge")).toBe("Deleted forever");
    expect(describeNothing("archive")).toBe("Already archived");
    expect(describeNothing("move", "Praca")).toBe("Already in Praca");
  });
});

describe("the in: field", () => {
  it("parses a role, and says which values it knows", () => {
    expect(root("in:trash")).toEqual({ kind: "in", role: "trash" });
    expect(root("IN:Inbox")).toEqual({ kind: "in", role: "inbox" });
    const partial = parseQuery("in:tra");
    expect(partial.root).toBeNull();
    expect(partial.tokens[0]).toMatchObject({ state: "incomplete" });
    const bad = parseQuery("in:elsewhere");
    expect(bad.root).toBeNull();
    expect(bad.diagnostics[0]?.code).toBe("unknown-value");
    expect(root("in:inbox -in:spam")).toEqual({
      kind: "and",
      children: [
        { kind: "in", role: "inbox" },
        { kind: "not", child: { kind: "in", role: "spam" } },
      ],
    });
  });
});
