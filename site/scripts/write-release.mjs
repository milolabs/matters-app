// Writes site/release.json for the download button and the star count: the newest published stable
// release, or, while there is none, the newest published pre-release (ADR 0129). Drafts never
// count. A pre-release carries its stage ("alpha", "beta") so the page can say what the download is.
// Run in the site workflow: GITHUB_REPOSITORY=owner/name GITHUB_TOKEN=… node site/scripts/write-release.mjs
import { writeFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("GITHUB_REPOSITORY is not set");

const headers = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const out = {
  repo,
  version: null,
  date: null,
  url: null,
  notes: null,
  stage: null,
  stars: null,
};

const about = await fetch(`https://api.github.com/repos/${repo}`, { headers });
if (about.ok) out.stars = (await about.json()).stargazers_count;

// The list is ordered by creation, and a draft may be published late: order by publication.
const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, { headers });
if (res.ok) {
  const published = (await res.json())
    .filter((r) => !r.draft && r.published_at && r.assets.some((a) => a.name.endsWith(".dmg")))
    .sort((a, b) => b.published_at.localeCompare(a.published_at));
  // A stable release wins over any pre-release, also a newer one.
  const newest = published.find((r) => !r.prerelease) ?? published[0];
  if (newest) {
    out.version = newest.tag_name;
    out.date = newest.published_at;
    out.url = newest.assets.find((a) => a.name.endsWith(".dmg")).browser_download_url;
    out.notes = newest.html_url;
    // v0.1.0-alpha.1 → "alpha". A pre-release with a tag that names no stage is a "pre-release".
    if (newest.prerelease) {
      out.stage = /-([a-z]+)/i.exec(newest.tag_name)?.[1].toLowerCase() ?? "pre-release";
    }
  }
} else if (res.status !== 404) {
  throw new Error(`GitHub answered ${res.status}`);
}
writeFileSync(new URL("../release.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(out);
