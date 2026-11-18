import { describe, expect, it } from "vitest";
import {
  type AccountConnection,
  accountsToHold,
  backupFileName,
  compareSchema,
  judgeBackup,
  normalizeSchemaSql,
  restoreRefusalText,
  type SchemaObject,
  setAsideName,
  setAsideTime,
  sourceProblemText,
  sourcesSummaryText,
} from "../src/index.ts";

const table = (name: string, sql = `CREATE TABLE ${name} (x)`): SchemaObject => ({
  type: "table",
  name,
  tableName: name,
  sql,
});
const ours: readonly SchemaObject[] = [
  table("schema_version"),
  table("accounts"),
  {
    type: "index",
    name: "accounts_address",
    tableName: "accounts",
    sql: "CREATE INDEX a ON accounts (x)",
  },
  {
    type: "trigger",
    name: "t1",
    tableName: "accounts",
    sql: "CREATE TRIGGER t1 AFTER INSERT ON accounts BEGIN SELECT 1; END",
  },
];

describe("comparing a file's schema with ours (ADR 0145, rule 8)", () => {
  it("finds nothing when they are the same, white space aside", () => {
    const spaced = ours.map((o) => ({ ...o, sql: o.sql?.replace(/ /g, "\n   ") ?? null }));
    expect(compareSchema(spaced, ours)).toEqual({ unexpected: [], missing: [] });
    expect(normalizeSchemaSql("CREATE  TABLE\n x (y)")).toBe("CREATE TABLE x (y)");
  });

  it("finds an object we do not make, one we make otherwise, and one that is missing", () => {
    const planted: SchemaObject = {
      type: "trigger",
      name: "planted",
      tableName: "accounts",
      sql: "CREATE TRIGGER planted AFTER INSERT ON accounts BEGIN DELETE FROM accounts; END",
    };
    const changed = { ...(ours[3] as SchemaObject), sql: planted.sql };
    const found = [ours[0], ours[1], changed, planted] as SchemaObject[];
    const difference = compareSchema(found, ours);
    expect(difference.unexpected.map((o) => o.name)).toEqual(["t1", "planted"]);
    expect(difference.missing.map((o) => o.name)).toEqual(["accounts_address"]);
  });

  it("allows SQLite's own tables with SQLite's own statements only", () => {
    const stat = table("sqlite_stat1", "CREATE TABLE sqlite_stat1(tbl,idx,stat)");
    expect(compareSchema([...ours, stat], ours).unexpected).toEqual([]);
    const forged = table("sqlite_stat1", "CREATE TABLE sqlite_stat1(tbl,idx,stat,evil)");
    expect(compareSchema([...ours, forged], ours).unexpected).toEqual([forged]);
  });
});

describe("judging a backup (ADR 0145, rule 8)", () => {
  const expected = () => ours;
  it("passes what the adapter could not read on as the refusal", () => {
    for (const kind of ["notSqlite", "damaged", "foreign"] as const) {
      expect(judgeBackup({ kind }, 59, expected)).toEqual({ kind: "refused", reason: kind });
    }
  });

  it("refuses a newer version without comparing anything, and a version that is not one", () => {
    let asked = 0;
    const counting = () => {
      asked++;
      return ours;
    };
    expect(judgeBackup({ kind: "read", version: 60, objects: ours }, 59, counting)).toEqual({
      kind: "refused",
      reason: "newer",
      version: 60,
    });
    expect(asked).toBe(0);
    expect(judgeBackup({ kind: "read", version: 0, objects: ours }, 59, expected)).toMatchObject({
      reason: "foreign",
    });
    expect(judgeBackup({ kind: "read", version: 2.5, objects: ours }, 59, expected)).toMatchObject({
      reason: "foreign",
    });
  });

  it("restores the same version as it is and an older one through the migrations", () => {
    expect(judgeBackup({ kind: "read", version: 59, objects: ours }, 59, expected)).toEqual({
      kind: "restorable",
      version: 59,
      migrate: false,
    });
    expect(judgeBackup({ kind: "read", version: 40, objects: ours }, 59, expected)).toEqual({
      kind: "restorable",
      version: 40,
      migrate: true,
    });
  });

  it("says each refusal in one phrase", () => {
    for (const reason of ["notSqlite", "damaged", "foreign", "newer", "schema"] as const) {
      expect(restoreRefusalText(reason)).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe("accounts held back after a restore (ADR 0145, rule 9)", () => {
  const account = (over: Partial<AccountConnection> = {}): AccountConnection => ({
    id: "a1",
    address: "me@example.com",
    transport: "imap",
    imapHost: "imap.example.com",
    imapPort: 993,
    imapSecurity: "tls",
    imapUsername: "me",
    smtpHost: "smtp.example.com",
    smtpPort: 465,
    smtpSecurity: "tls",
    smtpUsername: "me",
    ...over,
  });

  it("holds an account of the backup whose server, user name or address differs from the same id here", () => {
    expect(accountsToHold([account()], [account()])).toEqual([]);
    expect(accountsToHold([account({ imapHost: "IMAP.EXAMPLE.COM" })], [account()])).toEqual([]);
    expect(accountsToHold([account({ imapHost: "evil.example" })], [account()])).toEqual(["a1"]);
    expect(accountsToHold([account({ smtpPort: 25 })], [account()])).toEqual(["a1"]);
    expect(accountsToHold([account({ address: "other@example.com" })], [account()])).toEqual([
      "a1",
    ]);
    expect(accountsToHold([account({ transport: "graph" })], [account()])).toEqual(["a1"]);
  });

  it("does not list an account this Mac has no credential id for", () => {
    expect(accountsToHold([account({ id: "b2", imapHost: "evil.example" })], [account()])).toEqual(
      [],
    );
  });
});

describe("names of backups and of set-aside databases (ADR 0145, rules 7 and 9)", () => {
  it("names a backup with its day", () => {
    expect(backupFileName("2026-11-16")).toBe("Matters backup 2026-11-16.db");
    expect(backupFileName("../x")).toBe("Matters backup.db");
  });

  it("names a set-aside folder by its time, and reads the time back from only such a name", () => {
    const at = Date.UTC(2026, 10, 16, 15, 30, 0);
    expect(setAsideName(at)).toBe("20261116T153000Z");
    expect(setAsideTime("20261116T153000Z")).toBe(at);
    for (const bad of ["../20261116T153000Z", "20261316T153000Z", "x", "20261116T153000Z/.."]) {
      expect(setAsideTime(bad)).toBeNull();
    }
  });
});

describe("what saving letters as files says (ADR 0145, rule 3)", () => {
  it("says nothing when every letter was saved, or the one save was cancelled", () => {
    expect(sourcesSummaryText(["saved"])).toBeNull();
    expect(sourcesSummaryText(["saved", "saved"])).toBeNull();
    expect(sourcesSummaryText(["cancelled"])).toBeNull();
  });

  it("names the reason for one letter", () => {
    expect(sourcesSummaryText(["gone"])).toBe(sourceProblemText("gone"));
    expect(sourcesSummaryText(["offline"])).toMatch(/could not be reached/);
    expect(sourcesSummaryText(["signIn"])).toMatch(/password or sign-in/);
  });

  it("says what was saved and what was not for a folder", () => {
    expect(sourcesSummaryText(["saved", "gone", "saved"])).toBe(
      "2 letters of 3 saved. 1 letter not: no longer on the server.",
    );
    expect(sourcesSummaryText(["saved", "cancelled", "cancelled"])).toBe(
      "1 letter of 3 saved. Stopped before the rest.",
    );
  });
});
