// Fails when core or contracts import anything they must not (ADR 0004, rule 1).
// Run: ELECTRON_RUN_AS_NODE=1 electron tools/check-boundaries.ts
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Rule {
  /** Directory holding package.json. */
  readonly pkg: string;
  /** Source directory relative to `pkg`; relative imports may not leave it. Default "src". */
  readonly src?: string;
  /** Packages (and their subpaths) these sources may import besides relative paths. */
  readonly allowed: readonly string[];
  /** Backend and main run in Node; the renderer and the pure packages do not. */
  readonly allowNode?: boolean;
  /** Check package.json dependencies (pure packages only; apps legitimately have build deps). */
  readonly checkManifest?: boolean;
}

const rules: readonly Rule[] = [
  { pkg: "packages/core", allowed: [], checkManifest: true },
  { pkg: "packages/contracts", allowed: ["@matters/core"], checkManifest: true },
  // Adapters depend on core and their one library; never on each other. The MIME parser is
  // injected into the IMAP adapter by the composition root (ADR 0004, rule 4).
  {
    pkg: "packages/adapter-imap",
    allowed: ["@matters/core", "imapflow"],
    allowNode: true,
    checkManifest: true,
  },
  // Outgoing mail: nodemailer only; it hashes nothing and renders nothing (ADR 0020).
  {
    pkg: "packages/adapter-smtp",
    allowed: ["@matters/core", "nodemailer"],
    allowNode: true,
    checkManifest: true,
  },
  // The person's own `claude` program, started as a child process (ADR 0051). Node only; it
  // brings no package of its own.
  {
    pkg: "packages/adapter-claude-code",
    allowed: ["@matters/core"],
    allowNode: true,
    checkManifest: true,
  },
  // A model on this machine through the Ollama server on the loopback address (ADR 0119). Node's
  // own fetch only; it brings no package of its own.
  {
    pkg: "packages/adapter-ollama",
    allowed: ["@matters/core"],
    allowNode: true,
    checkManifest: true,
  },
  // Markdown to HTML runs in the router and the worker alike; pure, no Node APIs.
  {
    pkg: "packages/adapter-compose",
    allowed: ["@matters/core", "markdown-it", "juice"],
    checkManifest: true,
  },
  // Discovery: Node's fetch and DNS only, no third-party package (ADR 0018).
  {
    pkg: "packages/adapter-autoconfig",
    allowed: ["@matters/core"],
    allowNode: true,
    checkManifest: true,
  },
  // The user's files: node:fs and nothing else. The message builder is brought in by the caller.
  {
    pkg: "packages/adapter-files",
    allowed: ["@matters/core"],
    allowNode: true,
    checkManifest: true,
  },
  // Text of PDF and Word files for the agent (ADR 0087): pdf.js and fflate, nothing else. The
  // HTML converter of the mime adapter is injected by the caller.
  {
    pkg: "packages/adapter-filetext",
    allowed: ["@matters/core", "pdfjs-dist", "fflate"],
    allowNode: true,
    checkManifest: true,
  },
  // Credential file and RPC; the Electron-side encryptor lives in apps/desktop/src/main.
  {
    pkg: "packages/adapter-secrets",
    allowed: ["@matters/core"],
    allowNode: true,
    checkManifest: true,
  },
  // The Public Suffix List and nothing else (ADR 0037); mime gets its lookup injected.
  {
    pkg: "packages/adapter-publicsuffix",
    allowed: ["tldts"],
    checkManifest: true,
  },
  {
    pkg: "packages/adapter-mime",
    allowed: ["@matters/core", "postal-mime", "entities"],
    allowNode: true,
    checkManifest: true,
  },
  // Renderer: contracts and core types only, never adapters, fakes, node:* or electron.
  {
    pkg: "apps/desktop",
    src: "src/renderer",
    allowed: [
      "@matters/contracts",
      "@matters/core",
      "solid-js",
      "@tanstack/solid-virtual",
      "@codemirror/state",
      "@codemirror/view",
      "@codemirror/commands",
      "@codemirror/lang-markdown",
      "dompurify",
    ],
  },
  // Backend: the composition root may wire core, contracts and adapters/fakes.
  {
    pkg: "apps/desktop",
    src: "src/backend",
    allowed: [
      "@matters/contracts",
      "@matters/core",
      "@matters/testkit",
      "@matters/adapter-autoconfig",
      "@matters/adapter-claude-code",
      "@matters/adapter-compose",
      "@matters/adapter-files",
      "@matters/adapter-filetext",
      "@matters/adapter-imap",
      "@matters/adapter-mime",
      "@matters/adapter-ollama",
      "@matters/adapter-publicsuffix",
      "@matters/adapter-secrets",
      "@matters/adapter-smtp",
      "@matters/adapter-sqlite",
    ],
    allowNode: true,
  },
];

function isAllowed(spec: string, allowed: readonly string[]): boolean {
  return allowed.some((a) => spec === a || spec.startsWith(`${a}/`));
}

const SOURCE = /\.(?:[cm]?[jt]sx?)$/;
const IMPORT_PATTERNS = [
  /\b(?:import|export)\s[^"'`;]*?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* walk(path);
    else if (SOURCE.test(name)) yield path;
  }
}

function specifiers(source: string): string[] {
  const found: string[] = [];
  for (const pattern of IMPORT_PATTERNS) {
    for (const m of source.matchAll(pattern)) if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

function violation(spec: string, file: string, srcDir: string, rule: Rule): string | null {
  if (spec.startsWith(".")) {
    if (spec.includes("?")) spec = spec.slice(0, spec.indexOf("?"));
    const target = resolve(dirname(file), spec);
    return target === srcDir || target.startsWith(`${srcDir}/`)
      ? null
      : "relative import escapes the package src";
  }
  if (spec.startsWith("node:")) return rule.allowNode ? null : "node:* is not allowed";
  if (spec === "electron" || spec.startsWith("electron/")) return "electron is not allowed";
  if (spec.startsWith("@matters/adapter-") && !isAllowed(spec, rule.allowed)) {
    return "adapters point inward, never the other way";
  }
  if (isAllowed(spec, rule.allowed)) return null;
  return "third-party or unlisted package";
}

const problems: string[] = [];
let filesChecked = 0;

for (const rule of rules) {
  const pkgDir = join(root, rule.pkg);
  const srcDir = join(pkgDir, rule.src ?? "src");
  for (const file of walk(srcDir)) {
    filesChecked++;
    for (const spec of specifiers(readFileSync(file, "utf8"))) {
      const why = violation(spec, file, srcDir, rule);
      if (why) problems.push(`${relative(root, file)}: import "${spec}" (${why})`);
    }
  }
  if (!rule.checkManifest) continue;
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  for (const dep of Object.keys(manifest.dependencies ?? {})) {
    if (!rule.allowed.includes(dep)) {
      problems.push(`${rule.pkg}/package.json: dependency "${dep}" is not allowed`);
    }
  }
}

if (problems.length > 0) {
  console.error(`Boundary violations (${problems.length}):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log(
  `Boundaries OK: ${filesChecked} files in ${rules.map((r) => join(r.pkg, r.src ?? "src")).join(", ")}`,
);
