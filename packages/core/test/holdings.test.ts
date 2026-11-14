import { describe, expect, it } from "vitest";
import {
  accountPermissionPages,
  ERASE_STEPS,
  erasePlan,
  type Holding,
  holdingForDataEntry,
  holdingsOf,
  MICROSOFT_PERMISSION_PAGES,
  permissionPages,
  signInKind,
  undeclaredEntries,
  undeclaredTables,
} from "../src/index.ts";

const h = (id: string, step: Holding["step"], place: Holding["place"]): Holding => ({
  id,
  group: "mail",
  step,
  place,
});

const list: readonly Holding[] = [
  h("caches", "caches", { kind: "data", name: "Cache", match: "exact" }),
  h("order", "order", { kind: "data", name: "erase-order.json", match: "exact" }),
  h("vault", "signIns", { kind: "data", name: "credentials.json", match: "exact" }),
  h("key", "signIns", { kind: "keychain", which: "current" }),
  h("earlierKey", "earlier", { kind: "keychain", which: "earlier" }),
  h("earlier", "earlier", { kind: "earlierFolder" }),
  h("db", "database", { kind: "database", suffix: "" }),
  h("wal", "database", { kind: "database", suffix: "-wal" }),
  h("cookies", "caches", { kind: "data", name: "Cookies", match: "prefix" }),
  h("table", "database", { kind: "table", table: "messages", scope: "account" }),
  h("temp", "temp", { kind: "temp", prefix: "matters-agent-" }),
  h("files", "files", { kind: "data", name: "attachments", match: "exact" }),
  h("settings", "settings", { kind: "data", name: "window.json", match: "exact" }),
];

describe("the erase plan (ADR 0138, rule 3)", () => {
  it("goes credentials and key first, then the database, files, settings, caches, temp, order", () => {
    const plan = erasePlan(list, { earlierCopy: false });
    expect(plan.map((s) => s.step)).toEqual([
      "signIns",
      "database",
      "files",
      "settings",
      "caches",
      "temp",
      "order",
    ]);
    expect(plan[0]?.holdings.map((x) => x.id)).toEqual(["vault", "key"]);
    expect(plan.at(-1)?.holdings.map((x) => x.id)).toEqual(["order"]);
  });

  it("lists no table: they go with the database file", () => {
    const ids = erasePlan(list, { earlierCopy: true }).flatMap((s) => s.holdings.map((x) => x.id));
    expect(ids).not.toContain("table");
  });

  it("takes the earlier copy and its key only when asked, just before the order", () => {
    const without = erasePlan(list, { earlierCopy: false }).flatMap((s) => s.holdings);
    expect(without.map((x) => x.id)).not.toContain("earlier");
    expect(without.map((x) => x.id)).not.toContain("earlierKey");
    const plan = erasePlan(list, { earlierCopy: true });
    expect(plan.map((s) => s.step).slice(-2)).toEqual(["earlier", "order"]);
    expect(plan.at(-2)?.holdings.map((x) => x.id)).toEqual(["earlierKey", "earlier"]);
  });

  it("keeps its steps in the order the decision names", () => {
    expect(ERASE_STEPS.indexOf("signIns")).toBe(0);
    expect(ERASE_STEPS.at(-1)).toBe("order");
  });
});

describe("nothing undeclared (ADR 0138, rule 2)", () => {
  it("finds the holding of each entry of the data folder, by name, prefix or database file", () => {
    expect(holdingForDataEntry(list, "Cookies-journal", "matters.db")?.id).toBe("cookies");
    expect(holdingForDataEntry(list, "matters.db-wal", "matters.db")?.id).toBe("wal");
    // A database that lies elsewhere claims nothing in the folder.
    expect(holdingForDataEntry(list, "matters.db", null)).toBeNull();
    expect(
      undeclaredEntries(
        list,
        ["Cache", "matters.db", "Mystery Store", "window.json"],
        "matters.db",
      ),
    ).toEqual(["Mystery Store"]);
  });

  it("finds tables that no holding declares", () => {
    expect(undeclaredTables(list, ["messages", "new_table"])).toEqual(["new_table"]);
  });

  it("refuses an id declared twice", () => {
    expect(() => holdingsOf(list, [list[0] as Holding])).toThrow(/declared twice/);
  });
});

describe("the provider's page (ADR 0138, rule 8)", () => {
  it("is none for a password account", () => {
    expect(permissionPages("password", "a@outlook.com")).toEqual([]);
  });

  it("is Microsoft's personal page on Microsoft's own personal domains", () => {
    expect(permissionPages("microsoft", "a@hotmail.co.uk").map((p) => p.url)).toEqual([
      MICROSOFT_PERMISSION_PAGES.personal,
    ]);
    expect(permissionPages("microsoft", "a@outlook.com").map((p) => p.id)).toEqual([
      "microsoftPersonal",
    ]);
  });

  it("offers both pages for any other address: a personal account may use a Gmail address", () => {
    for (const address of ["person@gmail.com", "anna@studio.example"]) {
      expect(permissionPages("microsoft", address).map((p) => [p.id, p.url])).toEqual([
        ["microsoftWork", "https://myapplications.microsoft.com/"],
        ["microsoftPersonal", MICROSOFT_PERMISSION_PAGES.personal],
      ]);
    }
  });

  it("follows how the account signs in: Graph or a Microsoft server, never a password host", () => {
    expect(
      accountPermissionPages({ transport: "graph", host: "", address: "anna@studio.example" }).map(
        (p) => p.id,
      ),
    ).toEqual(["microsoftWork", "microsoftPersonal"]);
    expect(
      accountPermissionPages({ host: "outlook.office365.com", address: "a@outlook.com" }).map(
        (p) => p.id,
      ),
    ).toEqual(["microsoftPersonal"]);
    expect(
      accountPermissionPages({ host: "imap.fastmail.com", address: "a@fastmail.com" }),
    ).toEqual([]);
    expect(signInKind({ transport: "imap", host: "imap.example.org" })).toBe("password");
  });
});
