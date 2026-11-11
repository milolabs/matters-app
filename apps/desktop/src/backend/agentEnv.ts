import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/**
 * A packaged or development Electron app starts with the minimal PATH of a login item, which has
 * none of the places a person installs the assistant's program. These are added after what is
 * there, so the person's own order still wins (ADR 0051, rule 2: found on the machine, never
 * bundled).
 */
export function extraBinDirs(home: string): string[] {
  return [
    "/opt/homebrew/bin",
    "/usr/local/bin",
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
  ];
}

/** `env` with those directories appended to PATH, without repeating one that is already there. */
export function agentEnv(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): NodeJS.ProcessEnv {
  const have = (env.PATH ?? "").split(delimiter).filter((d) => d.length > 0);
  const missing = extraBinDirs(home).filter((d) => !have.includes(d));
  return { ...env, PATH: [...have, ...missing].join(delimiter) };
}
