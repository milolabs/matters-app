import "./scriptStart.ts";
// Before any module reads a setting: the old keys move to their new names (ADR 0105).
import "./keyRename.ts";
import "./trace.ts";
import { createEffect, createRoot } from "solid-js";
import { render } from "solid-js/web";
import { createAccountsStore } from "./accounts.ts";
import { createAgentStore } from "./agent.ts";
import { App } from "./app.tsx";
import { releaseBoot } from "./bootScreen.ts";
import { createBackend, waitForPort } from "./client.ts";
import { createComposeStore } from "./compose.ts";
import { afterFrames, firstScreenReady } from "./firstScreen.ts";
import { createFoldersStore } from "./folders.ts";
import { migrateImageAddresses } from "./imagesMigration.ts";
import { createMovesStore } from "./moves.ts";
import { createOutboxStore } from "./outbox.ts";
import { preloadHeavyModules } from "./preload.ts";
import { createMailStore } from "./store.ts";
import { mark, traceRows } from "./trace.ts";
import { createViewsStore } from "./views.ts";
import "./styles.css";

const smokeMode = new URLSearchParams(location.search).get("smoke");
// The smoke checks are 25 KB nobody else needs: loaded in smoke runs only, and started now so
// that loading them is not part of what they time.
const smoke = smokeMode ? import("./smoke.ts") : null;

// Any CSP violation is a bug; smoke mode fails on them.
const cspViolations: string[] = [];
document.addEventListener("securitypolicyviolation", (e) =>
  cspViolations.push(
    `${e.violatedDirective} ${e.blockedURI} ${e.sample} ${(e.target as Element).outerHTML?.slice(0, 120)}`,
  ),
);

// The benchmark's forced slow start (dev builds only): the page never says it is ready.
const neverReady = new URLSearchParams(location.search).get("neverReady") === "1";

const port = await waitForPort();
mark("port-received");
traceRows();
const backend = createBackend(port);
const moves = createMovesStore(backend);
const folders = createFoldersStore(backend);
const store = createMailStore(backend, { moves, folders: folders.folders });
const accounts = createAccountsStore(backend);
const outbox = createOutboxStore(backend);
const compose = createComposeStore(backend, outbox);
const views = createViewsStore(backend, store);
const agent = createAgentStore(backend, { openDraft: (draftId) => compose.openDraft(draftId) });
// The old per-sender list becomes rules; it never holds up the window (ADR 0037).
void migrateImageAddresses(backend);
backend.onEvent((event) => {
  if (event.type === "changes") {
    void store.applyChanges(event);
    views.noteChanges();
  } else if (event.type === "viewsChanged") {
    // `Needs you` was added (ADR 0117, rule 2): the tabs read the list again.
    views.load().catch(() => {});
  } else if (event.type === "agentPromptProgress" && (event.finished || event.background)) {
    // Verdicts landed: the number of a view with a prompt may have moved (ADR 0117, rule 4).
    views.noteChanges();
  }
});
render(
  () => (
    <App
      store={store}
      accounts={accounts}
      backend={backend}
      outbox={outbox}
      moves={moves}
      folders={folders}
      compose={compose}
      views={views}
      agent={agent}
    />
  ),
  document.getElementById("root") as HTMLElement,
);
// Main shows the window when this is on its way to the screen (ADR 0070, rule 3).
createRoot((dispose) => {
  createEffect(() => {
    const ready = firstScreenReady({
      accountsLoaded: accounts.loaded(),
      listLoaded: store.loaded(),
      hasMessages: store.messages().length > 0,
      threadOpen: store.thread() !== null,
      aiOn: agent.enabled(),
      viewsLoaded: views.loaded(),
    });
    if (!ready) return;
    dispose();
    afterFrames(() => {
      mark("first-screen");
      // A loading screen that was seen leaves now, into a complete first screen (ADR 0103, rule 3).
      releaseBoot("first-screen");
      if (!neverReady) window.postMessage({ mattersFirstScreen: true }, "*");
    });
  });
});
// The agent's status is answered by the worker, which starts after the first screen; nothing that
// follows may wait for it (ADR 0012).
void agent
  .start()
  .catch(() => {})
  .finally(() => mark("agent-ready"));
await Promise.all([
  store.start(),
  accounts.refresh(),
  outbox.refresh(),
  folders.refresh(),
  views.load().catch(() => {}),
]);
mark("stores-ready");

preloadHeavyModules();
if (smokeMode === "1") {
  void smoke?.then((m) =>
    m.runSmoke(store, () => cspViolations, { compose, backend, agent, views }),
  );
}
if (smokeMode === "sync") {
  void smoke?.then((m) => m.runSyncSmoke(store, accounts, () => cspViolations));
}
if (smokeMode === "security") {
  void smoke?.then((m) => m.runSecuritySmoke(store, backend, () => cspViolations));
}
