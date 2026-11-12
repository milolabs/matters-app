// ADR 0124: the version of the next release, and the two files that carry it.
// Run: bun tools/next-version.ts [version] [--write]
//
// With no version it counts on from the one in apps/desktop/package.json:
// - 0.0.0, which no release has had, becomes 0.1.0-alpha.1;
// - 0.1.0-alpha.1 becomes 0.1.0-alpha.2, and the same for any other suffix that ends in a number;
// - 0.1.0 becomes 0.1.1.
// Going from alpha to beta, from beta to no suffix, or to a new minor or major version is a
// decision, so it is given by name. Prints the version; with --write also puts it in
// apps/desktop/package.json and in the workspace entry of bun.lock.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** major.minor.patch, with an optional suffix of dot-separated words and numbers. */
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*))?$/;

export const FIRST = "0.1.0-alpha.1";

export function isVersion(text: string): boolean {
  return VERSION.test(text);
}

/** The version after `current` when nobody names one. */
export function nextVersion(current: string): string {
  const match = VERSION.exec(current);
  if (!match) throw new Error(`not a version: ${current}`);
  const [, major, minor, patch, suffix] = match;
  if (current === "0.0.0") return FIRST;
  if (suffix === undefined) return `${major}.${minor}.${Number(patch) + 1}`;
  const parts = suffix.split(".");
  const last = parts[parts.length - 1] ?? "";
  if (!/^(0|[1-9]\d*)$/.test(last))
    throw new Error(`${current} does not end in a number: name the next version`);
  parts[parts.length - 1] = String(Number(last) + 1);
  return `${major}.${minor}.${patch}-${parts.join(".")}`;
}

/** The named version if there is one, else the next; never the current one again. */
export function chooseVersion(current: string, named: string | undefined): string {
  const wanted = named?.trim().replace(/^v/, "");
  if (!wanted) return nextVersion(current);
  if (!isVersion(wanted)) throw new Error(`not a version: ${wanted}`);
  if (wanted === current) throw new Error(`${wanted} is already the version`);
  return wanted;
}

/** Replaces the one version line that follows `anchor`, and nothing else. */
export function withVersion(text: string, anchor: string, version: string): string {
  const at = text.indexOf(anchor);
  if (at < 0) throw new Error(`${anchor} not found`);
  const line = /"version": "[^"]*"/;
  const rest = text.slice(at);
  if (!line.test(rest)) throw new Error(`no version after ${anchor}`);
  return text.slice(0, at) + rest.replace(line, `"version": "${version}"`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const named = args.find((arg) => !arg.startsWith("--"));
  const packagePath = join(root, "apps/desktop/package.json");
  const lockPath = join(root, "bun.lock");
  try {
    const packageText = readFileSync(packagePath, "utf8");
    const current = (JSON.parse(packageText) as { version: string }).version;
    const version = chooseVersion(current, named);
    if (write) {
      writeFileSync(packagePath, withVersion(packageText, '"name": "@matters/desktop"', version));
      writeFileSync(
        lockPath,
        withVersion(readFileSync(lockPath, "utf8"), '"name": "@matters/desktop"', version),
      );
    }
    console.log(version);
  } catch (error) {
    console.error(`next-version: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
