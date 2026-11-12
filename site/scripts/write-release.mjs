// Writes site/release.json from the latest GitHub release, for the download button and the star count.
// Run in the release workflow: GITHUB_REPOSITORY=owner/name GITHUB_TOKEN=… node site/scripts/write-release.mjs
import { writeFileSync } from "node:fs";

const repo = process.env.GITHUB_REPOSITORY;
if (!repo) throw new Error("GITHUB_REPOSITORY is not set");

const headers = { accept: "application/vnd.github+json" };
if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers });
const out = { repo, version: null, date: null, url: null, stars: null };

const about = await fetch(`https://api.github.com/repos/${repo}`, { headers });
if (about.ok) out.stars = (await about.json()).stargazers_count;

if (res.ok) {
  const latest = await res.json();
  const file = latest.assets.find((a) => a.name.endsWith(".dmg"));
  if (file) {
    out.version = latest.tag_name;
    out.date = latest.published_at;
    out.url = file.browser_download_url;
  }
} else if (res.status !== 404) {
  throw new Error(`GitHub answered ${res.status}`);
}
writeFileSync(new URL("../release.json", import.meta.url), `${JSON.stringify(out, null, 2)}\n`);
console.log(out);
