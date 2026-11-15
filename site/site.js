// Fills in what a release changes: the download link, the version line and the star count.
// release.json is written by scripts/write-release.mjs in the site workflow. Until there is
// a release it says so. Without scripts the page keeps the words it was served with, which are
// true before and after a release.

// A Copy button beside a command. It is hidden in the page and shown here, so without scripts
// there is no button that does nothing.
for (const button of document.querySelectorAll("[data-copy]")) {
  if (!navigator.clipboard) continue;
  button.hidden = false;
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(button.dataset.copy);
      button.textContent = "Copied";
    } catch {
      // The browser said no: the command is selected instead, for ⌘C.
      const code = button.parentElement.querySelector("code");
      if (code) getSelection().selectAllChildren(code);
      button.textContent = "Press ⌘C";
    }
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  });
}

try {
  const res = await fetch("release.json", { cache: "no-cache" });
  const r = res.ok ? await res.json() : {};

  if (r.stars > 0) {
    for (const el of document.querySelectorAll("[data-stars]")) {
      el.textContent = `★ ${r.stars >= 1000 ? `${(r.stars / 1000).toFixed(1)}k` : r.stars}`;
      el.hidden = false;
    }
  }

  if (r.version && r.url) {
    const day = new Date(r.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
    // The installer is the way we offer first (ADR 0139): a button leads to the download page,
    // and only a link marked "file" goes to the disk image.
    for (const el of document.querySelectorAll('[data-download="file"]')) el.href = r.url;
    for (const el of document.querySelectorAll('[data-download]:not([data-download="file"])')) {
      el.textContent = r.stage
        ? `Get the ${r.stage} (Apple silicon)` // short enough for one line on a phone
        : "Get it for macOS (Apple silicon)";
    }
    for (const el of document.querySelectorAll("[data-version]")) {
      el.textContent = `${r.version} · ${day}`;
      // A pre-release (ADR 0129) says so, and sends the reader to what its notes ask of them.
      if (r.stage && r.notes) {
        const notes = document.createElement("a");
        notes.href = r.notes;
        notes.textContent = "Read the release notes before you open it.";
        el.append(` · ${r.stage}. `, notes);
      }
    }
    for (const el of document.querySelectorAll("[data-released]")) el.hidden = false;
    for (const el of document.querySelectorAll("[data-unreleased]")) el.hidden = true;
  } else if (res.ok) {
    const none = "No download yet. Today you build it from source.";
    for (const el of document.querySelectorAll("[data-version]")) el.textContent = none;
    for (const el of document.querySelectorAll("[data-release-title]")) {
      el.textContent = "No download yet.";
    }
    for (const el of document.querySelectorAll("[data-release-note]")) {
      el.textContent = "The first release is on its way. Today you build it from source.";
    }
  }
} catch {
  // Offline or opened from a file: the served words stand.
}
