import { describe, expect, it } from "vitest";
import {
  checkDue,
  compareVersions,
  isNewerVersion,
  isPreRelease,
  isReleaseLink,
  msUntilCheck,
  parseVersion,
  RELEASE_CHECK_EVERY_MS,
  RELEASE_DOWNLOAD_PAGE,
  RELEASE_FILE_LIMIT,
  readReleaseFile,
  releaseActions,
  releaseDot,
  type Version,
  versionText,
} from "../src/index.ts";

// ADR 0137: whether a newer version is out. Rule 7 (newer by semantic versioning) and rule 8 (the
// file is not trusted), with when a check is due (rules 4 and 12) and when the dot is on (10).

const v = (text: string): Version => {
  const parsed = parseVersion(text);
  if (parsed === null) throw new Error(`not a version: ${text}`);
  return parsed;
};

describe("versions (rule 7)", () => {
  // The order the record gives, each one newer than the one before.
  const ORDER = [
    "0.1.0-alpha.4",
    "0.1.0-alpha.5",
    "0.1.0-alpha.10",
    "0.1.0-beta.1",
    "0.1.0",
    "0.1.1",
  ];

  it("puts the record's examples in its order", () => {
    for (let i = 0; i < ORDER.length; i++) {
      for (let j = 0; j < ORDER.length; j++) {
        const a = v(ORDER[i] as string);
        const b = v(ORDER[j] as string);
        expect(Math.sign(compareVersions(a, b)), `${ORDER[i]} vs ${ORDER[j]}`).toBe(
          Math.sign(i - j),
        );
      }
    }
  });

  it("sorts a shuffled list into that order", () => {
    const shuffled = [
      "0.1.1",
      "0.1.0-alpha.10",
      "0.1.0",
      "0.1.0-alpha.4",
      "0.1.0-beta.1",
      "0.1.0-alpha.5",
    ];
    expect(shuffled.map(v).sort(compareVersions).map(versionText)).toEqual(ORDER);
  });

  it("drops the leading v of a tag", () => {
    expect(versionText(v("v0.1.0-alpha.4"))).toBe("0.1.0-alpha.4");
    expect(compareVersions(v("v0.1.0-alpha.4"), v("0.1.0-alpha.4"))).toBe(0);
  });

  it("says nothing for equal or older", () => {
    expect(isNewerVersion(v("0.1.0-alpha.4"), v("0.1.0-alpha.4"))).toBe(false);
    expect(isNewerVersion(v("0.1.0-alpha.4"), v("0.1.0-alpha.5"))).toBe(false);
    expect(isNewerVersion(v("0.1.0"), v("0.1.0-beta.1"))).toBe(true);
    expect(isNewerVersion(v("v0.1.0-alpha.5"), v("0.1.0-alpha.4"))).toBe(true);
  });

  it("compares numbers as numbers, before words, and more identifiers after fewer", () => {
    expect(compareVersions(v("1.0.0-2"), v("1.0.0-10"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-1"), v("1.0.0-alpha"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0-alpha"), v("1.0.0-alpha.1"))).toBeLessThan(0);
    expect(compareVersions(v("0.9.9"), v("0.10.0"))).toBeLessThan(0);
    expect(compareVersions(v("1.0.0+build.1"), v("1.0.0+build.2"))).toBe(0);
  });

  it("refuses what is not a version", () => {
    for (const text of [
      "",
      "0.1",
      "0.1.0.0",
      "01.1.0",
      "0.1.0-alpha.01",
      "0.1.0-",
      "0.1.0-alpha..1",
      "V0.1.0",
      " 0.1.0",
      "0.1.0 ",
      "latest",
      `0.1.0-${"a".repeat(80)}`,
      null,
      4,
      { version: "0.1.0" },
    ]) {
      expect(parseVersion(text), String(text)).toBeNull();
    }
  });
});

describe("the file (rule 8)", () => {
  const SITE = {
    repo: "milolabs/matters-app",
    version: "v0.1.0-alpha.4",
    date: "2026-11-13T19:57:53Z",
    url: "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.4/Matters-0.1.0-alpha.4-arm64.dmg",
    notes: "https://github.com/milolabs/matters-app/releases/tag/v0.1.0-alpha.4",
    stage: "alpha",
    stars: 0,
  };
  const read = (file: unknown) => readReleaseFile(JSON.stringify(file));

  it("reads the file the site published", () => {
    expect(read(SITE)).toEqual({
      ok: true,
      release: {
        version: "0.1.0-alpha.4",
        stage: "alpha",
        dateMs: Date.UTC(2026, 10, 13, 19, 57, 53),
        download: SITE.url,
        notes: SITE.notes,
      },
    });
  });

  it("refuses a file that is not a version, never reads it as newest", () => {
    expect(read({ ...SITE, version: null })).toEqual({ ok: false, problem: "no-version" });
    expect(read({ ...SITE, version: "soon" })).toEqual({ ok: false, problem: "no-version" });
    expect(read({ ...SITE, version: 5 })).toEqual({ ok: false, problem: "no-version" });
    const { version: _gone, ...noVersion } = SITE;
    expect(read(noVersion)).toEqual({ ok: false, problem: "no-version" });
    expect(readReleaseFile("<html>")).toEqual({ ok: false, problem: "not-json" });
    expect(readReleaseFile("[1, 2]")).toEqual({ ok: false, problem: "not-json" });
    expect(readReleaseFile("null")).toEqual({ ok: false, problem: "not-json" });
  });

  it("refuses a file over the size limit", () => {
    const big = JSON.stringify({ ...SITE, pad: "x".repeat(RELEASE_FILE_LIMIT) });
    expect(readReleaseFile(big)).toEqual({ ok: false, problem: "too-big" });
  });

  it("leaves out a link that is not under the project's release pages", () => {
    for (const link of [
      "http://github.com/milolabs/matters-app/releases/tag/v0.1.0",
      "https://github.com/milolabs/matters-app/issues/1",
      "https://github.com/milolabs/matters-app/releases",
      "https://github.com/milolabs/matters-app/releases/",
      "https://github.com/milolabs/matters-app-evil/releases/tag/v1",
      "https://github.com.evil.test/milolabs/matters-app/releases/tag/v1",
      "https://evil.test/https://github.com/milolabs/matters-app/releases/tag/v1",
      "https://github.com/milolabs/matters-app/releases/../../other/thing",
      "https://github.com/milolabs/matters-app/releases/tag/./v1",
      "https://github.com/milolabs/matters-app/releases/tag//v1",
      "https://github.com/milolabs/matters-app/releases/%2e%2e/x",
      "https://github.com/milolabs/matters-app/releases/tag/v1?x=1",
      "https://github.com/milolabs/matters-app/releases/tag/v1#x",
      "https://github.com/milolabs/matters-app/releases/tag/v1\\x",
      "https://github.com/milolabs/matters-app/releases/tag/v 1",
      "HTTPS://GITHUB.COM/milolabs/matters-app/releases/tag/v1",
      "javascript:alert(1)",
      `https://github.com/milolabs/matters-app/releases/tag/${"a".repeat(600)}`,
      42,
      null,
    ]) {
      expect(isReleaseLink(link), String(link)).toBe(false);
    }
    expect(isReleaseLink(SITE.url)).toBe(true);
    expect(isReleaseLink(SITE.notes)).toBe(true);

    const wrong = read({ ...SITE, url: "https://evil.test/Matters.dmg", notes: "file:///etc" });
    expect(wrong.ok && wrong.release).toMatchObject({ download: null, notes: null });
  });

  it("sends the person to the download page when no link passes", () => {
    expect(releaseActions({ download: null, notes: null })).toEqual({
      download: RELEASE_DOWNLOAD_PAGE,
      notes: null,
    });
    expect(releaseActions({ download: null, notes: SITE.notes })).toEqual({
      download: null,
      notes: SITE.notes,
    });
    expect(releaseActions({ download: SITE.url, notes: null })).toEqual({
      download: SITE.url,
      notes: null,
    });
  });

  it("keeps no stage or date that does not read, and nothing else of the file", () => {
    const odd = read({ ...SITE, stage: "<b>alpha</b>", date: "yesterday", extra: "hello" });
    expect(odd).toEqual({
      ok: true,
      release: {
        version: "0.1.0-alpha.4",
        stage: null,
        dateMs: null,
        download: SITE.url,
        notes: SITE.notes,
      },
    });
  });

  it("knows a pre-release by its version or its stage", () => {
    expect(isPreRelease({ version: "0.1.0-alpha.5", stage: null })).toBe(true);
    expect(isPreRelease({ version: "0.1.0", stage: "pre-release" })).toBe(true);
    expect(isPreRelease({ version: "0.1.0", stage: null })).toBe(false);
  });
});

describe("when a check is due (rules 4 and 12)", () => {
  const t = Date.UTC(2026, 10, 14, 9, 14);

  it("checks first in a run, then once a day", () => {
    expect(checkDue(null, t)).toBe(true);
    expect(checkDue(t, t + 1000)).toBe(false);
    expect(checkDue(t, t + RELEASE_CHECK_EVERY_MS - 1)).toBe(false);
    expect(checkDue(t, t + RELEASE_CHECK_EVERY_MS)).toBe(true);
    // A week asleep: due when it wakes, not on a calendar.
    expect(checkDue(t, t + 7 * RELEASE_CHECK_EVERY_MS)).toBe(true);
  });

  it("counts a clock that went back as due", () => {
    expect(checkDue(t, t - 60_000)).toBe(true);
  });

  it("says how long until the next one", () => {
    expect(msUntilCheck(null, t)).toBe(0);
    expect(msUntilCheck(t, t + 1000)).toBe(RELEASE_CHECK_EVERY_MS - 1000);
    expect(msUntilCheck(t, t + RELEASE_CHECK_EVERY_MS + 5)).toBe(0);
  });
});

describe("the dot (rules 9 and 10)", () => {
  it("is on for a newer version About has not been shown with", () => {
    expect(releaseDot(null, null)).toBe(false);
    expect(releaseDot("0.1.0-alpha.5", null)).toBe(true);
    expect(releaseDot("0.1.0-alpha.5", "0.1.0-alpha.5")).toBe(false);
    // Seen with a later one already: stays off.
    expect(releaseDot("0.1.0-alpha.5", "0.1.0-alpha.6")).toBe(false);
    // A version newer than the one seen brings it back.
    expect(releaseDot("0.1.0-alpha.6", "0.1.0-alpha.5")).toBe(true);
  });
});
