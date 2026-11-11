// ADR 0107: builds dist/Matters.app, the app as macOS sees its own: bundle id
// app.getmatters.Matters, name Matters, its icon, signed with the local code-signing identity. It
// is for running Matters on this Mac (notifications, the Dock), not for handing to anyone.
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/bundle-macos.ts (needs `electron-vite build` first;
// the root `bundle:macos` script does both).
//
// The identity: MATTERS_SIGN_IDENTITY (a hash or name `codesign` accepts), else the only
// code-signing identity in the keychain. Nothing about it is printed.
//
// The bundle is a copy of the Electron runtime this script runs on, with the built app (`out/`, a
// trimmed package.json, the icons) and the packages electron-vite leaves external copied into
// Contents/Resources/app. The main executable keeps the name Electron on purpose: Electron's
// `app.isPackaged` is true only when it is renamed, and the app then drops its dev switches
// (MATTERS_USER_DATA and the rest). Kept as it is, the bundle runs the same code paths as
// `electron apps/desktop` today: same name, same userData, same Keychain item.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// Electron's fs reads an .asar as a folder; here it is a file to delete like any other.
(process as { noAsar?: boolean }).noAsar = true;

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktop = join(root, "apps/desktop");
const BUNDLE_ID = "app.getmatters.Matters";
const NAME = "Matters";
// At the root, git-ignored (`dist/`) and outside what biome and vitest look at.
const output = join(root, "dist", `${NAME}.app`);

function fail(message: string): never {
  console.error(`bundle-macos: ${message}`);
  process.exit(1);
}

const run = (cmd: string, args: readonly string[]) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

if (process.platform !== "darwin") fail("macOS only");
if (!existsSync(join(desktop, "out/main/index.js")))
  fail("apps/desktop/out is missing: run `electron-vite build` first (or `bundle:macos`)");

// The runtime this script runs on is the one the repo pins: .../Electron.app/Contents/MacOS/Electron.
const runtime = resolve(process.execPath, "../../..");
if (!runtime.endsWith(".app") || basename(process.execPath) !== "Electron")
  fail(`run this with Electron (ELECTRON_RUN_AS_NODE=1 electron), not ${process.execPath}`);

/** The identity to sign with; never printed, it carries a person's name. */
function signingIdentity(): string {
  const chosen = process.env.MATTERS_SIGN_IDENTITY;
  if (chosen) return chosen;
  const found = run("security", ["find-identity", "-v", "-p", "codesigning"])
    .split("\n")
    .map((line) => /^\s*\d+\)\s+([0-9A-F]{40})\s/.exec(line)?.[1])
    .filter((hash): hash is string => hash !== undefined);
  if (found.length === 1 && found[0]) return found[0];
  return fail(
    found.length === 0
      ? "no code-signing identity in the keychain (an Apple Development certificate will do)"
      : "more than one code-signing identity: set MATTERS_SIGN_IDENTITY to the one to use",
  );
}
const identity = signingIdentity();

// Built next to the output and renamed into place, so a failed run never leaves half an app there.
mkdirSync(dirname(output), { recursive: true });
const staging = join(dirname(output), `.${NAME}.app.building`);
rmSync(staging, { recursive: true, force: true });
// ditto keeps the frameworks' symlinks as they are.
run("ditto", [runtime, staging]);

const contents = join(staging, "Contents");
const resources = join(contents, "Resources");
const frameworks = join(contents, "Frameworks");
const plist = (file: string, ...edits: (readonly string[])[]) => {
  for (const edit of edits) run("plutil", [...edit, file]);
};

// --- Identity: the main bundle and its helpers ---------------------------------------------------

const desktopPackage = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8")) as {
  name: string;
  productName: string;
  version: string;
  type: string;
  main: string;
};
if (desktopPackage.productName !== NAME)
  fail(`apps/desktop/package.json has productName ${desktopPackage.productName}, not ${NAME}`);

rmSync(join(resources, "default_app.asar"));
rmSync(join(resources, "electron.icns"));
cpSync(join(desktop, "build/icons/icon.icns"), join(resources, `${NAME}.icns`));
plist(
  join(contents, "Info.plist"),
  ["-replace", "CFBundleIdentifier", "-string", BUNDLE_ID],
  ["-replace", "CFBundleName", "-string", NAME],
  ["-replace", "CFBundleDisplayName", "-string", NAME],
  ["-replace", "CFBundleIconFile", "-string", `${NAME}.icns`],
  ["-replace", "CFBundleShortVersionString", "-string", desktopPackage.version],
  ["-replace", "CFBundleVersion", "-string", desktopPackage.version],
  ["-replace", "LSApplicationCategoryType", "-string", "public.app-category.productivity"],
  // It named default_app.asar, which is gone; the fuse that checks it is off in this runtime.
  ["-remove", "ElectronAsarIntegrity"],
);

// "Electron Helper (GPU).app" becomes "Matters Helper (GPU).app", with its executable and id.
for (const entry of readdirSync(frameworks)) {
  const match = /^Electron Helper( \((\w+)\))?\.app$/.exec(entry);
  if (!match) continue;
  const suffix = match[1] ?? "";
  const kind = match[2];
  const helperName = `${NAME} Helper${suffix}`;
  const helper = join(frameworks, `${helperName}.app`);
  renameSync(join(frameworks, entry), helper);
  renameSync(
    join(helper, "Contents/MacOS", `Electron Helper${suffix}`),
    join(helper, "Contents/MacOS", helperName),
  );
  plist(
    join(helper, "Contents/Info.plist"),
    ["-replace", "CFBundleIdentifier", "-string", `${BUNDLE_ID}.helper${kind ? `.${kind}` : ""}`],
    ["-replace", "CFBundleName", "-string", helperName],
    ["-replace", "CFBundleDisplayName", "-string", helperName],
    ["-replace", "CFBundleExecutable", "-string", helperName],
  );
}

// --- The app: what `electron apps/desktop` loads, and nothing that points back into the repo -----

const app = join(resources, "app");
mkdirSync(app);
cpSync(join(desktop, "out"), join(app, "out"), { recursive: true });
cpSync(join(desktop, "build/icons"), join(app, "build/icons"), { recursive: true });
// Electron takes the name, the version and the entry from here: the same fields as the repo's.
writeFileSync(
  join(app, "package.json"),
  `${JSON.stringify(
    {
      name: desktopPackage.name,
      productName: desktopPackage.productName,
      version: desktopPackage.version,
      type: desktopPackage.type,
      main: desktopPackage.main,
    },
    null,
    2,
  )}\n`,
);

/** The bare specifiers the built code imports: what electron-vite left external. */
function externalImports(dir: string): Set<string> {
  const found = new Set<string>();
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([a-z0-9@][^"'\s]*)["']/g;
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(c|m)?js$/.test(entry.name)) continue;
    const text = readFileSync(join(entry.parentPath, entry.name), "utf8");
    for (const m of text.matchAll(pattern)) {
      const spec = m[1] ?? "";
      if (spec.startsWith("node:") || spec === "electron") continue;
      const parts = spec.split("/");
      const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : (parts[0] ?? "");
      // Builtins imported without the prefix.
      if (!process.getBuiltinModule(name)) found.add(name);
    }
  }
  return found;
}

/** The installed package `name` as Node would find it from `fromDir`, by its real path. */
function findPackage(name: string, fromDir: string): string | null {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
}

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
}

// A flat node_modules where it can be, nested where two versions of one package are needed.
const placed = new Map<string, string>(); // name -> real path of what sits at the top
let packages = 0;
function place(name: string, real: string, parentModules: string): void {
  const top = placed.get(name);
  if (top === real) return;
  const modules = top === undefined ? join(app, "node_modules") : parentModules;
  const dest = join(modules, name);
  if (existsSync(dest)) return;
  if (top === undefined) placed.set(name, real);
  // The store's own node_modules are links to siblings; dependencies are placed below instead.
  cpSync(real, dest, {
    recursive: true,
    dereference: true,
    filter: (src) => !relative(real, src).split(sep).includes("node_modules"),
  });
  packages += 1;
  const manifest = JSON.parse(readFileSync(join(real, "package.json"), "utf8")) as Manifest;
  const required = Object.keys(manifest.dependencies ?? {});
  const optional = Object.keys(manifest.optionalDependencies ?? {});
  for (const dep of [...required, ...optional]) {
    const depReal = findPackage(dep, real);
    if (depReal === null) {
      // An optional one for another platform is simply not installed.
      if (required.includes(dep)) fail(`${name} needs ${dep}, which is not installed`);
      continue;
    }
    place(dep, depReal, join(dest, "node_modules"));
  }
}
// The pages are bundled whole and cannot import packages; main, the backend and preload can.
const externals = new Set([
  ...externalImports(join(desktop, "out/main")),
  ...externalImports(join(desktop, "out/preload")),
]);
for (const name of [...externals].sort()) {
  const real = findPackage(name, desktop);
  if (real === null) fail(`the built app imports ${name}, which is not installed`);
  place(name, real, join(app, "node_modules"));
}

// --- Signing, inside out -------------------------------------------------------------------------

/** Mach-O (thin or fat) by its first bytes; a Java class file shares the fat magic. */
function isMachO(file: string): boolean {
  const fd = openSync(file, "r");
  const head = Buffer.alloc(8);
  const n = readSync(fd, head, 0, 8, 0);
  closeSync(fd);
  if (n < 8) return false;
  const magic = head.readUInt32BE(0);
  if ([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe].includes(magic)) return true;
  return magic === 0xcafebabe && head.readUInt32BE(4) < 32;
}

// V8 compiles code at run time; the hardened runtime allows that only with these.
const entitlements = join(tmpdir(), `matters-entitlements-${process.pid}.plist`);
writeFileSync(
  entitlements,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
</dict>
</plist>
`,
);

let signed = 0;
function sign(path: string): void {
  run("codesign", [
    "--sign",
    identity,
    "--force",
    "--timestamp=none",
    "--options",
    "runtime",
    "--entitlements",
    entitlements,
    path,
  ]);
  signed += 1;
}

/** Everything below `dir` that needs a signature, deepest first, then `dir` if it is a bundle. */
function signTree(dir: string, mainBinaries: ReadonlySet<string>): void {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      if (entry.endsWith(".app")) {
        const exe = join(path, "Contents/MacOS");
        signTree(path, new Set(readdirSync(exe).map((e) => join(exe, e))));
        sign(path);
      } else if (entry.endsWith(".framework")) {
        const version = realpathSync(join(path, "Versions/Current"));
        signTree(path, new Set([join(version, entry.replace(/\.framework$/, ""))]));
        sign(path);
      } else {
        signTree(path, mainBinaries);
      }
    } else if (stat.isFile() && !mainBinaries.has(path) && isMachO(path)) {
      sign(path);
    }
  }
}

try {
  // Finder information or a quarantine flag on any file would make codesign refuse.
  run("xattr", ["-cr", staging]);
  const mainExe = join(contents, "MacOS");
  signTree(staging, new Set(readdirSync(mainExe).map((e) => join(mainExe, e))));
  sign(staging);
  run("codesign", ["--verify", "--deep", "--strict", staging]);
} finally {
  rmSync(entitlements, { force: true });
}

rmSync(output, { recursive: true, force: true });
renameSync(staging, output);
console.log(
  `bundle-macos: ${relative(root, output)} (${BUNDLE_ID}): ${packages} packages, ${signed} signatures`,
);
