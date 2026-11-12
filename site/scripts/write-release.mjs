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

// Every page of the list: a stable release may sit behind a hundred pre-releases. A repository
// with no release answers with an empty list. Any failure stops the run, 404 too: it means the
// repository was not reached, and "no download" must not be published in place of a download.
const releases = [];
for (let page = 1; ; page++) {
  const res = await fetch(
    `https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`,
    { headers },
  );
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
  const batch = await res.json();
  releases.push(...batch);
  if (batch.length < 100) break;
}

// The list is ordered by creation, and a draft may be published late: order by publication.
const published = releases
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
writeFileSync(new URL("../release.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(out);
