// Forwards the backend MessagePort from main to the page and exposes nothing else.
import { ipcRenderer, webUtils } from "electron";
import { readBootReport } from "../backend/bootStage.ts";
import { createFileBridge } from "./fileBridge.ts";
import { createNoticeBridge } from "./noticeBridge.ts";
import { createReceivedBridge } from "./receivedBridge.ts";
import { createStorageBridge } from "./storageBridge.ts";

ipcRenderer.on("matters:port", (event) => {
  // Same-window postMessage crosses the context-isolation boundary and transfers the ports.
  window.postMessage("matters:port", "*", [...event.ports]);
});

// The loading screen (ADR 0103, rule 1). The preload runs before any script of the page, so it puts
// the backend's stage on the page itself and no page script has to run for the words to change.
// Two integers and a stage name; boot.css does the rest.
ipcRenderer.on("matters:boot", (_event, data: unknown) => applyBoot(data));
ipcRenderer.send("matters:boot-hello");

function applyBoot(data: unknown): void {
  const report = readBootReport(data);
  const root = document.documentElement;
  if (!report || !root) {
    // Nothing parsed yet: the next state change of the document has the element.
    if (report)
      document.addEventListener("readystatechange", () => applyBoot(data), { once: true });
    return;
  }
  root.dataset.bootStage = report.stage;
  if (report.total > 0) {
    root.dataset.bootCounted = "";
    root.style.setProperty("--boot-step", String(report.step));
    root.style.setProperty("--boot-total", String(report.total));
  } else {
    delete root.dataset.bootCounted;
  }
  // When the window appeared with the loading screen, on the page's clock: the mark's motion starts
  // then, and the page keeps the screen up for a moment before it leaves (bootScreen.ts).
  const shown = (data as { shown?: unknown }).shown === true;
  if (shown && root.dataset.bootShown === undefined) {
    root.dataset.bootShown = String(Math.round(performance.now()));
  }
}

// A banner was clicked (ADR 0071): main asks the page to open that message.
ipcRenderer.on("matters:open-mail", (_event, mail: unknown) => {
  const m = (mail ?? {}) as { key?: unknown; threadId?: unknown };
  if (typeof m.key !== "number" || typeof m.threadId !== "string") return;
  window.postMessage({ mattersOpenMail: { key: m.key, threadId: m.threadId } }, "*");
});

// A link the reader clicked in a message; main decides whether it may leave the app.
// A request for the settings window; main opens it, or brings it forward.
window.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (event.source !== window || typeof data !== "object" || data === null) return;
  if ("mattersOpenLink" in data) ipcRenderer.send("matters:open-link", data.mattersOpenLink);
  if ("mattersOpenSettings" in data) ipcRenderer.send("matters:open-settings");
  if ("mattersFirstScreen" in data) ipcRenderer.send("matters:first-screen");
  if ("mattersScriptStart" in data) ipcRenderer.send("matters:script-start");
});

// Files for a draft (ADR 0041, rule 3). The preload is the only place that reads a dropped file's
// path, and only from a trusted drop; it hands the paths to main and passes on grants. It exposes
// nothing to the page: there is no function here that takes a path.
const files = createFileBridge(
  {
    getPath: (file) => webUtils.getPathForFile(file),
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    post: (message) => window.postMessage(message, "*"),
  },
  window,
);
window.addEventListener("drop", (event) => files.drop(event), true);
window.addEventListener("message", (event) => files.message(event));

// Received files (ADR 0043): the page asks to open, preview or save one by message key and part id.
const received = createReceivedBridge(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    post: (message) => window.postMessage(message, "*"),
  },
  window,
);
window.addEventListener("message", (event) => received.message(event));

// Settings › Storage (ADR 0089): sizes and memory from main; main answers only that window.
const storage = createStorageBridge(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    post: (message) => window.postMessage(message, "*"),
  },
  window,
);
window.addEventListener("message", (event) => storage.message(event));

// Settings › Notifications (ADR 0108): how the app runs, and System Settings opened by main.
const noticeSystem = createNoticeBridge(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    post: (message) => window.postMessage(message, "*"),
  },
  window,
);
window.addEventListener("message", (event) => noticeSystem.message(event));

// Smoke mode only: let the page hand its timings to main.
if (process.argv.includes("--matters-smoke")) {
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (
      event.source === window &&
      typeof data === "object" &&
      data !== null &&
      "mattersSmoke" in data
    ) {
      ipcRenderer.send("matters:smoke", data.mattersSmoke);
    }
    if (
      event.source === window &&
      typeof data === "object" &&
      data !== null &&
      "mattersSmokeSignal" in data
    ) {
      ipcRenderer.send("matters:smoke-signal", data.mattersSmokeSignal);
    }
  });
}

// Launch trace (dev builds, tools/bench-launch.ts): the page hands its phase marks to main, which
// writes them next to the other processes'. Main adds the flag only when the benchmark asked.
if (process.argv.includes("--matters-trace")) {
  window.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (
      event.source === window &&
      typeof data === "object" &&
      data !== null &&
      "mattersTrace" in data
    ) {
      ipcRenderer.send("matters:trace", data.mattersTrace);
    }
  });
}
