import { describe, expect, it } from "vitest";
import { enumValues, isQueryField, QUERY_FIELDS } from "../src/index.ts";

describe("QUERY_FIELDS", () => {
  it("lists the fields the parser knows, each with a type and an English hint", () => {
    expect(Object.keys(QUERY_FIELDS)).toEqual([
      "from",
      "to",
      "cc",
      "subject",
      "is",
      "has",
      "in",
      "label",
      "account",
      "after",
      "before",
    ]);
    for (const info of Object.values(QUERY_FIELDS)) expect(info.hint).not.toBe("");
    expect(QUERY_FIELDS.from.type).toBe("person");
    expect(QUERY_FIELDS.label.type).toBe("label");
    expect(QUERY_FIELDS.account.type).toBe("account");
    expect(QUERY_FIELDS.after.type).toBe("date");
  });

  it("gives every enum value a hint", () => {
    expect(enumValues("is")).toEqual(["unread", "read", "starred", "replied", "draft"]);
    expect(QUERY_FIELDS.has.values.attachment).toBe("Has a file attached");
    expect(enumValues("in")).toEqual(["inbox", "archive", "sent", "drafts", "trash", "spam"]);
    for (const field of ["is", "has", "in"] as const) {
      for (const hint of Object.values(QUERY_FIELDS[field].values)) expect(hint).not.toBe("");
    }
  });

  it("does not take names from the prototype chain", () => {
    expect(isQueryField("from")).toBe(true);
    expect(isQueryField("constructor")).toBe(false);
    expect(isQueryField("toString")).toBe(false);
  });
});
