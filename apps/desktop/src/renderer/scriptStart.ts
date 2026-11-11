// The first module of the page to run: it tells main, through the preload, that the page's script has
// started, so that main does not show the loading screen over a page that is about to finish
// (ADR 0103, rule 2). No data, just the fact.
window.postMessage({ mattersScriptStart: true }, "*");
