// ADR 0047: the hostile-mail corpus in the real app. Starts the Docker IMAP test server, puts every
// browser-tier message of the corpus on it, starts the built app with a fresh database and lets it
// sync, open each message and follow its links, twice (images off, images allowed from the sender)
// and once more with the walls tested alone. A canary HTTP server on 127.0.0.1 counts every request
// that reaches it, and the app's main process reports every navigation, network request and link
// handed to the system (a dev-only spy, `MATTERS_SMOKE_MODE=security`). Each check of the manifest
// is then judged by the ratchet. Needs Docker and `electron-vite build` first; the root
// `smoke:security` script does both.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Admin } from "../packages/adapter-imap/test/support/admin.ts";
import {
  type Check,
  type CorpusCase,
  caseBytes,
  judge,
  loadManifest,
  TierSummary,
} from "../packages/testkit/src/corpus.ts";
import { startImapTestServer } from "./imap-test-server/run.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RESULT = "MATTERS_SMOKE_RESULT ";
const SIGNAL = "MATTERS_SMOKE_SIGNAL ";
const EVENT = "MATTERS_SECURITY_EVENT ";
const APP_TIMEOUT_MS = 900_000;

// ---- the canary: counts every request it gets, by case, and says what kind of request it was ----
interface Hit {
  readonly id: string;
  readonly path: string;
  readonly dest: string;
  readonly lane: string;
}
const hits: Hit[] = [];
/** The lane of the case in progress; kept after it ends, so a late request still lands in its own lane. */
let currentLane = "setup";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgAAIAAAUAAXpeqz8AAAAASUVORK5CYII=",
  "base64",
);
const canary = createServer((req: IncomingMessage, res) => {
  const url = new URL(req.url ?? "/", "http://canary");
  const match = /^\/__c\/([^/]+)(\/.*)?$/.exec(url.pathname);
  const dest = String(req.headers["sec-fetch-dest"] ?? "unknown");
  hits.push({
    id: match?.[1] ?? "?",
    path: `${match?.[2] ?? url.pathname}${url.search}`,
    dest,
    lane: currentLane,
  });
  if (dest === "image" || /\.png$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "image/png" }).end(PNG);
  } else res.writeHead(200, { "content-type": "text/plain" }).end("canary");
});
await new Promise<void>((r) => canary.listen(0, "127.0.0.1", r));
const canaryPort = (canary.address() as { port: number }).port;
const ORIGIN = `127.0.0.1:${canaryPort}`;

// ---- which messages the app must open ----
const manifest = loadManifest();
const cases = manifest.filter((c) => c.tiers.browser && (c.file || c.generator));
const byId = new Map(cases.map((c) => [c.id, c]));

/** The message with the canary host written in, and the case id in the path: every request names its case. */
const withCanary = (c: CorpusCase) => caseBytes(c, `${ORIGIN}/__c/${c.id}`);
// The token is matched without regard to case ("CANARY.TEST"), which caseBytes does not do.
const fixCase = (c: CorpusCase) =>
  Buffer.from(
    withCanary(c)
      .toString("latin1")
      .replace(/canary\.test/gi, `${ORIGIN}/__c/${c.id}`),
    "latin1",
  );

// ---- records from the page and events from main, in the order the app wrote them ----
interface PageRecord {
  id: string;
  lane: string;
  openMs?: number;
  scriptRan: boolean;
  cspViolations: number;
  noticeShown?: boolean;
  senderText?: string;
  attachments?: string[];
  framePage?: string;
  anchorsInFrame?: number;
  forbiddenElements?: number;
  linksFollowed?: number;
  linkWarnings?: number;
  error?: string;
}
interface MainEvent {
  readonly kind: "navigate" | "request" | "open-external";
  readonly url?: string;
  readonly href?: string;
  readonly mainFrame?: boolean;
  readonly prevented?: boolean;
  readonly type?: string;
  readonly id: string;
  readonly lane: string;
}
const records = new Map<string, PageRecord>(); // `${id}|${lane}`
const events: MainEvent[] = [];
let marker = { id: "", lane: "" };
let ready = 0;
const errorsSeen: string[] = [];

function onLine(line: string): void {
  if (line.startsWith(SIGNAL)) {
    const m = /^security:([a-z]+):(.*)$/.exec(line.slice(SIGNAL.length));
    if (!m) return;
    const data = JSON.parse(m[2] ?? "null") as Record<string, unknown>;
    if (m[1] === "begin") {
      marker = { id: String(data.id), lane: String(data.lane) };
      currentLane = marker.lane;
    } else if (m[1] === "end") {
      const record = data as unknown as PageRecord;
      records.set(`${record.id}|${record.lane}`, record);
    } else if (m[1] === "ready") ready = Number(data.count);
  } else if (line.startsWith(EVENT)) {
    const d = JSON.parse(line.slice(EVENT.length)) as Record<string, unknown>;
    const last = events.at(-1);
    const event = { ...d, id: marker.id, lane: marker.lane } as unknown as MainEvent;
    void last;
    events.push(event);
  } else if (/^renderer (?:error|warning):/.test(line)) errorsSeen.push(line.slice(0, 240));
}

// ---- measuring ----
const plain = (u: string) =>
  u.replace(new RegExp(`https?://${ORIGIN.replace(".", "\\.")}/__c/[^/]+`, "g"), "CANARY");
const OWN_PAGE =
  /\/out\/renderer\/(?:index|mail|mail-images|preview|settings)\.html(?:[?#]|$)|^about:/;

function measure(c: CorpusCase): Record<string, unknown> {
  const mode = c.tiers.browser?.mode ?? "pipeline";
  const lanes =
    mode === "bypass"
      ? { blocked: "bypass-blocked", images: "bypass-images" }
      : { blocked: "blocked", images: "images" };
  const rec = (lane: string) => records.get(`${c.id}|${lane}`);
  const mine = (lane: "blocked" | "images") =>
    hits.filter((h) => h.id === c.id && h.lane === lanes[lane]);
  const blocked = rec(lanes.blocked);
  const images = rec(lanes.images);
  const needsImages = c.tiers.browser?.checks.some((k) => k.name.startsWith("images"));
  for (const [name, r] of [
    [lanes.blocked, blocked],
    ...(needsImages ? [[lanes.images, images] as const] : []),
  ] as const) {
    if (!r) throw new Error(`${c.id}: the page never reported the ${name} lane`);
    if (r.error) throw new Error(`${c.id}: the page failed in the ${name} lane: ${r.error}`);
  }
  if (needsImages && !images?.framePage?.includes("mail-images") && mode === "pipeline") {
    throw new Error(`${c.id}: the images lane did not load the images page (${images?.framePage})`);
  }
  if (mode === "pipeline" && !blocked?.framePage?.endsWith("mail.html") && c.category === "html") {
    throw new Error(`${c.id}: no frame was painted in the blocked lane`);
  }
  const hitsBlocked = mine("blocked");
  const hitsImages = mine("images");
  const xss = (h: Hit) => h.path.startsWith("/xss");
  const mainEvents = events.filter((e) => e.id === c.id);
  const navigationsAllowed = [
    ...new Set(
      mainEvents
        .filter((e) => e.kind === "navigate" && !e.prevented && !OWN_PAGE.test(e.url ?? ""))
        .map((e) => plain(e.url ?? "")),
    ),
  ];
  const opened = mainEvents
    .filter((e) => e.kind === "open-external" && e.lane === "blocked")
    .map((e) => plain(e.href ?? ""));
  const requestsInImages = mainEvents.filter(
    (e) => e.kind === "request" && e.lane === lanes.images,
  ).length;
  const imageHits = hitsImages.filter((h) => h.dest === "image" && !xss(h));
  return {
    blockedHits: hitsBlocked.length,
    blockedScripts: Boolean(blocked?.scriptRan) || hitsBlocked.some(xss),
    imagesNonImageHits: hitsImages.filter((h) => h.dest !== "image").length,
    imagesImageHits: imageHits.length,
    imagesScripts: Boolean(images?.scriptRan) || hitsImages.some(xss),
    navigationsAllowed,
    opened,
    openedMailtoWithAttach: opened.some(
      (h) => /^mailto:/i.test(h) && /[?&]attach(?:ment)?=/i.test(h),
    ),
    linkWarningCount: blocked?.linkWarnings ?? 0,
    anchorsInFrame: blocked?.anchorsInFrame ?? 0,
    // The reader's own pipeline, whatever the case's mode: what the sanitizer left in the frame.
    forbiddenElementsInFrame: records.get(`${c.id}|blocked`)?.forbiddenElements ?? -1,
    imagesNonImagePaths: hitsImages
      .filter((h) => h.dest !== "image")
      .map((h) => h.path)
      .sort(),
    noticeShown: blocked?.noticeShown ?? false,
    attachmentStrip: blocked?.attachments ?? [],
    senderText: blocked?.senderText ?? "",
    canaryQuerySeen: hits.some((h) => h.id === c.id && h.path.includes("SECRET-MARKER")),
    opensWithinMs: (blocked?.openMs ?? 1e9) < 4000 && (images?.openMs ?? 0) < 4000,
    spyAgreesWithCanary: requestsInImages === hitsImages.length,
  };
}

// ---- run ----
const dir = mkdtempSync(join(tmpdir(), "matters-smoke-security-"));
const server = await startImapTestServer();
const failures: string[] = [];
let exitCode = 1;
try {
  const admin = await Admin.connect({
    host: server.host,
    port: server.port,
    user: server.user,
    pass: server.password,
  });
  for (const c of cases) await admin.append("INBOX", fixCase(c) as unknown as string, []);
  await admin.close();
  console.error(`server filled with ${cases.length} corpus messages; canary on ${ORIGIN}`);

  const { ELECTRON_RUN_AS_NODE: _drop, MATTERS_SEED: _seed, ...env } = process.env;
  const child = spawn(process.execPath, [join(root, "apps/desktop")], {
    env: {
      ...env,
      MATTERS_SMOKE: "1",
      MATTERS_SMOKE_MODE: "security",
      MATTERS_SMOKE_TIMEOUT_MS: String(APP_TIMEOUT_MS - 10_000),
      MATTERS_DB_PATH: join(dir, "matters.db"),
      MATTERS_USER_DATA: join(dir, "userData"),
      MATTERS_ALLOW_INSECURE_IMAP: "1",
      MATTERS_TEST_ACCOUNT: JSON.stringify({
        id: "acc-smoke",
        address: server.user,
        host: server.host,
        port: server.port,
        security: "none",
        username: server.user,
      }),
      MATTERS_TEST_PASSWORD: server.password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  let pending = "";
  const feed = (d: Buffer) => {
    const text = d.toString();
    log += text;
    pending += text;
    const parts = pending.split("\n");
    pending = parts.pop() ?? "";
    for (const part of parts) onLine(part);
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  const killer = setTimeout(() => child.kill("SIGKILL"), APP_TIMEOUT_MS);
  const exit = await new Promise<number | null>((r) => child.on("close", r));
  clearTimeout(killer);
  const line = log.split("\n").find((l) => l.startsWith(RESULT));
  if (process.env.SMOKE_SECURITY_LOG)
    (await import("node:fs")).writeFileSync(process.env.SMOKE_SECURITY_LOG, log);
  if (!line) failures.push(`no result from the app (exit ${exit})`);
  else {
    const result = JSON.parse(line.slice(RESULT.length)) as Record<string, unknown>;
    if (result.error) failures.push(`app: ${String(result.error)}`);
  }
  if (exit !== 0) failures.push(`exit code ${exit}`);
  if (ready < cases.length)
    failures.push(`the app synced ${ready} of ${cases.length} corpus messages`);

  // ---- instrumentation controls: if any fails, no refusal below means anything ----
  const control = byId.get("html-control-instrumentation");
  const controlOpened = events.some(
    (e) => e.kind === "open-external" && e.id === "html-control-instrumentation",
  );
  const controlImage = hits.filter(
    (h) => h.id === "html-control-instrumentation" && h.lane === "images" && h.dest === "image",
  ).length;
  const controlSpy = events.filter(
    (e) => e.kind === "request" && e.id === "html-control-instrumentation" && e.lane === "images",
  ).length;
  const mainFrameControl = events.some(
    (e) =>
      e.kind === "navigate" &&
      e.id === "control-main-frame-navigation" &&
      e.mainFrame &&
      e.prevented &&
      (e.url ?? "").includes("control.invalid"),
  );
  const refreshControl = events.some(
    (e) =>
      e.kind === "navigate" &&
      e.id === "control-parent-navigates-to-own-page" &&
      !e.mainFrame &&
      !e.prevented &&
      (e.url ?? "").endsWith("/mail-images.html"),
  );
  if (!control)
    failures.push("control: the case html-control-instrumentation is not in the corpus");
  if (!controlOpened)
    failures.push(
      "control: a plain link followed in the reader was not seen by the openExternal spy",
    );
  if (controlImage !== 1)
    failures.push(
      `control: the canary saw ${controlImage} image requests from the control message with images allowed, expected 1`,
    );
  if (controlSpy !== controlImage)
    failures.push(
      `control: the request spy in main saw ${controlSpy} requests where the canary saw ${controlImage}`,
    );
  if (!mainFrameControl)
    failures.push("control: the main-frame navigation spy did not see the page try to leave");
  if (!refreshControl)
    failures.push(
      "control: the page sending the frame to one of our own pages was not seen as an allowed navigation (the navigation wall tests could pass without testing anything)",
    );

  // ---- judge every check ----
  const summary = new TierSummary("browser");
  let judged = 0;
  for (const c of cases) {
    let measured: Record<string, unknown>;
    try {
      measured = measure(c);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    for (const check of c.tiers.browser?.checks ?? ([] as Check[])) {
      if (!(check.name in measured)) {
        failures.push(`${c.id}: no measurement for ${check.name}`);
        continue;
      }
      judged++;
      const verdict = judge(check, measured[check.name]);
      summary.record(c, check, verdict);
      if (verdict.status === "fail") {
        failures.push(`${c.id} [${c.sources.join("; ")}]: ${verdict.why}`);
        // CORPUS_REPORT=file: the measured value of every failing check, to record a gap (ADR 0047).
        if (process.env.CORPUS_REPORT) {
          const row = {
            tier: "browser",
            id: c.id,
            check: check.name,
            ideal: check.ideal,
            actual: measured[check.name],
          };
          appendFileSync(process.env.CORPUS_REPORT, `${JSON.stringify(row)}\n`);
        }
      }
    }
  }
  console.log(summary.print());
  // Console lines the window printed while the messages were open, grouped by their first words. Most
  // are the sanitizer's own parse reporting each inline style attribute against the page's policy
  // (about 22 000 for the 1.5 MB message alone): noise to look at, not a verdict.
  const kinds = new Map<string, number>();
  for (const e of errorsSeen) {
    const kind = e.replace(/^renderer (?:error|warning): /, "").slice(0, 60);
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
  }
  const top = JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5));
  console.log(
    `browser tier: ${judged} checks over ${cases.length} messages; canary saw ${hits.length} requests; console lines by kind: ${top}`,
  );
  console.log(JSON.stringify({ ok: failures.length === 0, failures }, null, 2));
  if (failures.length > 0)
    console.error(`--- tail of app output ---\n${log.split("\n").slice(-40).join("\n")}`);
  exitCode = failures.length === 0 ? 0 : 1;
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
} finally {
  server.stop();
  canary.close();
  rmSync(dir, { recursive: true, force: true });
}
process.exit(exitCode);
