// First: the settings it reads move to their new keys before anything looks (ADR 0105).
import "./keyRename.ts";
import { render } from "solid-js/web";
import { createAccountsStore } from "./accounts.ts";
import { createBackend, waitForPort } from "./client.ts";
import { Settings } from "./settings.tsx";
import "./styles.css";

// The settings window has its own port to the backend and loads only what it shows (ADR 0036).
const backend = createBackend(await waitForPort());
const accounts = createAccountsStore(backend);
render(
  () => <Settings backend={backend} accounts={accounts} />,
  document.getElementById("root") as HTMLElement,
);
await accounts.refresh();
