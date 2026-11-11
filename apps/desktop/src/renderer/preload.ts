// Loads, once the list is on screen, the modules the first reply or the first HTML message needs
// (ADR 0046, rule 3): the editor with CodeMirror, and the mail sanitizer with DOMPurify. They are
// not part of the first script, so they cost nothing before the rows; this makes the first use as
// fast as every later one. A failed import is only a missed head start: the real use retries it.
export function preloadHeavyModules(): void {
  const load = () => {
    void import("./composer.tsx").catch(() => {});
    void import("./replyEditor.tsx").catch(() => {});
    void import("./mailHtml.ts").catch(() => {});
  };
  // Two frames first, so the rows that were just rendered are drawn before this competes with them.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if ("requestIdleCallback" in window) window.requestIdleCallback(load, { timeout: 1000 });
      else setTimeout(load, 50);
    }),
  );
}
