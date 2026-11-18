import { describe, expect, it } from "vitest";
import {
  bundleOf,
  INSTALL_FAILURES,
  INSTALL_IDLE,
  type InstallState,
  installBusy,
  installFiles,
  installFraction,
  installLine,
  installNote,
  installPlace,
  isInstallRedirect,
  mayInstall,
  nextInstall,
  type PlaceFacts,
  readSums,
  refusalPhrase,
  sameSum,
} from "../src/index.ts";

// ADR 0140: installing a newer version when the person asks. The files and where they may come
// from (rule 3), the checksum line, where this copy can be replaced (rule 2), and the steps with
// their words (rule 5).

const SUM = "a".repeat(64);
const OTHER = "b".repeat(64);
const IMAGE = "Matters-0.1.0-alpha.5-arm64.dmg";

describe("the files of a release (rule 3)", () => {
  it("derives the tag and every address from the version", () => {
    expect(installFiles("0.1.0-alpha.5")).toEqual({
      version: "0.1.0-alpha.5",
      tag: "v0.1.0-alpha.5",
      image: IMAGE,
      record: `${IMAGE}.intoto.jsonl`,
      imageUrl: `https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/${IMAGE}`,
      sumsUrl:
        "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/SHA256SUMS.txt",
      recordUrl: `https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/${IMAGE}.intoto.jsonl`,
    });
    expect(installFiles("v1.2.3")?.image).toBe("Matters-1.2.3-arm64.dmg");
  });

  it("refuses a version that a release does not have, so nothing odd reaches a path", () => {
    for (const bad of [
      "",
      "latest",
      "0.1.0-alpha.5/../../x",
      "0.1.0-alpha",
      "0.1.0-Alpha.5",
      "0.1.0-alpha.5.1",
      "0.1.0+build.1",
      "0.1.0-al-pha.5",
      null,
      5,
    ]) {
      expect(installFiles(bad)).toBeNull();
    }
  });

  it("lets a download be sent on only to GitHub's hosts for release files", () => {
    expect(
      isInstallRedirect(
        "https://release-assets.githubusercontent.com/github-production-release-asset/1/x?sig=y",
      ),
    ).toBe(true);
    expect(
      isInstallRedirect(
        "https://github.com/milolabs/matters-app/releases/download/v0.1.0-alpha.5/x",
      ),
    ).toBe(true);
    for (const bad of [
      "http://release-assets.githubusercontent.com/x",
      "https://release-assets.githubusercontent.com.evil.test/x",
      "https://evil.test/https://release-assets.githubusercontent.com/x",
      "https://user@release-assets.githubusercontent.com/x",
      "https://release-assets.githubusercontent.com:8443/x",
      "https://objects.githubusercontent.com/x",
      "https://github.com/someone/else/releases/download/v1/x",
      "https://github.com/milolabs/matters-app/archive/x",
      "https://release-assets.githubusercontent.com",
      "https://release-assets.githubusercontent.com/a b",
      "file:///etc/passwd",
      42,
    ]) {
      expect(isInstallRedirect(bad), String(bad)).toBe(false);
    }
  });
});

describe("the checksum line", () => {
  it("finds the image's sum in shasum's lines", () => {
    const text = `${OTHER}  Matters-0.1.0-alpha.5-arm64.spdx.json\n${SUM.toUpperCase()}  ${IMAGE}\n`;
    expect(readSums(text, IMAGE)).toEqual({ ok: true, sum: SUM });
    expect(readSums(`${SUM} *${IMAGE}\r\n`, IMAGE)).toEqual({ ok: true, sum: SUM });
  });

  it("refuses a missing line, a name that only contains it, and two different sums", () => {
    expect(readSums(`${SUM}  other.dmg\n`, IMAGE)).toEqual({ ok: false, problem: "missing" });
    expect(readSums(`${SUM}  x${IMAGE}\n`, IMAGE)).toEqual({ ok: false, problem: "missing" });
    expect(readSums(`${SUM}  ${IMAGE}.bak\n`, IMAGE)).toEqual({ ok: false, problem: "missing" });
    expect(readSums(`${SUM.slice(1)}  ${IMAGE}\n`, IMAGE)).toEqual({
      ok: false,
      problem: "missing",
    });
    expect(readSums("", IMAGE)).toEqual({ ok: false, problem: "missing" });
    expect(readSums(`${SUM}  ${IMAGE}\n${OTHER}  ${IMAGE}\n`, IMAGE)).toEqual({
      ok: false,
      problem: "twice",
    });
    expect(readSums(`${SUM}  ${IMAGE}\n${SUM}  ${IMAGE}\n`, IMAGE)).toEqual({ ok: true, sum: SUM });
  });

  it("compares sums case aside, and never a sum that is not one", () => {
    expect(sameSum(SUM, SUM.toUpperCase())).toBe(true);
    expect(sameSum(SUM, OTHER)).toBe(false);
    expect(sameSum("", "")).toBe(false);
  });
});

describe("where this copy can be replaced (rule 2)", () => {
  const facts: PlaceFacts = {
    release: true,
    platform: "darwin",
    arch: "arm64",
    bundle: "/Applications/Matters.app",
    folderWritable: true,
    bundleWritable: true,
  };

  it("finds the bundle a program runs from", () => {
    expect(bundleOf("/Applications/Matters.app/Contents/MacOS/Matters")).toBe(
      "/Applications/Matters.app",
    );
    expect(bundleOf("/Users/a/Applications/Matters.app/Contents/MacOS/Matters")).toBe(
      "/Users/a/Applications/Matters.app",
    );
    expect(bundleOf("/x/Electron.app/Contents/MacOS/Electron")).toBeNull();
    expect(bundleOf("/x/Other.app/Contents/MacOS/Matters")).toBeNull();
    expect(bundleOf("Applications/Matters.app/Contents/MacOS/Matters")).toBeNull();
    expect(bundleOf("/a/../Matters.app/Contents/MacOS/Matters")).toBeNull();
  });

  it("installs from a writable folder, and says why not everywhere else", () => {
    expect(installPlace(facts)).toEqual({ ok: true, folder: "/Applications" });
    expect(installPlace({ ...facts, release: false })).toEqual({ ok: false, why: "not-release" });
    expect(installPlace({ ...facts, arch: "x64" })).toEqual({ ok: false, why: "platform" });
    expect(installPlace({ ...facts, platform: "linux" })).toEqual({ ok: false, why: "platform" });
    expect(installPlace({ ...facts, bundle: null })).toEqual({ ok: false, why: "not-bundle" });
    expect(
      installPlace({
        ...facts,
        bundle: "/private/var/folders/xy/T/AppTranslocation/1234-ABCD/d/Matters.app",
      }),
    ).toEqual({ ok: false, why: "translocated" });
    expect(
      installPlace({ ...facts, bundle: "/Volumes/Matters/Matters.app", folderWritable: false }),
    ).toEqual({ ok: false, why: "disk-image" });
    expect(installPlace({ ...facts, folderWritable: false })).toEqual({
      ok: false,
      why: "read-only",
    });
    expect(installPlace({ ...facts, bundleWritable: false })).toEqual({
      ok: false,
      why: "read-only",
    });
    expect(installPlace({ ...facts, bundle: "/Volumes/Disk/Apps/Matters.app" })).toEqual({
      ok: true,
      folder: "/Volumes/Disk/Apps",
    });
    expect(refusalPhrase("disk-image")).toMatch(/disk image/);
  });

  it("installs only a newer version a release has, never the same or an older one", () => {
    expect(mayInstall("0.1.0-alpha.5", "0.1.0-alpha.4")).toBe(true);
    expect(mayInstall("0.1.0", "0.1.0-alpha.9")).toBe(true);
    expect(mayInstall("0.1.0-alpha.4", "0.1.0-alpha.4")).toBe(false);
    expect(mayInstall("0.1.0-alpha.3", "0.1.0-alpha.4")).toBe(false);
    expect(mayInstall("0.1.0-alpha.10", "0.1.0-beta.1")).toBe(false);
    expect(mayInstall("9.0.0+evil", "0.1.0")).toBe(false);
    expect(mayInstall("0.2.0", "not a version")).toBe(false);
  });
});

describe("the steps of an install (rule 5)", () => {
  const start = nextInstall(INSTALL_IDLE, { kind: "start", version: "0.1.0-alpha.5" });

  it("goes download, checks, install, restart", () => {
    expect(start).toEqual({
      step: "downloading",
      version: "0.1.0-alpha.5",
      received: 0,
      total: null,
    });
    const half = nextInstall(start, { kind: "progress", received: 96e6, total: 192e6 });
    expect(installFraction(half)).toBe(0.5);
    expect(installLine(half)).toBe("Downloading 0.1.0-alpha.5: 96 of 192 MB…");
    const sum = nextInstall(half, { kind: "check", check: "checksum" });
    expect(installLine(sum)).toBe("Checking the download against its checksum…");
    const record = nextInstall(sum, { kind: "check", check: "build-record" });
    expect(installLine(record)).toBe("Checking that the release workflow built it…");
    const installing = nextInstall(record, { kind: "install", recorded: true });
    expect(installLine(installing)).toBe("Installing 0.1.0-alpha.5…");
    expect(installNote(installing)).toMatch(/release workflow of milolabs\/matters-app built it/);
    const restarting = nextInstall(installing, { kind: "restart" });
    expect(installLine(restarting)).toBe("Restarting into 0.1.0-alpha.5…");
    expect(installBusy(restarting)).toBe(true);
    // Restarting is the last step.
    expect(nextInstall(restarting, { kind: "fail", failure: "copy" })).toBe(restarting);
    expect(nextInstall(restarting, { kind: "cancel" })).toBe(restarting);
  });

  it("says when the build record was not checked", () => {
    const installing = nextInstall(nextInstall(start, { kind: "check", check: "checksum" }), {
      kind: "install",
      recorded: false,
    });
    expect(installNote(installing)).toMatch(
      /^The checksum matches\. Not checked: where it was built/,
    );
  });

  it("can be cancelled while it downloads, and only then", () => {
    const cancelled = nextInstall(start, { kind: "cancel" });
    expect(cancelled).toEqual({ step: "failed", version: "0.1.0-alpha.5", failure: "cancelled" });
    expect(installLine(cancelled)).toBe("Cancelled. Nothing was installed.");
    const checking = nextInstall(start, { kind: "check", check: "checksum" });
    expect(nextInstall(checking, { kind: "cancel" })).toBe(checking);
  });

  it("stops at a failed check and says which, with nothing installed", () => {
    const failed = nextInstall(nextInstall(start, { kind: "check", check: "checksum" }), {
      kind: "fail",
      failure: "checksum",
    });
    expect(installLine(failed)).toBe(
      "The download does not match its checksum. Nothing was installed.",
    );
    expect(installBusy(failed)).toBe(false);
    // A failed one can be tried again.
    expect(nextInstall(failed, { kind: "start", version: "0.1.0-alpha.5" }).step).toBe(
      "downloading",
    );
    for (const failure of INSTALL_FAILURES) {
      const line = installLine({ step: "failed", version: "1.0.0", failure });
      expect(line, failure).toMatch(/\. Nothing was installed\.$/);
    }
  });

  it("ignores what does not fit the step", () => {
    expect(nextInstall(start, { kind: "start", version: "0.1.0-alpha.6" })).toBe(start);
    expect(nextInstall(INSTALL_IDLE, { kind: "start", version: "nope" })).toBe(INSTALL_IDLE);
    expect(nextInstall(INSTALL_IDLE, { kind: "progress", received: 1, total: 2 })).toBe(
      INSTALL_IDLE,
    );
    expect(nextInstall(INSTALL_IDLE, { kind: "fail", failure: "copy" })).toBe(INSTALL_IDLE);
    expect(nextInstall(INSTALL_IDLE, { kind: "restart" })).toBe(INSTALL_IDLE);
    expect(nextInstall(start, { kind: "restart" })).toBe(start);
    expect(nextInstall(start, { kind: "progress", received: -1, total: null })).toBe(start);
    const unknown: InstallState = nextInstall(start, {
      kind: "progress",
      received: 5e6,
      total: null,
    });
    expect(installFraction(unknown)).toBeNull();
    expect(installLine(unknown)).toBe("Downloading 0.1.0-alpha.5: 5 MB…");
    expect(installLine(INSTALL_IDLE)).toBeNull();
  });
});
