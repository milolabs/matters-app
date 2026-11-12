// Fills in what a release changes: the download link, the version line and the star count.
// release.json is written by scripts/write-release.mjs in the release workflow. Until there is
// a release, the page keeps the words it was served with.

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
      el.textContent = "Download for macOS";
    }
    for (const el of document.querySelectorAll("[data-version]")) {
      el.textContent = `${r.version} · ${day}`;
    }
    for (const el of document.querySelectorAll("[data-released]")) el.hidden = false;
    for (const el of document.querySelectorAll("[data-unreleased]")) el.hidden = true;
  }
} catch {
  // Offline or opened from a file: the served words stand.
}
