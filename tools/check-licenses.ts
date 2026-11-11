// Walks installed packages and checks licenses against ADR 0013.
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/check-licenses.ts
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED = new Set(
  [
    "MIT",
    "MIT-0",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
    "Apache-2.0",
    "0BSD",
    "Unlicense",
    "CC0-1.0",
    "Zlib",
    "BlueOak-1.0.0",
    "OFL-1.1",
    "Public Domain",
  ].map((s) => s.toLowerCase()),
);

// Allowed with a note in the PR: reported, never failing.
const WITH_NOTE = new Set(
  [
    "MPL-2.0",
    "LGPL-2.1",
    "LGPL-2.1-only",
    "LGPL-2.1-or-later",
    "LGPL-3.0",
    "LGPL-3.0-only",
    "LGPL-3.0-or-later",
    "GPL-3.0",
    "GPL-3.0-only",
    "GPL-3.0-or-later",
    "AGPL-3.0",
    "AGPL-3.0-only",
    "AGPL-3.0-or-later",
    // ADR 0021 (argparse under markdown-it, used only by its CLI).
    "PSF-2.0",
    "Python-2.0",
  ].map((s) => s.toLowerCase()),
);

// Data-only packages allowed by name under an attribution license (ADR 0015).
const DATA_PACKAGES = new Map([["caniuse-lite", "cc-by-4.0"]]);

type Verdict = "ok" | "note" | "bad";
const rank: Record<Verdict, number> = { ok: 0, note: 1, bad: 2 };

function atom(raw: string): Verdict {
  let id = raw
    .trim()
    .replace(/^\(+|\)+$/g, "")
    .trim()
    .toLowerCase();
  if (id.endsWith("+")) id = `${id.slice(0, -1)}-or-later`;
  if (id === "public domain" || id === "publicdomain") return "ok";
  if (ALLOWED.has(id)) return "ok";
  if (WITH_NOTE.has(id)) return "note";
  return "bad";
}

// OR: best option wins. AND: worst part wins. Parentheses are only stripped, not nested.
function judge(expr: string): Verdict {
  const options = expr.split(/\s+OR\s+/i).map((option) =>
    option
      .split(/\s+AND\s+/i)
      .map(atom)
      .reduce<Verdict>((worst, v) => (rank[v] > rank[worst] ? v : worst), "ok"),
  );
  return options.reduce<Verdict>((best, v) => (rank[v] < rank[best] ? v : best), "bad");
}

interface Manifest {
  name?: string;
  version?: string;
  license?: unknown;
  licenses?: unknown;
}

function licenseOf(m: Manifest): string | null {
  const one = (v: unknown): string | null =>
    typeof v === "string"
      ? v
      : v && typeof v === "object" && typeof (v as { type?: unknown }).type === "string"
        ? (v as { type: string }).type
        : null;
  const direct = one(m.license);
  if (direct) return direct;
  if (Array.isArray(m.licenses)) {
    const all = m.licenses.map(one).filter((s): s is string => s !== null);
    if (all.length > 0) return all.join(" OR ");
  }
  return null;
}

const seen = new Set<string>();
const packages: { name: string; version: string; license: string | null }[] = [];

function visitPackage(dir: string): void {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return;
  }
  // Workspace packages (symlinks back into the repo) are ours, not dependencies.
  if (!real.includes(`${"/"}node_modules${"/"}`) || seen.has(real)) return;
  seen.add(real);
  const manifestPath = join(real, "package.json");
  if (existsSync(manifestPath)) {
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
    packages.push({
      name: m.name ?? dir,
      version: m.version ?? "?",
      license: licenseOf(m),
    });
  }
  scanModules(join(real, "node_modules"));
}

function scanModules(nm: string): void {
  if (!existsSync(nm)) return;
  for (const name of readdirSync(nm)) {
    if (name === ".bin" || name === ".cache") continue;
    if (name === ".bun") {
      // Isolated installs: .bun/<pkg>@<version>/node_modules/<pkg>
      for (const entry of readdirSync(join(nm, name)))
        scanModules(join(nm, name, entry, "node_modules"));
    } else if (name.startsWith("@")) {
      for (const sub of readdirSync(join(nm, name))) visitPackage(join(nm, name, sub));
    } else if (!name.startsWith(".")) {
      visitPackage(join(nm, name));
    }
  }
}

scanModules(join(root, "node_modules"));

const offenders: string[] = [];
const notices: string[] = [];
for (const p of packages) {
  const label = `${p.name}@${p.version}`;
  if (p.license === null) {
    offenders.push(`${label}: no license field`);
    continue;
  }
  const verdict = judge(p.license);
  if (verdict === "bad" && DATA_PACKAGES.get(p.name) === p.license.trim().toLowerCase()) {
    notices.push(`${label}: ${p.license} (data package, ADR 0015)`);
  } else if (verdict === "bad") offenders.push(`${label}: ${p.license}`);
  else if (verdict === "note") notices.push(`${label}: ${p.license}`);
}

if (notices.length > 0) {
  console.log(`Allowed with a note in the PR (${notices.length}):`);
  for (const n of notices) console.log(`  ${n}`);
}
if (offenders.length > 0) {
  console.error(`License offenders (${offenders.length}):`);
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}
console.log(`Licenses OK: ${packages.length} packages checked`);
