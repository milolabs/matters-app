// A newer version (ADR 0137, rule 15): a stand-in for the site's release.json on this machine, the
// dot on the gear, About taking it away, and the lines of Settings › About. On the demo mailbox, so
// no server and no Docker. A build that is not packaged asks only when a test points it at a
// stand-in (`MATTERS_TEST_RELEASE_URL`); without one it never asks, and says so.
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Page } from "@playwright/test";
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
  const server: Server = createServer((req, res) => {
    asked.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
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
    asked,
    serve(version: string | null, etag: string, status = 200) {
      answer = {
        status,
        etag,
        body: JSON.stringify({
          repo: "milolabs/matters-app",
          version,
          date: "2026-11-14T08:00:00Z",
          url: `https://github.com/milolabs/matters-app/releases/download/${version}/Matters-arm64.dmg`,
          notes: `https://github.com/milolabs/matters-app/releases/tag/${version}`,
          stage: "alpha",
          stars: 0,
        }),
      };
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const demo = (env: Record<string, string> = {}) => ({ env: { MATTERS_SEED: "1", ...env } });

async function openSettingsFrom(running: Running, gear: string | RegExp): Promise<Page> {
  const [settings] = await Promise.all([
    running.app.waitForEvent("window"),
    running.window.getByRole("button", { name: gear }).click(),
  ]);
  return settings;
}

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
    await expect(about.getByRole("status")).toHaveText(
      "0.1.0-alpha.5 is out. Published on 14 November.",
    );
    await expect(about.getByRole("button", { name: "Release notes" })).toBeVisible();
    await expect(about.getByRole("button", { name: "Download" })).toBeVisible();
    await expect(
      about.getByText("Matters does not install it. The download opens in your browser."),
    ).toBeVisible();
    await expect(about.getByLabel("Check for a newer version")).toBeChecked();
    await expect(about.getByText(/^Checked today at \d\d:\d\d\.$/)).toBeVisible();
    await settings.screenshot({ path: test.info().outputPath("about-newer.png") });
    await expect(window.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    await expect(window.locator("[data-newer-dot]")).toHaveCount(0);
    await expect(settings.locator("[data-newer-dot]")).toHaveCount(0);
    // About keeps saying what is out for as long as it is true.
    await expect(about.getByRole("status")).toHaveText(/0\.1\.0-alpha\.5 is out\./);

    // Check now sends the ETag it knows; nothing new comes back, nothing changes.
    await about.getByRole("button", { name: "Check now" }).click();
    await expect.poll(() => site.asked.length).toBe(2);
    expect(site.asked[1]?.headers["if-none-match"]).toBe('"one"');
    await expect(about.getByRole("status")).toHaveText(/0\.1\.0-alpha\.5 is out\./);

    // The newest: the site now offers the version that runs.
    site.serve("v0.0.0", '"two"');
    await about.getByRole("button", { name: "Check now" }).click();
    await expect(about.getByRole("status")).toHaveText("This is the newest version.");

    // A failed check is said in Settings only, with when it last worked.
    site.serve("v0.0.0", '"three"', 500);
    await about.getByRole("button", { name: "Check now" }).click();
    await expect(about.getByRole("status")).toHaveText(
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
    await expect(about.getByRole("status")).toHaveText(
      "Matters does not check for newer versions.",
    );
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
  await expect(about.getByRole("status")).toHaveText(
    "This build does not check for newer versions.",
  );
  await expect(about.getByText("It was not made by the release workflow.")).toBeVisible();
  await expect(about.getByLabel("Check for a newer version")).toBeDisabled();
  await expect(about.getByRole("button", { name: "Check now" })).toBeDisabled();
});
