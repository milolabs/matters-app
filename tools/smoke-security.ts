// ADR 0047: the hostile-mail corpus in the real app. Starts the Docker IMAP test server, puts every
// browser-tier message of the corpus on it, starts the built app with a fresh database and lets it
// sync, open each message and follow its links, twice (images off, images allowed from the sender)
// and once more with the walls tested alone. A canary HTTP server on 127.0.0.1 counts every request
// that reaches it, and the app's main process reports every navigation, network request and link
// handed to the system (a dev-only spy, `MATTERS_SMOKE_MODE=security`). Each check of the manifest
// is then judged by the ratchet. A second, short start on the demo mailbox knows of a newer
// version and is never told to install it. Each message is also saved as a PDF through the reader's
// Save as PDF… (ADR 0144), with images off and with them allowed: making it may ask the network for
// nothing the reader did not, run nothing and go nowhere, and the PDF says what the screen said.
// Needs Docker and `electron-vite build` first; the root `smoke:security` script does both.
import { spawn } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractFileText } from "../packages/adapter-filetext/src/index.ts";
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
import { lanesOf, linkEvents } from "./smoke-security-lanes.ts";

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
/** What the canary answers for release.json: a newer version, with its downloads. */
const NEWER = "v0.1.0-alpha.5";
const NEWER_RELEASE = {
  repo: "milolabs/matters-app",
  version: NEWER,
  date: "2026-11-14T08:00:00Z",
  url: `https://github.com/milolabs/matters-app/releases/download/${NEWER}/Matters-arm64.dmg`,
  notes: `https://github.com/milolabs/matters-app/releases/tag/${NEWER}`,
  stage: "alpha",
  stars: 0,
};
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
  if (url.pathname === "/__release/release.json") {
    // The site's file, naming a version newer than any build that is not packaged (0.0.0).
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(NEWER_RELEASE));
  } else if (dest === "image" || /\.png$/.test(url.pathname)) {
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
  screenText?: string;
  printAnswer?: string;
  anchorsInFrame?: number;
  forbiddenElements?: number;
  linksFollowed?: number;
  linkWarnings?: number;
  error?: string;
}
interface MainEvent {
  readonly kind: "navigate" | "request" | "open-external" | "compose" | "print";
  readonly url?: string;
  readonly href?: string;
  readonly mainFrame?: boolean;
  readonly prevented?: boolean;
  readonly type?: string;
  /** A `compose` event: the new message a `mailto:` link opens (ADR 0143). */
  readonly to?: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject?: string;
  readonly body?: string;
  /** A `print` event (ADR 0144): how it ended, whether anything ran in the print view, the file. */
  readonly action?: string;
  readonly answer?: string;
  readonly scriptRan?: boolean;
  readonly path?: string;
  readonly id: string;
  readonly lane: string;
}
const records = new Map<string, PageRecord>(); // `${id}|${lane}`
const events: MainEvent[] = [];
/** The PDFs main wrote, copied the moment it said so: every case has the same subject. */
const pdfs = new Map<string, Buffer>(); // `${id}|${lane}`
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
    if (event.kind === "print" && event.path) {
      try {
        pdfs.set(`${event.id}|${event.lane}`, readFileSync(event.path));
      } catch {
        // Not there: the print checks below say so.
      }
    }
  } else if (/^renderer (?:error|warning):/.test(line)) errorsSeen.push(line.slice(0, 240));
}

// ---- measuring ----
const plain = (u: string) =>
  u.replace(new RegExp(`https?://${ORIGIN.replace(".", "\\.")}/__c/[^/]+`, "g"), "CANARY");
const OWN_PAGE =
  /\/out\/renderer\/(?:index|mail|mail-images|preview|print|settings)\.html(?:[?#]|$)|^about:/;

/** The text of each case's PDF made with images off, as one line. */
const printedTexts = new Map<string, string>();

function measure(c: CorpusCase): Record<string, unknown> {
  const mode = c.tiers.browser?.mode ?? "pipeline";
  const lanes = lanesOf(mode);
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
  // In the case's own blocked lane: a case put past the pipeline reports in a lane of its own.
  const links = linkEvents(mainEvents, lanes);
  const opened = links.opened.map((e) => plain(e.href ?? ""));
  // A `mailto:` link opens a new message in the app (ADR 0143): what each draft would hold.
  const composed = links.composed;
  const DRAFT_KEYS = new Set([
    "kind",
    "source",
    "to",
    "cc",
    "bcc",
    "subject",
    "body",
    "id",
    "lane",
  ]);
  const addresses = (e: MainEvent) => [...(e.to ?? []), ...(e.cc ?? []), ...(e.bcc ?? [])];
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
    composedFromLinks: composed.length,
    composedWithAttach: composed.some(
      (e) =>
        Object.keys(e).some((k) => !DRAFT_KEYS.has(k)) || /\/etc\/|file:/i.test(JSON.stringify(e)),
    ),
    composedWithInjectedHeader: composed.some(
      (e) => /[\r\n]/.test(e.subject ?? "") || addresses(e).some((a) => /[\s:]/.test(a)),
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
    screenText: records.get(`${c.id}|blocked`)?.screenText ?? "",
    printedText: printedTexts.get(c.id) ?? "",
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

  // ADR 0137, rule 15: the check for a newer version is pointed at the canary and turned off, as a
  // person turns it off. With the check off, and in a build that is not packaged, nothing may ask
  // the canary for it, and nothing may leave for the site.
  mkdirSync(join(dir, "userData"), { recursive: true });
  writeFileSync(join(dir, "userData", "newer-version.json"), JSON.stringify({ enabled: false }));
  // ADR 0140, rule 7: installing is pointed at the canary too, with a stand-in folder of apps.
  // Nobody presses Install in this run, so no download may leave, for the canary or for GitHub.
  mkdirSync(join(dir, "apps", "Matters.app"), { recursive: true });
  // ADR 0141, rule 9: the runtime on the person's own API key is pointed at the canary too, and a
  // made-up key sits in the environment. No key is saved and AI is off, so nothing may leave for
  // the provider, the canary or the real host: the environment is never read.
  const { ELECTRON_RUN_AS_NODE: _drop, MATTERS_SEED: _seed, ...env } = process.env;
  const pdfDir = join(dir, "pdf");
  mkdirSync(pdfDir, { recursive: true });
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
      MATTERS_TEST_RELEASE_URL: `http://${ORIGIN}/__release/release.json`,
      MATTERS_TEST_INSTALL_URL: `http://${ORIGIN}/__install/`,
      MATTERS_TEST_INSTALL_DIR: join(dir, "apps"),
      MATTERS_TEST_ANTHROPIC_BASE: `http://${ORIGIN}`,
      ANTHROPIC_API_KEY: "sk-ant-smoke-0000000000000000000000000000-made-up",
      // ADR 0144: Save as PDF… writes here without the dialog.
      MATTERS_TEST_SAVE_DIR: pdfDir,
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

  // ---- the check for a newer version, turned off (ADR 0137, rules 5, 6 and 15) ----
  const releaseHits = hits.filter((h) => h.path.startsWith("/__release")).length;
  const releaseRequests = events.filter(
    (e) =>
      e.kind === "request" &&
      (/^https?:\/\/(?:[^/]*\.)?getmatters\.app(?:[:/]|$)/i.test(e.url ?? "") ||
        (e.url ?? "").includes("/__release")),
  );
  if (releaseHits > 0)
    failures.push(
      `newer version: the check was off, yet the canary was asked ${releaseHits} times`,
    );
  if (releaseRequests.length > 0)
    failures.push(
      `newer version: the check was off, yet main saw requests for it: ${releaseRequests
        .map((e) => e.url)
        .join(", ")}`,
    );

  // ---- installing a newer version, never pressed (ADR 0140, rules 1 and 7) ----
  const installHits = hits.filter((h) => h.path.startsWith("/__install")).length;
  const installRequests = events.filter(
    (e) =>
      e.kind === "request" &&
      (/^https?:\/\/github\.com\/milolabs\/matters-app\/releases\/download\//i.test(e.url ?? "") ||
        /^https?:\/\/release-assets\.githubusercontent\.com(?:[:/]|$)/i.test(e.url ?? "") ||
        (e.url ?? "").includes("/__install")),
  );
  if (installHits > 0)
    failures.push(`install: nobody pressed Install, yet the canary was asked ${installHits} times`);
  if (installRequests.length > 0)
    failures.push(
      `install: nobody pressed Install, yet main saw downloads: ${installRequests
        .map((e) => e.url)
        .join(", ")}`,
    );

  // ---- the agent on the person's own API key, with no key saved (ADR 0141, rule 9) ----
  const keyHits = hits.filter((h) => h.id === "?" && h.path.startsWith("/v1/")).length;
  const keyRequests = events.filter(
    (e) =>
      e.kind === "request" &&
      /^https?:\/\/(?:[^/]*\.)?(?:anthropic\.com|openai\.com)(?:[:/]|$)/i.test(e.url ?? ""),
  );
  if (keyHits > 0)
    failures.push(`api key: no key was saved, yet the canary was asked ${keyHits} times`);
  if (keyRequests.length > 0)
    failures.push(
      `api key: no key was saved, yet main saw requests for a provider: ${keyRequests
        .map((e) => e.url)
        .join(", ")}`,
    );

  // ---- a newer version known, Install never pressed (ADR 0140, rules 1 and 7) ----
  // The run above has the check off, so no newer version is known there: it cannot tell "not
  // pressed" from "nothing to install". This start has the check on (no state file yet), the
  // canary's release.json names a newer version, and the demo mailbox, so no corpus. It is stopped
  // once the check was answered and a while has passed; the check must have run, and kept the
  // newer version, for "nothing left" to mean anything.
  const newerDir = join(dir, "newer");
  mkdirSync(join(newerDir, "userData"), { recursive: true });
  mkdirSync(join(newerDir, "apps", "Matters.app"), { recursive: true });
  marker = { id: "newer-known", lane: "newer-known" };
  currentLane = "newer-known";
  const releaseAsked = () =>
    hits.filter((h) => h.lane === "newer-known" && h.path.startsWith("/__release")).length;
  const second = spawn(process.execPath, [join(root, "apps/desktop")], {
    env: {
      ...env,
      MATTERS_SMOKE: "1",
      MATTERS_SMOKE_MODE: "security",
      MATTERS_SMOKE_TIMEOUT_MS: "120000",
      MATTERS_SEED: "1",
      MATTERS_DB_PATH: join(newerDir, "matters.db"),
      MATTERS_USER_DATA: join(newerDir, "userData"),
      MATTERS_TEST_RELEASE_URL: `http://${ORIGIN}/__release/release.json`,
      MATTERS_TEST_INSTALL_URL: `http://${ORIGIN}/__install/`,
      MATTERS_TEST_INSTALL_DIR: join(newerDir, "apps"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let secondLog = "";
  let secondPending = "";
  const secondFeed = (d: Buffer) => {
    const text = d.toString();
    secondLog += text;
    secondPending += text;
    const parts = secondPending.split("\n");
    secondPending = parts.pop() ?? "";
    // Only main's events: the page's corpus signals belong to the run above.
    for (const part of parts) if (part.startsWith(EVENT)) onLine(part);
  };
  second.stdout.on("data", secondFeed);
  second.stderr.on("data", secondFeed);
  const secondClosed = new Promise<number | null>((r) => second.on("close", r));
  const askedBy = Date.now() + 90_000;
  while (releaseAsked() === 0 && second.exitCode === null && Date.now() < askedBy)
    await new Promise((r) => setTimeout(r, 250));
  // Long enough for an install that started by itself to have asked for its first file.
  if (releaseAsked() > 0) await new Promise((r) => setTimeout(r, 5_000));
  second.kill("SIGTERM");
  const secondKiller = setTimeout(() => second.kill("SIGKILL"), 15_000);
  await secondClosed;
  clearTimeout(secondKiller);
  let keptVersion: unknown = null;
  try {
    const kept = JSON.parse(
      readFileSync(join(newerDir, "userData", "newer-version.json"), "utf8"),
    ) as { answer?: { version?: unknown } | null };
    keptVersion = kept.answer?.version ?? null;
  } catch {
    // Not written: the check did not keep an answer.
  }
  const newerEvents = events.filter((e) => e.lane === "newer-known" && e.kind === "request");
  // Controls: the canary was asked, main's spy saw it, and what came back was kept.
  if (releaseAsked() === 0)
    failures.push(
      `newer known: control: the check was on, yet the canary was never asked for release.json (exit ${second.exitCode})\n${secondLog.split("\n").slice(-20).join("\n")}`,
    );
  if (!newerEvents.some((e) => (e.url ?? "").includes("/__release/release.json")))
    failures.push("newer known: control: main's spy did not see the request for release.json");
  if (keptVersion !== NEWER.replace(/^v/, ""))
    failures.push(`newer known: control: the newer version was not kept (${String(keptVersion)})`);
  const newerInstallHits = hits.filter(
    (h) => h.lane === "newer-known" && h.path.startsWith("/__install"),
  );
  const newerInstallRequests = newerEvents.filter(
    (e) =>
      /^https?:\/\/github\.com\/milolabs\/matters-app\/releases\/download\//i.test(e.url ?? "") ||
      /^https?:\/\/release-assets\.githubusercontent\.com(?:[:/]|$)/i.test(e.url ?? "") ||
      (e.url ?? "").includes("/__install"),
  );
  if (newerInstallHits.length > 0)
    failures.push(
      `newer known: nobody pressed Install, yet the canary was asked for ${newerInstallHits
        .map((h) => h.path)
        .join(", ")}`,
    );
  if (newerInstallRequests.length > 0)
    failures.push(
      `newer known: nobody pressed Install, yet main saw downloads: ${newerInstallRequests
        .map((e) => e.url)
        .join(", ")}`,
    );
  if (readdirSync(join(newerDir, "apps")).join(",") !== "Matters.app")
    failures.push("newer known: the stand-in folder of apps changed");

  // ---- Save as PDF… (ADR 0144, rule 3) ----
  // Making the PDF may ask the canary for nothing the reader did not ask for in the same state
  // (images off, then allowed), may run nothing and may go nowhere. Every message must give a PDF,
  // or none of that means anything.
  const pathsIn = (id: string, lane: string, image?: boolean) =>
    new Set(
      hits
        .filter((h) => h.id === id && h.lane === lane)
        .filter((h) => image === undefined || (h.dest === "image") === image)
        .map((h) => h.path),
    );
  let printed = 0;
  let printHits = 0;
  for (const c of cases) {
    const lanes: [string, string][] = [["print-blocked", "blocked"]];
    if (records.has(`${c.id}|print-images`)) lanes.push(["print-images", "images"]);
    for (const [lane, readerLane] of lanes) {
      const record = records.get(`${c.id}|${lane}`);
      const event = events.find((e) => e.kind === "print" && e.id === c.id && e.lane === lane);
      if (!record || record.error || record.printAnswer !== "done" || event?.answer !== "done") {
        failures.push(
          `print: ${c.id} (${lane}): no PDF was made (${record?.error ?? record?.printAnswer ?? "no record"}; main: ${event?.answer ?? "nothing"})`,
        );
        continue;
      }
      printed++;
      if (event.scriptRan || record.scriptRan)
        failures.push(`print: ${c.id} (${lane}): something in the message ran in the print view`);
      const mine = hits.filter((h) => h.id === c.id && h.lane === lane);
      printHits += mine.length;
      if (mine.some((h) => h.path.startsWith("/xss")))
        failures.push(`print: ${c.id} (${lane}): a script's request reached the canary`);
      // Images only where the reader loaded them; anything else only where the reader asked too.
      const allowedImages = pathsIn(c.id, readerLane, true);
      const allowedOther = pathsIn(c.id, readerLane, false);
      const extra = mine.filter((h) =>
        h.dest === "image" ? !allowedImages.has(h.path) : !allowedOther.has(h.path),
      );
      if (extra.length > 0)
        failures.push(
          `print: ${c.id} (${lane}): the canary saw requests the reader did not make: ${extra
            .map((h) => `${h.dest} ${h.path}`)
            .join(", ")}`,
        );
      const went = events.filter(
        (e) =>
          e.id === c.id &&
          e.lane === lane &&
          e.kind === "navigate" &&
          !e.prevented &&
          !OWN_PAGE.test(e.url ?? ""),
      );
      if (went.length > 0)
        failures.push(
          `print: ${c.id} (${lane}): navigations were allowed: ${went.map((e) => plain(e.url ?? "")).join(", ")}`,
        );
      if (lane === "print-blocked") {
        const bytes = pdfs.get(`${c.id}|${lane}`);
        if (bytes?.subarray(0, 5).toString("latin1") !== "%PDF-") {
          failures.push(`print: ${c.id}: the file main wrote is not a PDF`);
          continue;
        }
        const file = join(pdfDir, `${c.id}.pdf`);
        writeFileSync(file, bytes as Buffer);
        const text = await extractFileText(file, "pdf");
        printedTexts.set(c.id, text.text.replace(/\s+/g, " "));
      }
    }
  }
  // Control: the request spy in main sees the print view's requests too (they share a session).
  const printLanes = new Set(["print-blocked", "print-images"]);
  const printSpy = events.filter((e) => e.kind === "request" && printLanes.has(e.lane)).length;
  const printCanary = hits.filter((h) => printLanes.has(h.lane)).length;
  if (printSpy !== printCanary)
    failures.push(
      `print: control: main's request spy saw ${printSpy} requests while printing where the canary saw ${printCanary}`,
    );
  if (!printedTexts.get("html-control-instrumentation"))
    failures.push("print: control: the control message's PDF has no text that could be read");
  console.log(
    `print: ${printed} PDFs made; the canary saw ${printHits} requests while they were made (${printCanary} in the print lanes, ${printSpy} seen by main)`,
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
