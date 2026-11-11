import { describe, expect, it } from "vitest";
import type { AgentRule } from "../src/index.ts";
import {
  looksLikeProgram,
  normalizeRuleSubject,
  otherSenders,
  PROGRAM_LIKE,
  ruleCovers,
} from "../src/index.ts";

const rule = (scope: AgentRule["scope"], subject: string, id = 1): AgentRule => ({
  id,
  scope,
  subject,
  action: "noReply",
  actor: "person",
  atMs: 1,
});

describe("normalizeRuleSubject", () => {
  it("trims and lowercases a sender", () => {
    expect(normalizeRuleSubject("sender", "  Alerts@X.com ")).toBe("alerts@x.com");
  });

  it.each(["", "a", "a@", "@x.com", "a@b@c.com", "a b@x.com", `${"a".repeat(320)}@x.com`])(
    "refuses the sender %j",
    (raw) => {
      expect(normalizeRuleSubject("sender", raw)).toBeNull();
    },
  );

  it("accepts a domain, with or without a leading @", () => {
    expect(normalizeRuleSubject("domain", " X.COM ")).toBe("x.com");
    expect(normalizeRuleSubject("domain", "@mail.x.com")).toBe("mail.x.com");
  });

  it.each([
    "",
    "x",
    "a@x.com",
    "x..com",
    "-x.com",
    "x.com ok",
    "@@x.com",
    `${"a".repeat(250)}.com`,
  ])("refuses the domain %j", (raw) => {
    expect(normalizeRuleSubject("domain", raw)).toBeNull();
  });

  it("accepts only the one type", () => {
    expect(normalizeRuleSubject("type", PROGRAM_LIKE)).toBe(PROGRAM_LIKE);
    expect(normalizeRuleSubject("type", " programLike ")).toBe(PROGRAM_LIKE);
    expect(normalizeRuleSubject("type", "other")).toBeNull();
  });
});

describe("looksLikeProgram", () => {
  it.each([
    "alerts@x.com",
    "Alert@x.com",
    "notify@x.com",
    "updates@x.com",
    "news@x.com",
    "newsletter@x.com",
    "system@x.com",
    "robot@x.com",
    "auto@x.com",
    "automated@x.com",
    "monitoring@x.com",
    "status@x.com",
    "digest@x.com",
    "alerts+prod@x.com",
    "news-weekly@x.com",
  ])("%s does", (a) => {
    expect(looksLikeProgram(a)).toBe(true);
  });

  it.each(["anna@x.com", "alertsanna@x.com", "autopilot@x.com", "newsroom@x.com", ""])(
    "%s does not",
    (a) => {
      expect(looksLikeProgram(a)).toBe(false);
    },
  );
});

describe("ruleCovers", () => {
  it("covers a thread when every sender matches some rule", () => {
    const rules = [rule("sender", "a@x.com"), rule("domain", "y.com", 2)];
    expect(ruleCovers(rules, ["a@x.com", "b@y.com"])).toBe(true);
  });

  it("does not cover a thread a person also wrote in", () => {
    expect(ruleCovers([rule("sender", "a@x.com")], ["a@x.com", "anna@x.com"])).toBe(false);
  });

  it("is false with no senders or no rules", () => {
    expect(ruleCovers([rule("sender", "a@x.com")], [])).toBe(false);
    expect(ruleCovers([], ["a@x.com"])).toBe(false);
  });

  it("ignores case", () => {
    expect(ruleCovers([rule("sender", "a@x.com")], ["A@X.com"])).toBe(true);
    expect(ruleCovers([rule("domain", "x.com")], ["A@X.COM"])).toBe(true);
  });

  it("matches a domain exactly, not a longer name that ends alike", () => {
    expect(ruleCovers([rule("domain", "x.com")], ["a@notx.com"])).toBe(false);
    expect(ruleCovers([rule("domain", "x.com")], ["a@mail.x.com"])).toBe(false);
  });

  it("applies the program type only to addresses that look like programs", () => {
    const rules = [rule("type", PROGRAM_LIKE)];
    expect(ruleCovers(rules, ["alerts@x.com", "updates@y.com"])).toBe(true);
    expect(ruleCovers(rules, ["alerts@x.com", "anna@y.com"])).toBe(false);
  });
});

describe("otherSenders", () => {
  it("leaves out the person's own addresses and repeats", () => {
    expect(
      otherSenders([{ from: "A@x.com" }, { from: "ME@z.com" }, { from: "a@x.com" }], ["me@z.com"]),
    ).toEqual(["a@x.com"]);
  });
});
