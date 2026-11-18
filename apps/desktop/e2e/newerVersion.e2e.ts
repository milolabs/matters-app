// A newer version (ADR 0137, rule 15): a stand-in for the site's release.json on this machine, the
// dot on the gear, About taking it away, and the lines of Settings › About. On the demo mailbox, so
// no server and no Docker. A build that is not packaged asks only when a test points it at a
// stand-in (`MATTERS_TEST_RELEASE_URL`); without one it never asks, and says so.
//
// Installing it (ADR 0140, rule 7): with a stand-in for the release downloads
// (`MATTERS_TEST_INSTALL_URL`) and a stand-in folder with a stand-in Matters.app
// (`MATTERS_TEST_INSTALL_DIR`), nothing is downloaded before the press, a wrong checksum stops it
// with nothing installed, and Cancel stops a download. The real install (a disk image, the swap,
// the restart) is not run here: it would replace a real app.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, type Running, test } from "./fixtures.ts";

interface Asked {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

/** The stand-in: answers with `answer`, honours If-None-Match, and keeps every request it got. */
async function standIn() {
  const asked: Asked[] = [];
  let answer: { status: number; body: string; etag: string } = { status: 200, body: "", etag: "" };
  /** The release downloads: a file's body by name, or "slow" for an image that never ends. */
  const files = new Map<string, string>();
  const server: Server = createServer((req, res) => {
    asked.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if (req.url?.startsWith("/download/")) {
      const body = files.get(req.url.split("/").at(-1) ?? "");
      if (body === undefined) {
        res.writeHead(404).end();
      } else if (body === "slow") {
        res.writeHead(200, { "content-length": String(100_000_000) });
        const tick = setInterval(() => res.write(Buffer.alloc(64 * 1024)), 100);
        res.on("close", () => clearInterval(tick));
      } else {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(body)) }).end(body);
      }
      return;
    }
    if (answer.status !== 200) {
      res.writeHead(answer.status).end();
      return;
    }
    if (req.headers["if-none-match"] === answer.etag) {
      res.writeHead(304, { etag: answer.etag }).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/json", etag: answer.etag }).end(answer.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/release.json`,
    downloads: `http://127.0.0.1:${port}/download/`,
    files,
    asked,
    serve(version: string | null, etag: string, status = 200) {
      answer = {
        status,
        etag,
        body: JSON.stringify({
          repo: "milolabs/matters-app",
          version,
          date: PUBLISHED,
          url: `https://github.com/milolabs/matters-app/releases/download/${version}/Matters-arm64.dmg`,
          notes: `https://github.com/milolabs/matters-app/releases/tag/${version}`,
          stage: "alpha",
          stars: 0,
        }),
      };
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        // A download that was cancelled may leave its connection open.
        server.closeAllConnections();
      }),
  };
}

/** When the stand-in's release was published. */
const PUBLISHED = "2026-11-14T08:00:00Z";

/**
 * The day as About writes it: in this machine's time zone, with the year when it is not this
 * one. Worked out here, so the test holds in any zone and in any year.
 */
function publishedDay(instant: string): string {
  const d = new Date(instant);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    ...(thisYear ? {} : { year: "numeric" }),
  }).format(d);
}

const demo = (env: Record<string, string> = {}) => ({ env: { MATTERS_SEED: "1", ...env } });

async function openSettingsFrom(running: Running, gear: string | RegExp): Promise<Page> {
  const [settings] = await Promise.all([
    running.app.waitForEvent("window"),
    running.window.getByRole("button", { name: gear }).click(),
  ]);
  return settings;
}

/** About's line about the version; the row about the default mail app has a line of its own. */
const versionLine = (about: Locator) =>
  about.locator('[role="status"]:not([data-default-mail] [role="status"])');

test("a newer version puts a dot on the gear, and About takes it away", async ({ start }) => {
  const site = await standIn();
  try {
    site.serve("v0.1.0-alpha.5", '"one"');
    const running = await start(demo({ MATTERS_TEST_RELEASE_URL: site.url }));
    const { window } = running;
    await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();

    // The start's check, after the mail is on screen: one GET that says nothing about the person.
    const gearName = "Settings · Matters 0.1.0-alpha.5 is out";
    const gear = window.getByRole("button", { name: gearName, exact: true });
    await expect(gear).toBeVisible();
    await expect(gear).toHaveAttribute("title", gearName);
    await expect(window.locator("[data-newer-dot]")).toHaveCount(1);
    await window.screenshot({ path: test.info().outputPath("gear-dot.png") });
    expect(site.asked).toHaveLength(1);
    const first = site.asked[0] as Asked;
    expect(first.method).toBe("GET");
    expect(first.url).toBe("/release.json");
    expect(first.headers["user-agent"]).toBe("Matters");
    expect(first.headers.cookie).toBeUndefined();
    expect(first.headers.authorization).toBeUndefined();
    expect(first.headers["if-none-match"]).toBeUndefined();
    expect(first.headers.referer).toBeUndefined();

    // The menu says it too (macOS has the app menu).
    if (process.platform === "darwin") {
      const label = await running.app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.items[0]?.submenu?.items[1]?.label,
      );
      expect(label).toBe("New Version: 0.1.0-alpha.5…");
    }

    // With the dot the gear opens About, and showing it takes both dots away, in every window.
    const settings = await openSettingsFrom(running, gearName);
    const about = settings.getByRole("region", { name: "About" });
    await expect(about.getByRole("heading", { name: "About" })).toBeVisible();
    await expect(about.getByText("Version 0.0.0", { exact: true })).toBeVisible();
    await expect(versionLine(about)).toHaveText(
      `0.1.0-alpha.5 is out. Published on ${publishedDay(PUBLISHED)}.`,
    );
    await expect(about.getByRole("button", { name: "Release notes" })).toBeVisible();
    await expect(about.getByRole("button", { name: "Download" })).toBeVisible();
    // A build that is not packaged installs nothing, and says why in one phrase (ADR 0140, rule 2).
    await expect(
      about.getByText(
        "Matters cannot install it here: this build was not made by the release workflow. The download opens in your browser.",
      ),
    ).toBeVisible();
    await expect(about.getByRole("button", { name: "Install and Restart" })).toHaveCount(0);
    await expect(about.getByLabel("Check for a newer version")).toBeChecked();
    await expect(about.getByText(/^Checked today at \d\d:\d\d\.$/)).toBeVisible();
    await settings.screenshot({ path: test.info().outputPath("about-newer.png") });
    await expect(window.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(window.locator("[data-newer-dot]")).toHaveCount(0);
    await expect(settings.locator("[data-newer-dot]")).toHaveCount(0);
    // About keeps saying what is out for as long as it is true.
    await expect(versionLine(about)).toHaveText(/0\.1\.0-alpha\.5 is out\./);

    // Check now sends the ETag it knows; nothing new comes back, nothing changes.
    await about.getByRole("button", { name: "Check now" }).click();
    await expect.poll(() => site.asked.length).toBe(2);
    expect(site.asked[1]?.headers["if-none-match"]).toBe('"one"');
    await expect(versionLine(about)).toHaveText(/0\.1\.0-alpha\.5 is out\./);

    // The newest: the site now offers the version that runs.
    site.serve("v0.0.0", '"two"');
    await about.getByRole("button", { name: "Check now" }).click();
    await expect(versionLine(about)).toHaveText("This is the newest version.");

    // A failed check is said in Settings only, with when it last worked.
    site.serve("v0.0.0", '"three"', 500);
    await about.getByRole("button", { name: "Check now" }).click();
    await expect(versionLine(about)).toHaveText(
      "Could not check: getmatters.app answered with an error.",
    );
    await expect(
      about.getByText(
        /^Last checked today at \d\d:\d\d\. Matters tries again when it next starts\.$/,
      ),
    ).toBeVisible();
    await expect(window.locator("[data-newer-dot]")).toHaveCount(0);

    // Off: no request at all, also not from the menu item, which then only opens About.
    const before = site.asked.length;
    await about.getByLabel("Check for a newer version").uncheck();
    await expect(versionLine(about)).toHaveText("Matters does not check for newer versions.");
    await expect(about.getByRole("button", { name: "Check now" })).toBeDisabled();
    if (process.platform === "darwin") {
      await running.app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.items[0]?.submenu?.items[1]?.click(),
      );
    }
    await window.waitForTimeout(500);
    expect(site.asked.length).toBe(before);
    await settings.screenshot({ path: test.info().outputPath("about-off.png") });
  } finally {
    await site.stop();
  }
});

test("a build that is not packaged and has no stand-in never asks, and says so", async ({
  start,
}) => {
  const running = await start(demo());
  const { window } = running;
  await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
  await expect(window.locator("[data-newer-dot]")).toHaveCount(0);
  const settings = await openSettingsFrom(running, "Settings");
  await settings.getByRole("button", { name: "About" }).click();
  const about = settings.getByRole("region", { name: "About" });
  await expect(versionLine(about)).toHaveText("This build does not check for newer versions.");
  await expect(
    about.getByText("It was not made by the release workflow.", { exact: true }),
  ).toBeVisible();
  await expect(about.getByLabel("Check for a newer version")).toBeDisabled();
  await expect(about.getByRole("button", { name: "Check now" })).toBeDisabled();
});

/** Installs only on macOS with Apple silicon (ADR 0140, rule 2). */
const installsHere = process.platform === "darwin" && process.arch === "arm64";

test("Install downloads only when pressed, stops at a wrong checksum, and can be cancelled", async ({
  start,
}) => {
  const site = await standIn();
  // A stand-in folder of apps, with a stand-in Matters.app: never /Applications.
  const apps = mkdtempSync(join(tmpdir(), "matters-e2e-apps-"));
  mkdirSync(join(apps, "Matters.app"));
  try {
    site.serve("v0.1.0-alpha.5", '"one"');
    const image = "Matters-0.1.0-alpha.5-arm64.dmg";
    site.files.set(image, "not a disk image");
    site.files.set("SHA256SUMS.txt", `${"0".repeat(64)}  ${image}\n`);
    const running = await start(
      demo({
        MATTERS_TEST_RELEASE_URL: site.url,
        MATTERS_TEST_INSTALL_URL: site.downloads,
        MATTERS_TEST_INSTALL_DIR: apps,
      }),
    );
    const { window } = running;
    await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
    const settings = await openSettingsFrom(running, "Settings · Matters 0.1.0-alpha.5 is out");
    const about = settings.getByRole("region", { name: "About" });
    await expect(versionLine(about)).toHaveText(/0\.1\.0-alpha\.5 is out\./);
    const downloads = () => site.asked.filter((a) => a.url.startsWith("/download/"));

    if (!installsHere) {
      await expect(
        about.getByText(
          "Matters cannot install it here: it installs only on a Mac with Apple silicon. The download opens in your browser.",
        ),
      ).toBeVisible();
      await expect(about.getByRole("button", { name: "Install and Restart" })).toHaveCount(0);
      expect(downloads()).toHaveLength(0);
      return;
    }

    // Offered, and nothing downloaded before the press (rule 1).
    const install = about.getByRole("button", { name: "Install and Restart" });
    await expect(install).toBeVisible();
    await expect(
      about.getByText(/^Install and Restart downloads it from GitHub, checks it as the installer/),
    ).toBeVisible();
    await window.waitForTimeout(500);
    expect(downloads()).toHaveLength(0);
    await settings.screenshot({ path: test.info().outputPath("about-install.png") });

    // A wrong checksum: stopped, said, nothing in the folder, and Download stays.
    await install.click();
    const line = about.locator("[data-install-line]");
    await expect(line).toHaveText(
      "The download does not match its checksum. Nothing was installed.",
    );
    expect(downloads().map((a) => a.url)).toEqual([
      `/download/v0.1.0-alpha.5/${image}`,
      "/download/v0.1.0-alpha.5/SHA256SUMS.txt",
    ]);
    expect(downloads()[0]?.headers["user-agent"]).toBe("Matters");
    expect(downloads()[0]?.headers.cookie).toBeUndefined();
    expect(readdirSync(apps)).toEqual(["Matters.app"]);
    expect(existsSync(join(apps, ".Matters.app.lock"))).toBe(false);
    await expect(about.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(install).toBeVisible();
    await settings.screenshot({ path: test.info().outputPath("about-install-failed.png") });

    // A download that takes its time: said with how much has come, and Cancel stops it.
    site.files.set(image, "slow");
    await install.click();
    await expect(line).toHaveText(/^Downloading 0\.1\.0-alpha\.5: \d+ of 100 MB…$/);
    await expect(about.getByLabel("Check for a newer version")).toBeDisabled();
    await settings.screenshot({ path: test.info().outputPath("about-install-downloading.png") });

    // A check while it downloads finds no newer version: the line and Cancel stay, and nothing
    // offers to install (ADR 0140, rule 5).
    const checkNow = about.getByRole("button", { name: "Check now" });
    const asks = () => site.asked.filter((a) => a.url === "/release.json").length;
    const asksBefore = asks();
    site.serve("v0.0.0", '"newest"');
    await checkNow.click();
    await expect.poll(asks).toBe(asksBefore + 1);
    await expect(about.getByText("0.1.0-alpha.5 is out.", { exact: true })).toHaveCount(0);
    await expect(line).toHaveText(/^Downloading 0\.1\.0-alpha\.5: \d+ of 100 MB…$/);
    await expect(about.getByRole("button", { name: "Cancel" })).toBeVisible();
    await expect(install).toHaveCount(0);
    await settings.screenshot({ path: test.info().outputPath("about-install-checked.png") });
    // The newer version is out again, so what follows reads as before.
    site.serve("v0.1.0-alpha.5", '"again"');
    await checkNow.click();
    await expect.poll(asks).toBe(asksBefore + 2);
    await expect(about.getByText("0.1.0-alpha.5 is out.", { exact: true })).toBeVisible();
    await expect(line).toHaveText(/^Downloading 0\.1\.0-alpha\.5: \d+ of 100 MB…$/);

    await about.getByRole("button", { name: "Cancel" }).click();
    await expect(line).toHaveText("Cancelled. Nothing was installed.");
    await expect(about.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    expect(readdirSync(apps)).toEqual(["Matters.app"]);
  } finally {
    await site.stop();
    rmSync(apps, { recursive: true, force: true });
  }
});
