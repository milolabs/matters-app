// Fills in what a release changes: the download link, the version line and the star count.
// release.json is written by scripts/write-release.mjs in the release workflow. Until there is
// a release it says so. Without scripts the page keeps the words it was served with, which are
// true before and after a release.

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
    for (const el of document.querySelectorAll("[data-download]")) {
      el.href = r.url;
      el.textContent = "Download for macOS (Apple silicon)";
    }
    for (const el of document.querySelectorAll("[data-version]")) {
      el.textContent = `${r.version} · ${day}`;
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
