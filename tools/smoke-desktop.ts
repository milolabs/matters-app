// ADR 0012 smoke in two phases against one temporary database: a cold start (empty database,
// the backend seeds it) and a warm start (same database, no seeding). Only the warm start is
// held to the launch budget. Run: ELECTRON_RUN_AS_NODE=1 electron tools/smoke-desktop.ts
// (needs `electron-vite build` first; the root `smoke:desktop` script does both).
//
// Attachments (ADR 0041): both phases attach 120 MB (three pasted images of 40 MB, the one way a
// page can drive main's grants), time the chips in the frame of the call and `j` / `k` around the
// copies, sample the backend process's memory, and check what dragging files does to the page.
// Not driven here: an upload of the 100 MB to a test server. This seeded run has no SMTP account,
// and the repository has an SMTP sink only for adapter tests (packages/adapter-smtp/test/support),
// so the send half of the contract (the progress ring, Stop) is covered by unit tests only.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PREFIX = "MATTERS_SMOKE_RESULT ";
// Matters waits for the demo runtime to read the mailbox in the background (about twenty seconds: 430 threads, three demo turns of 120 ms at once).
const PHASE_TIMEOUT_MS = 80_000;

interface Phase {
  readonly result: Record<string, unknown> | undefined;
  readonly seeded: number | undefined;
  readonly backendReadyMs: number | undefined;
  readonly exitCode: number | null;
  readonly log: string;
}

function runPhase(phase: "cold" | "warm", dbPath: string): Promise<Phase> {
  return new Promise((resolvePhase) => {
    // The app must start as Electron, not as a plain Node runtime.
    const { ELECTRON_RUN_AS_NODE: _drop, ...env } = process.env;
    const child = spawn(process.execPath, [join(root, "apps/desktop")], {
      env: {
        ...env,
        MATTERS_SMOKE: "1",
        MATTERS_SMOKE_PHASE: phase,
        MATTERS_SMOKE_TIMEOUT_MS: "70000",
        MATTERS_DB_PATH: dbPath,
        MATTERS_USER_DATA: join(dirname(dbPath), "userData"),
        // Demo mail exists for this run only; the app never seeds a real database.
        MATTERS_SEED: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d: Buffer) => {
      log += d;
    });
    child.stderr.on("data", (d: Buffer) => {
      log += d;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), PHASE_TIMEOUT_MS);
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      const line = log.split("\n").find((l) => l.startsWith(PREFIX));
      const backend = /matters-backend: .*seeded=(\d+) ready=(\d+)ms/.exec(log);
      resolvePhase({
        result: line
          ? (JSON.parse(line.slice(PREFIX.length)) as Record<string, unknown>)
          : undefined,
        seeded: backend ? Number(backend[1]) : undefined,
        backendReadyMs: backend ? Number(backend[2]) : undefined,
        exitCode,
        log,
      });
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "matters-smoke-"));
const failures: string[] = [];
try {
  const dbPath = join(dir, "matters.db");
  const cold = await runPhase("cold", dbPath);
  const warm = await runPhase("warm", dbPath);

  for (const [name, p] of [
    ["cold", cold],
    ["warm", warm],
  ] as const) {
    if (!p.result) failures.push(`${name}: no result from the app (exit ${p.exitCode})`);
    else if (p.result.ok !== true) failures.push(`${name}: ${JSON.stringify(p.result.failures)}`);
    if (p.exitCode !== 0) failures.push(`${name}: exit code ${p.exitCode}`);
  }
  if (!cold.seeded) failures.push("cold: the backend did not seed the empty database");
  if (warm.seeded !== 0) failures.push(`warm: expected no seeding, got seeded=${warm.seeded}`);

  const report = (p: Phase) => ({
    ...p.result,
    backend: { seeded: p.seeded, readyMs: p.backendReadyMs },
  });
  console.log(
    JSON.stringify(
      { ok: failures.length === 0, failures, cold: report(cold), warm: report(warm) },
      null,
      2,
    ),
  );
  if (failures.length > 0) {
    for (const [name, p] of [
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      if (p.result?.ok !== true) console.error(`--- ${name} output ---\n${p.log}`);
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failures.length === 0 ? 0 : 1);
