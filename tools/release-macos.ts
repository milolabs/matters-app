// ADR 0123: turns dist/release/Matters.app (built by `tools/bundle-macos.ts` with
// MATTERS_RELEASE=1) into what a person downloads: Matters-<version>-<arch>.dmg and
// SHA256SUMS.txt, both in dist/release.
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/release-macos.ts (the root `release:macos` script
// builds, bundles and then runs this).
//
// What it is given decides what it makes:
// - MATTERS_SIGN_IDENTITY: the identity the app was signed with. `-` (ad hoc) leaves the disk
//   image unsigned: a rehearsal, or an alpha. macOS refuses to open it until
//   the person allows it.
// - APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER: an App Store Connect API key. With all
//   three, the app and then the disk image are notarized and the ticket is stapled to each, so
//   both open on a Mac that is offline. Without them nothing is sent to Apple.
// - MATTERS_REQUIRE_NOTARIZATION=1: a real release. Fails if the signature is ad hoc or the key is
//   missing, and checks the result as Gatekeeper would.
// Nothing about the identity or the key is printed.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "Matters";
const outDir = join(root, "dist/release");
const app = join(outDir, `${NAME}.app`);

function fail(message: string): never {
  console.error(`release-macos: ${message}`);
  process.exit(1);
}

const run = (cmd: string, args: readonly string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (process.platform !== "darwin") fail("macOS only");
if (!existsSync(join(app, "Contents/MacOS", NAME)))
  fail("dist/release/Matters.app is missing or is not a release build: run `release:macos`");

const identity = process.env.MATTERS_SIGN_IDENTITY;
if (!identity) fail("MATTERS_SIGN_IDENTITY is not set (a Developer ID, or - for ad hoc)");
const adHoc = identity === "-";
const required = process.env.MATTERS_REQUIRE_NOTARIZATION === "1";

const key = {
  path: process.env.APPLE_API_KEY_PATH,
  id: process.env.APPLE_API_KEY_ID,
  issuer: process.env.APPLE_API_ISSUER,
};
const notarize = !!(key.path && key.id && key.issuer);
if (required && adHoc) fail("a release cannot be signed ad hoc");
if (required && !notarize)
  fail("a release must be notarized: APPLE_API_KEY_PATH, APPLE_API_KEY_ID, APPLE_API_ISSUER");
if (notarize && adHoc) fail("Apple does not notarize an ad-hoc signature");

const version = run("plutil", [
  "-extract",
  "CFBundleShortVersionString",
  "raw",
  join(app, "Contents/Info.plist"),
]).trim();
if (required && version === "0.0.0") fail("the version is still 0.0.0: set it before a release");
const arch = process.arch;
const dmg = join(outDir, `${NAME}-${version}-${arch}.dmg`);

const scratch = mkdtempSync(join(tmpdir(), "matters-release-"));

/** Sends a file to Apple, waits for the verdict, and fails with Apple's log if it is not accepted. */
function submit(file: string): void {
  const answer = JSON.parse(
    run("xcrun", [
      "notarytool",
      "submit",
      file,
      "--key",
      key.path ?? "",
      "--key-id",
      key.id ?? "",
      "--issuer",
      key.issuer ?? "",
      "--wait",
      "--output-format",
      "json",
    ]),
  ) as { id?: string; status?: string };
  if (answer.status === "Accepted") return;
  let log = "";
  try {
    log = run("xcrun", [
      "notarytool",
      "log",
      answer.id ?? "",
      "--key",
      key.path ?? "",
      "--key-id",
      key.id ?? "",
      "--issuer",
      key.issuer ?? "",
    ]);
  } catch {
    // The verdict below is what matters; the log is a help.
  }
  fail(`Apple answered ${answer.status ?? "nothing"} for ${basename(file)}\n${log}`);
}

/** The ticket service can drop a connection; stapling is safe to try again. */
function staple(path: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      run("xcrun", ["stapler", "staple", path]);
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      execFileSync("sleep", ["15"]);
    }
  }
}

try {
  // What we were handed must be whole before anything is built on it.
  run("codesign", ["--verify", "--deep", "--strict", app]);

  if (notarize) {
    // Apple takes an archive, not a folder. The ticket goes onto the app itself, so the app
    // also opens offline once it is out of the disk image.
    const zip = join(scratch, `${NAME}.zip`);
    run("ditto", ["-c", "-k", "--keepParent", app, zip]);
    submit(zip);
    staple(app);
  }

  // The disk image: the app, and a way to drag it to Applications.
  const stage = join(scratch, "image");
  run("ditto", [app, join(stage, `${NAME}.app`)]);
  symlinkSync("/Applications", join(stage, "Applications"));
  rmSync(dmg, { force: true });
  run("hdiutil", [
    "create",
    "-volname",
    NAME,
    "-srcfolder",
    stage,
    "-fs",
    "APFS",
    "-format",
    "UDZO",
    "-ov",
    dmg,
  ]);

  if (!adHoc) run("codesign", ["--sign", identity, "--timestamp", dmg]);
  if (notarize) {
    submit(dmg);
    staple(dmg);
  }

  if (required) {
    // As Gatekeeper would judge a download.
    run("spctl", ["--assess", "--type", "execute", app]);
    run("xcrun", ["stapler", "validate", app]);
    run("spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", dmg]);
    run("xcrun", ["stapler", "validate", dmg]);
  }

  const sum = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  writeFileSync(join(outDir, "SHA256SUMS.txt"), `${sum}  ${basename(dmg)}\n`);

  const state = notarize
    ? "signed and notarized"
    : adHoc
      ? "ad hoc: a rehearsal or an alpha"
      : "signed";
  console.log(`release-macos: ${relative(root, dmg)} (${state})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
