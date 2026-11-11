import { type AccountColor, isAccountColor, normalizeAccountColor } from "./accountMarks.ts";

const KEY = "matters.accountColors";

/** The colour each account was given or chose. A preference of this computer only. */
export function readAccountColors(): Record<string, AccountColor> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return {};
    const colors: Record<string, AccountColor> = {};
    for (const [id, value] of Object.entries(stored)) {
      if (isAccountColor(value)) colors[id] = normalizeAccountColor(value);
    }
    return colors;
  } catch {
    return {};
  }
}

export function writeAccountColors(colors: Readonly<Record<string, AccountColor>>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(colors));
  } catch {
    // Storage absent or refused: the colours last as long as this window is open.
  }
}

/** Another window of the app changed the colours: localStorage tells every other one. */
export function watchAccountColors(onChange: () => void): void {
  if (typeof window === "undefined") return;
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) onChange();
  });
}
