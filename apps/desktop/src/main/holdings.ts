// What the desktop app keeps of its own, and the full list put together (ADR 0138, rule 2). The
// adapters declare theirs; this file names the folders and files main and the backend write, and
// what Chromium writes into the data folder. Its test runs a seeded build and fails on any entry
// of the data folder that no holding claims.
import { CLAUDE_CODE_HOLDINGS } from "@matters/adapter-claude-code/holdings";
import { CODEX_HOLDINGS } from "@matters/adapter-codex/holdings";
import { SECRETS_HOLDINGS } from "@matters/adapter-secrets/holdings";
import { SQLITE_FILE_HOLDINGS } from "@matters/adapter-sqlite/holdings";
import { type Holding, type HoldingGroup, holdingsOf } from "@matters/core";
import { RELEASE_STATE_FILE } from "./release.ts";

/** The erase order (ADR 0138, rule 3): in the data folder, gone last. */
export const ERASE_ORDER_FILE = "erase-order.json";
/** The identity move's marker and staged vault (ADR 0105). */
const IDENTITY_MARKER = "identity-migration.json";
const STAGED_VAULT = "credentials.unclosed.json";
/** The identity helper's scratch folders in the temp directory (identityHelper.ts). */
export const IDENTITY_TEMP_PREFIX = "matters-identity-";

const data = (
  id: string,
  group: HoldingGroup,
  step: Holding["step"],
  name: string,
  match: "exact" | "prefix" = "exact",
): Holding => ({ id, group, step, place: { kind: "data", name, match } });

/** Chromium's own storage: what the pages keep (settings in localStorage among it). */
const CHROMIUM_STORAGE = [
  "Local Storage",
  "Session Storage",
  "IndexedDB",
  "WebStorage",
  "SharedStorage",
  "Service Worker",
  "Preferences",
  "Local State",
];

/** Chromium's caches, locks and records of one session; nothing in them is the person's mail. */
const CHROMIUM_CACHES: readonly (readonly [string, "exact" | "prefix"])[] = [
  ["Cache", "exact"],
  ["Code Cache", "exact"],
  ["GPUCache", "exact"],
  ["GPUPersistentCache", "exact"],
  ["DawnGraphiteCache", "exact"],
  ["DawnWebGPUCache", "exact"],
  ["GraphiteDawnCache", "exact"],
  ["ShaderCache", "exact"],
  ["GrShaderCache", "exact"],
  ["Shared Dictionary", "exact"],
  ["blob_storage", "exact"],
  ["Cookies", "prefix"],
  ["DIPS", "prefix"],
  ["Trust Tokens", "prefix"],
  ["Network Persistent State", "exact"],
  ["TransportSecurity", "exact"],
  ["Extension State", "exact"],
  ["declarative_performance_observer.db", "prefix"],
  ["Dictionaries", "exact"],
  ["Crashpad", "exact"],
  ["Network", "exact"],
  ["Partitions", "exact"],
  ["Singleton", "prefix"],
  ["lockfile", "exact"],
  [".DS_Store", "exact"],
];

export const DESKTOP_HOLDINGS: readonly Holding[] = [
  // Saved passwords: the staged vault of the identity move, still under the old key.
  data("desktop.stagedVault", "signIns", "signIns", STAGED_VAULT),
  // Attachments and files (ADR 0041, 0043): kept copies, spools, downloaded copies, pastes.
  data("desktop.attachments", "files", "files", "attachments"),
  data("desktop.spool", "files", "files", "spool"),
  data("desktop.received", "files", "files", "received"),
  data("desktop.paste", "files", "files", "paste"),
  // Settings.
  data("desktop.appearance", "settings", "settings", "appearance.json"),
  data("desktop.themes", "settings", "settings", "themes"),
  data("desktop.window", "settings", "settings", "window.json"),
  // What the last look for a newer version found, and whether the look is on (ADR 0137).
  data("desktop.newerVersion", "settings", "settings", RELEASE_STATE_FILE),
  data("desktop.identityMarker", "settings", "settings", IDENTITY_MARKER),
  {
    id: "desktop.notificationsState",
    group: "settings",
    step: "settings",
    place: { kind: "besideDatabase", name: "notifications-state.json" },
  },
  // Chromium's storage goes with the caches (rule 3); what it holds is settings.
  ...CHROMIUM_STORAGE.map((name) =>
    data(`chromium.${name.replace(/\W/g, "")}`, "settings", "caches", name),
  ),
  ...CHROMIUM_CACHES.map(([name, match]) =>
    data(`chromium.${name.replace(/\W/g, "")}`, "caches", "caches", name, match),
  ),
  data("desktop.compileCache", "caches", "caches", "compile-cache"),
  {
    id: "desktop.identityTemp",
    group: "caches",
    step: "temp",
    place: { kind: "temp", prefix: IDENTITY_TEMP_PREFIX },
  },
  { id: "desktop.earlierFolder", group: "mail", step: "earlier", place: { kind: "earlierFolder" } },
  data("desktop.eraseOrder", "settings", "order", ERASE_ORDER_FILE),
];

/** Everything Matters keeps, from every adapter (ADR 0138, rule 2). Tables are in the database. */
export const ALL_HOLDINGS: readonly Holding[] = holdingsOf(
  SECRETS_HOLDINGS,
  SQLITE_FILE_HOLDINGS,
  CLAUDE_CODE_HOLDINGS,
  CODEX_HOLDINGS,
  DESKTOP_HOLDINGS,
);
