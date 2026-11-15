import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const installer = resolve("site/install.sh");
const image = "synthetic disk image";
const checksum = createHash("sha256").update(image).digest("hex");

// Exercise the actual shell script. Only macOS and network commands are replaced;
// checksum verification, filesystem operations, traps and pipelines run for real.
const commands = `#!/bin/bash
set -eu
name="$(basename "$0")"
printf '%s' "$name" >> "$FIXTURE/log"
printf ' <%s>' "$@" >> "$FIXTURE/log"
printf '\\n' >> "$FIXTURE/log"
case "$name" in
  uname) echo "\${OS:-Darwin}" ;;
  sysctl) echo "\${ARM:-1}" ;;
  ps)
    count=0
    [ ! -f "$FIXTURE/ps-count" ] || count=$(cat "$FIXTURE/ps-count")
    count=$((count + 1)); echo "$count" > "$FIXTURE/ps-count"
    if [ "$count" = "\${RUNNING_AT:-0}" ]; then
      echo "$MATTERS_INSTALL_DIR/Matters.app/Contents/MacOS/Matters"
    else
      echo "/somewhere/else/Matters.app/Contents/MacOS/Matters"
    fi ;;
  curl)
    out=""; url=""
    while [ "$#" -gt 0 ]; do
      case "$1" in --output) out="$2"; shift 2 ;; *) url="$1"; shift ;; esac
    done
    case "$url" in
      *release.json) cp "$FIXTURE/release.json" "$out" ;;
      *SHA256SUMS.txt) cp "$FIXTURE/sums" "$out" ;;
      *.intoto.jsonl) echo '{}' > "$out" ;;
      *.dmg) [ "\${FAIL:-}" != download ] || exit 1; cp "$FIXTURE/image" "$out" ;;
      *) exit 99 ;;
    esac ;;
  gh) [ "\${FAIL:-}" != attestation ] ;;
  hdiutil)
    if [ "$1" = attach ]; then
      [ "\${FAIL:-}" != mount ] || exit 1
      while [ "$1" != -mountpoint ]; do shift; done
      mkdir -p "$2"
      if [ "\${FAIL:-}" != missing-app ]; then
        mkdir -p "$2/Matters.app"; echo new > "$2/Matters.app/build"
      fi
    elif [ "\${FAIL:-}" = detach ] && [ "$3" != -force ]; then exit 1
    fi ;;
  ditto) [ "\${FAIL:-}" != copy ] || exit 1; cp -R "$1" "$2" ;;
  codesign) [ "\${FAIL:-}" != signature ] ;;
  mv)
    if [ "\${FAIL:-}" = swap ] && [ "$1" = "$MATTERS_INSTALL_DIR/.Matters.app.installing" ]; then exit 1; fi
    /bin/mv "$@" ;;
  open) : ;;
  *) exit 99 ;;
esac
`;

describe("one-line installer (ADR 0139)", () => {
  let root: string;
  let dest: string;
  let bin: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "matters-installer-"));
    dest = join(root, "Applications with spaces");
    bin = join(root, "bin");
    mkdirSync(dest);
    mkdirSync(bin);
    mkdirSync(join(root, "tmp"));
    writeFileSync(join(root, "command"), commands, { mode: 0o755 });
    for (const name of [
      "uname",
      "sysctl",
      "ps",
      "curl",
      "gh",
      "hdiutil",
      "ditto",
      "codesign",
      "mv",
      "open",
    ]) {
      symlinkSync(join(root, "command"), join(bin, name));
    }
    writeFileSync(join(root, "image"), image);
    writeFileSync(join(root, "sums"), `${checksum}  Matters-0.1.0-alpha.5-arm64.dmg\n`);
    writeFileSync(join(root, "release.json"), '{\n  "version": "0.1.0-alpha.5"\n}\n');
    writeFileSync(join(root, "log"), "");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(settings: Record<string, string> = {}) {
    // Do not inherit user settings or credentials; no command can download or open a real app.
    const result = spawnSync("/bin/bash", [installer], {
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: join(root, "tmp"),
        FIXTURE: root,
        MATTERS_INSTALL_DIR: dest,
        MATTERS_NO_OPEN: "1",
        ...settings,
      },
      encoding: "utf8",
      timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, output: result.stdout + result.stderr };
  }
  const log = () => readFileSync(join(root, "log"), "utf8");
  const build = () => readFileSync(join(dest, "Matters.app/build"), "utf8").trim();
  function oldCopy(name = "Matters.app") {
    mkdirSync(join(dest, name));
    writeFileSync(join(dest, name, "build"), "old");
  }
  function clean() {
    expect(readdirSync(dest)).toEqual(["Matters.app"]);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  }

  it("installs the offered release, verifies provenance and signature, and cleans up", () => {
    expect(run().status).toBe(0);
    expect(build()).toBe("new");
    expect(log()).toContain("https://getmatters.app/release.json");
    expect(log()).toContain("--proto> <=https> <--tlsv1.2>");
    expect(log()).toContain("<--repo> <milolabs/matters-app>");
    expect(log()).toContain(
      "<--signer-workflow> <milolabs/matters-app/.github/workflows/release.yml>",
    );
    expect(log()).toContain("codesign <--verify> <--deep> <--strict>");
    expect(log()).toContain("hdiutil <detach>");
    expect(log()).not.toContain("open <");
    clean();
  });

  it.each(["0.1.0-alpha.5", "v0.1.0-alpha.5"])(
    "accepts explicit %s without fetching site metadata",
    (version) => {
      expect(run({ MATTERS_VERSION: version, MATTERS_NO_ATTESTATION: "1" }).status).toBe(0);
      expect(log()).not.toContain("release.json");
      expect(log()).not.toContain("gh <");
      expect(log()).not.toContain("intoto.jsonl");
      expect(build()).toBe("new");
      clean();
    },
  );

  it.each(["latest", "../0.1.0", "0.1", "0.1.0;touch injected", "0.1.0-alpha"])(
    "refuses unsafe or malformed version %s before downloading",
    (version) => {
      expect(run({ MATTERS_VERSION: version }).output).toContain("is not a version");
      expect(log()).not.toContain("curl <");
      expect(readdirSync(dest)).toEqual([]);
    },
  );

  it.each([{ OS: "Linux" }, { ARM: "0" }])("refuses unsupported machines: %j", (settings) => {
    expect(run(settings).status).toBe(1);
    expect(log()).not.toContain("curl <");
    expect(readdirSync(dest)).toEqual([]);
  });

  it("refuses an absent install folder", () => {
    expect(run({ MATTERS_INSTALL_DIR: join(root, "absent") }).output).toContain("is not a folder");
    expect(log()).not.toContain("curl <");
  });

  it("keeps another install's lock and app", () => {
    oldCopy();
    mkdirSync(join(dest, ".Matters.app.lock"));
    expect(run().output).toContain("another install");
    expect(existsSync(join(dest, ".Matters.app.lock"))).toBe(true);
    expect(build()).toBe("old");
    expect(log()).not.toContain("curl <");
  });

  it.each([1, 2])("preserves the installed app when it is running at check %i", (check) => {
    oldCopy();
    expect(run({ RUNNING_AT: String(check) }).output).toContain("Matters is running");
    expect(build()).toBe("old");
    clean();
  });

  it.each(["download", "attestation", "mount", "missing-app", "copy", "signature", "swap"])(
    "preserves the old copy and cleans up after %s failure",
    (failure) => {
      oldCopy();
      expect(run({ FAIL: failure }).status).toBe(1);
      expect(build()).toBe("old");
      expect(log()).not.toContain("open <");
      clean();
    },
  );

  it.each(["missing", "mismatch"])("refuses a %s checksum before mounting", (kind) => {
    oldCopy();
    writeFileSync(
      join(root, "sums"),
      kind === "missing"
        ? `${checksum}  Other.dmg\n`
        : `${"0".repeat(64)}  Matters-0.1.0-alpha.5-arm64.dmg\n`,
    );
    expect(run().status).toBe(1);
    expect(log()).not.toContain("hdiutil <attach>");
    expect(build()).toBe("old");
    clean();
  });

  it("reports an unpublished release and releases its lock", () => {
    writeFileSync(join(root, "release.json"), "{}");
    expect(run().output).toContain("no release to install");
    expect(readdirSync(dest)).toEqual([]);
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });

  it("restores an interrupted replacement before a later download fails", () => {
    oldCopy(".Matters.app.previous");
    oldCopy(".Matters.app.installing");
    expect(run({ FAIL: "download" }).status).toBe(1);
    expect(build()).toBe("old");
    clean();
  });

  it("replaces an old app and opens only the installed copy when requested", () => {
    oldCopy();
    expect(run({ MATTERS_NO_OPEN: "" }).output).toContain("It replaced the Matters");
    expect(build()).toBe("new");
    expect(log()).toContain(`open <${dest}/Matters.app>`);
    clean();
  });

  it("retries a failed detach with force during cleanup", () => {
    expect(run({ FAIL: "detach" }).status).toBe(0);
    expect(log()).toMatch(/hdiutil <detach>[^\n]*<-force> <-quiet>/);
    clean();
  });
});
