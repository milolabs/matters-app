import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Exercise the shipped script, with synthetic releases and macOS commands at the OS boundary.
// The isolated PATH excludes the host's gh and curl; nothing downloads or opens a real app.
const installer = resolve("site/install.sh");
const stub = `#!/bin/bash
set -eu
name="\${0##*/}"
printf '%s %s\\n' "$name" "$*" >> "$FIXTURE/calls"
case "$name" in
  uname) echo "\${TEST_OS:-Darwin}" ;;
  sysctl) echo "\${TEST_ARM:-1}" ;;
  ps)
    count=0
    [ ! -f "$FIXTURE/ps-count" ] || read -r count < "$FIXTURE/ps-count"
    count=$((count + 1)); echo "$count" > "$FIXTURE/ps-count"
    if [ "\${TEST_RUNNING:-}" = always ] || { [ "\${TEST_RUNNING:-}" = later ] && [ "$count" -gt 1 ]; }; then
      echo "$MATTERS_INSTALL_DIR/Matters.app/Contents/MacOS/Matters"
    elif [ "\${TEST_RUNNING:-}" = elsewhere ]; then
      echo "/elsewhere/Matters.app/Contents/MacOS/Matters"
    fi ;;
  curl)
    out=""; url=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --output) out="$2"; shift ;; https://*) url="$1" ;; esac
      shift
    done
    file="\${url##*/}"
    [ "$file" != "\${TEST_FETCH_FAIL:-}" ] || exit 22
    cp "$FIXTURE/release/$file" "$out" ;;
  gh) [ "\${TEST_FAIL:-}" != attestation ] ;;
  hdiutil)
    if [ "$1" = attach ]; then
      [ "\${TEST_FAIL:-}" != mount ] || exit 1
      while [ "$1" != -mountpoint ]; do shift; done
      mkdir -p "$2"
      [ "\${TEST_FAIL:-}" = missing-app ] || cp -R "$FIXTURE/source/Matters.app" "$2/Matters.app"
    elif [ "\${TEST_FAIL:-}" = detach ] && [ "$3" != -force ]; then exit 1
    fi ;;
  ditto)
    mkdir -p "$2"
    [ "\${TEST_FAIL:-}" != copy ] || exit 1
    cp -R "$1/." "$2/" ;;
  codesign) [ "\${TEST_FAIL:-}" != signature ] ;;
  mv)
    if [ "\${TEST_FAIL:-}" = swap ] && [[ "$1" = */.Matters.app.installing ]]; then exit 1; fi
    if [ "\${TEST_FAIL:-}" = signal ] && [[ "$1" = */.Matters.app.installing ]]; then kill -TERM "$PPID"; exit 1; fi
    /bin/mv "$@" ;;
  open) : ;;
esac
`;

let root: string;
let dest: string;
let env: NodeJS.ProcessEnv;
const version = "0.1.0-alpha.5";
const image = `Matters-${version}-arm64.dmg`;
const calls = () =>
  existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8") : "";
const oldApp = () => {
  mkdirSync(join(dest, "Matters.app"), { recursive: true });
  writeFileSync(join(dest, "Matters.app", "build"), "old");
};
const build = () => readFileSync(join(dest, "Matters.app", "build"), "utf8");
const run = () => spawnSync("/bin/bash", [installer], { env, encoding: "utf8", timeout: 20_000 });
const clean = () => {
  for (const name of [".Matters.app.lock", ".Matters.app.installing", ".Matters.app.previous"]) {
    expect(existsSync(join(dest, name)), name).toBe(false);
  }
  expect(readdirSync(join(root, "tmp"))).toEqual([]);
};

beforeEach(() => {
  // The real path: the script resolves its folder (`pwd -P`), and on macOS the temporary folder is
  // behind a link, so the paths it prints would not be the ones this test compares with.
  root = realpathSync(mkdtempSync(join(tmpdir(), "matters-installer-")));
  dest = join(root, "Applications with spaces");
  for (const path of [dest, "bin", "release", "source/Matters.app", "tmp"]) {
    mkdirSync(path === dest ? path : join(root, path), { recursive: true });
  }
  writeFileSync(join(root, "source/Matters.app/build"), "new");
  writeFileSync(join(root, "release", image), "synthetic disk image");
  const sum = createHash("sha256").update("synthetic disk image").digest("hex");
  writeFileSync(join(root, "release/SHA256SUMS.txt"), `${sum}  ${image}\n`);
  writeFileSync(join(root, "release", `${image}.intoto.jsonl`), "synthetic build record");
  writeFileSync(join(root, "release/release.json"), JSON.stringify({ version }));
  for (const name of [
    "uname",
    "sysctl",
    "ps",
    "curl",
    "hdiutil",
    "ditto",
    "codesign",
    "mv",
    "open",
  ]) {
    writeFileSync(join(root, "bin", name), stub, { mode: 0o755 });
  }
  for (const name of [
    "cp",
    "mkdir",
    "mktemp",
    "rm",
    "rmdir",
    "grep",
    "sed",
    "head",
    "shasum",
    "cat",
  ]) {
    const found = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
    expect(found.status).toBe(0);
    symlinkSync(found.stdout.trim(), join(root, "bin", name));
  }
  env = {
    PATH: join(root, "bin"),
    FIXTURE: root,
    TMPDIR: join(root, "tmp"),
    MATTERS_INSTALL_DIR: dest,
    MATTERS_NO_OPEN: "1",
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// A run starts dozens of small programs, and takes seconds on a busy machine.
describe("the one-line installer (ADR 0139)", { timeout: 30_000 }, () => {
  it.each([
    ["Linux", "1", "macOS only"],
    ["Darwin", "0", "Apple silicon"],
  ])("refuses unsupported platform %s / arm64=%s before fetching", (os, arm, message) => {
    Object.assign(env, { TEST_OS: os, TEST_ARM: arm });
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(message);
    expect(calls()).not.toContain("curl ");
  });

  it("installs the site's version, verifies the seal and cleans temporary state", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(build()).toBe("new");
    expect(result.stdout).toContain("Not checked: where it was built");
    expect(calls()).toContain("https://getmatters.app/release.json");
    expect(calls()).toContain(
      `https://github.com/milolabs/matters-app/releases/download/v${version}/${image}`,
    );
    expect(calls()).toContain("--proto =https --tlsv1.2");
    expect(calls()).toContain("codesign --verify --deep --strict");
    expect(calls()).toContain("hdiutil detach");
    expect(calls()).not.toMatch(/^open /m);
    clean();
  });

  it.each([version, `v${version}`, "1.0.0"])(
    "accepts explicit version %s without fetching the site",
    (tag) => {
      env.MATTERS_VERSION = tag;
      if (tag === "1.0.0") {
        const stable = "Matters-1.0.0-arm64.dmg";
        writeFileSync(join(root, "release", stable), "synthetic disk image");
        writeFileSync(
          join(root, "release/SHA256SUMS.txt"),
          `${createHash("sha256").update("synthetic disk image").digest("hex")}  ${stable}\n`,
        );
      }
      const result = run();
      expect(result.status, result.stderr).toBe(0);
      expect(calls()).not.toContain("https://getmatters.app/release.json");
      expect(build()).toBe("new");
      clean();
    },
  );

  it.each(["latest", "1.2", "../1.2.3", "1.2.3; touch injected", "1.2.3-alpha"])(
    "rejects malformed version %j without fetching",
    (tag) => {
      env.MATTERS_VERSION = tag;
      const result = run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("not a version");
      expect(calls()).not.toContain("curl ");
      clean();
    },
  );

  // Known production defect: grep -E validates each line independently. Keep the intended
  // rejection visible without changing the installer in this tests-only task.
  it.fails("rejects a version containing a valid line followed by extra newline content", () => {
    env.MATTERS_VERSION = "1.2.3\nother";
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a version");
    expect(calls()).not.toContain("curl ");
  });

  it("refuses a site with no release", () => {
    writeFileSync(join(root, "release/release.json"), "{}");
    expect(run().stderr).toContain("there is no release");
    expect(calls()).not.toContain("hdiutil attach");
    clean();
  });

  it.each(["release.json", image, "SHA256SUMS.txt", `${image}.intoto.jsonl`])(
    "preserves the existing app when downloading %s fails",
    (file) => {
      oldApp();
      writeFileSync(join(root, "bin/gh"), stub, { mode: 0o755 });
      env.TEST_FETCH_FAIL = file;
      expect(run().status).toBe(1);
      expect(build()).toBe("old");
      expect(calls()).not.toContain("hdiutil attach");
      clean();
    },
  );

  it.each(["missing", "corrupt"])("refuses a %s checksum before mounting", (kind) => {
    oldApp();
    if (kind === "missing") writeFileSync(join(root, "release/SHA256SUMS.txt"), "");
    else writeFileSync(join(root, "release", image), "tampered image");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      kind === "missing" ? "does not list" : "does not match its checksum",
    );
    expect(build()).toBe("old");
    expect(calls()).not.toContain("hdiutil attach");
    clean();
  });

  it("verifies the build record for this repository and workflow when gh exists", () => {
    writeFileSync(join(root, "bin/gh"), stub, { mode: 0o755 });
    expect(run().status).toBe(0);
    expect(calls()).toContain(`gh attestation verify`);
    expect(calls()).toContain(
      "--repo milolabs/matters-app --signer-workflow milolabs/matters-app/.github/workflows/release.yml --bundle",
    );
    expect(calls()).toContain(`${image}.intoto.jsonl`);
    clean();
  });

  it("allows explicitly skipping provenance while retaining checksum and signature checks", () => {
    writeFileSync(join(root, "bin/gh"), stub, { mode: 0o755 });
    env.MATTERS_NO_ATTESTATION = "1";
    env.TEST_FAIL = "attestation";
    expect(run().status).toBe(0);
    expect(calls()).not.toContain("gh attestation verify");
    expect(calls()).not.toContain(".intoto.jsonl");
    expect(calls()).toContain("codesign --verify");
    clean();
  });

  it.each(["attestation", "mount", "missing-app", "copy", "signature", "swap", "signal"])(
    "keeps the previous installation and releases the lock on %s failure",
    (failure) => {
      oldApp();
      writeFileSync(join(root, "bin/gh"), stub, { mode: 0o755 });
      env.TEST_FAIL = failure;
      const result = run();
      expect(result.status).toBe(failure === "signal" ? 130 : 1);
      expect(build()).toBe("old");
      expect(calls()).not.toMatch(/^open /m);
      clean();
    },
  );

  it("replaces an idle copy and opens only the completed installation", () => {
    oldApp();
    delete env.MATTERS_NO_OPEN;
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(build()).toBe("new");
    expect(result.stdout).toContain("It replaced the Matters");
    expect(calls()).toContain(`open ${dest}/Matters.app`);
    clean();
  });

  it.each(["always", "later"])("refuses a running destination copy (%s)", (when) => {
    oldApp();
    env.TEST_RUNNING = when;
    expect(run().stderr).toContain("Matters is running");
    expect(build()).toBe("old");
    if (when === "always") expect(calls()).not.toContain("curl ");
    clean();
  });

  it("does not stop installation for a copy running elsewhere", () => {
    env.TEST_RUNNING = "elsewhere";
    expect(run().status).toBe(0);
    expect(build()).toBe("new");
    clean();
  });

  it("does not remove a lock belonging to another installer", () => {
    mkdirSync(join(dest, ".Matters.app.lock"));
    expect(run().stderr).toContain("another install");
    expect(existsSync(join(dest, ".Matters.app.lock"))).toBe(true);
    expect(calls()).not.toContain("curl ");
  });

  it("restores an interrupted installation before a later download failure", () => {
    mkdirSync(join(dest, ".Matters.app.previous"));
    writeFileSync(join(dest, ".Matters.app.previous/build"), "old");
    mkdirSync(join(dest, ".Matters.app.installing"));
    env.TEST_FETCH_FAIL = "release.json";
    expect(run().status).toBe(1);
    expect(build()).toBe("old");
    clean();
  });

  it("retries unmounting with force if the normal detach fails", () => {
    env.TEST_FAIL = "detach";
    expect(run().status).toBe(0);
    expect(calls()).toMatch(/hdiutil detach .* -force -quiet/);
    clean();
  });

  it("refuses a missing destination", () => {
    rmSync(dest, { recursive: true });
    expect(run().stderr).toContain("is not a folder");
    expect(calls()).not.toContain("curl ");
  });
});
