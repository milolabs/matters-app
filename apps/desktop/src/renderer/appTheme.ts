import { createSignal } from "solid-js";

const query =
  typeof window === "undefined" ? null : window.matchMedia("(prefers-color-scheme: dark)");
const [dark, setDark] = createSignal(query?.matches ?? false);
query?.addEventListener("change", (e) => setDark(e.matches));

/** The app is in its dark theme: it follows the system, as `styles.css` does. */
export const appDark = dark;
