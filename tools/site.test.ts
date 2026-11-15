import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../site/site.js", import.meta.url), "utf8");

// Small DOM port for this dependency-free script; each selector has separate nodes
// so a disk-image rewrite cannot accidentally pass for a download-page link.
async function page(
  options: {
    clipboard?: "available" | "denied" | "absent";
    code?: boolean;
    release?: Record<string, unknown>;
    offline?: boolean;
    ok?: boolean;
  } = {},
) {
  const code = {};
  const listeners = new Map<string, () => Promise<void>>();
  const button = {
    hidden: true,
    textContent: "Copy",
    dataset: { copy: "curl -fsSL https://getmatters.app/install.sh | bash" },
    parentElement: { querySelector: () => (options.code === false ? null : code) },
    addEventListener: (event: string, listener: () => Promise<void>) =>
      listeners.set(event, listener),
  };
  const primary = { href: "download.html", textContent: "View releases" };
  const file = {
    href: "https://github.com/milolabs/matters-app/releases",
    textContent: "download the disk image",
  };
  const released = { hidden: true };
  const unreleased = { hidden: false };
  const nodes: Record<string, unknown[]> = {
    "[data-copy]": [button],
    '[data-download="file"]': [file],
    '[data-download]:not([data-download="file"])': [primary],
    "[data-released]": [released],
    "[data-unreleased]": [unreleased],
  };
  const writeText = vi.fn(async () => {
    if (options.clipboard === "denied") throw new Error("clipboard denied");
  });
  const selectAllChildren = vi.fn();
  const timers: { callback: () => void; delay: number }[] = [];
  const fetch = vi.fn(async () => {
    if (options.offline) throw new Error("offline");
    return { ok: options.ok ?? true, json: async () => options.release ?? {} };
  });
  await runInNewContext(`(async () => {${source}\n})()`, {
    document: { querySelectorAll: (selector: string) => nodes[selector] ?? [] },
    navigator: { clipboard: options.clipboard === "absent" ? undefined : { writeText } },
    getSelection: () => ({ selectAllChildren }),
    setTimeout: (callback: () => void, delay: number) => timers.push({ callback, delay }),
    fetch,
  });
  return {
    button,
    primary,
    file,
    released,
    unreleased,
    writeText,
    selectAllChildren,
    code,
    timers,
    fetch,
    click: () => listeners.get("click")?.(),
  };
}

const release = {
  version: "0.1.0-alpha.5",
  url: "https://example.test/Matters.dmg",
  stage: "alpha",
  date: "2026-11-15",
};

describe("installer copy button", () => {
  it("shows a working button, copies the exact command and resets its label", async () => {
    const p = await page();
    expect(p.button.hidden).toBe(false);
    await p.click();
    expect(p.writeText).toHaveBeenCalledExactlyOnceWith(p.button.dataset.copy);
    expect(p.button.textContent).toBe("Copied");
    expect(p.selectAllChildren).not.toHaveBeenCalled();
    expect(p.timers).toHaveLength(1);
    expect(p.timers[0]?.delay).toBe(1600);
    p.timers[0]?.callback();
    expect(p.button.textContent).toBe("Copy");
  });

  it("keeps the button hidden when the clipboard API is unavailable", async () => {
    const p = await page({ clipboard: "absent" });
    expect(p.button.hidden).toBe(true);
    expect(p.click()).toBeUndefined();
    expect(p.writeText).not.toHaveBeenCalled();
  });

  it.each([true, false])("handles denied clipboard access with code present: %s", async (code) => {
    const p = await page({ clipboard: "denied", code });
    await p.click();
    expect(p.button.textContent).toBe("Press ⌘C");
    if (code) expect(p.selectAllChildren).toHaveBeenCalledExactlyOnceWith(p.code);
    else expect(p.selectAllChildren).not.toHaveBeenCalled();
    p.timers[0]?.callback();
    expect(p.button.textContent).toBe("Copy");
  });

  it("still copies the command when release metadata cannot be fetched", async () => {
    const p = await page({ offline: true });
    await p.click();
    expect(p.writeText).toHaveBeenCalledExactlyOnceWith(p.button.dataset.copy);
  });
});

describe("installer-first release links", () => {
  it.each(["alpha", "beta", ""])(
    "keeps the download page link for stage '%s' and updates only the image link",
    async (stage) => {
      const p = await page({ release: { ...release, stage } });
      expect(p.fetch).toHaveBeenCalledExactlyOnceWith("release.json", { cache: "no-cache" });
      expect(p.primary.href).toBe("download.html");
      expect(p.primary.textContent).toBe(
        stage ? `Get the ${stage} (Apple silicon)` : "Get it for macOS (Apple silicon)",
      );
      expect(p.file.href).toBe(release.url);
      expect(p.file.textContent).toBe("download the disk image");
      expect(p.released.hidden).toBe(false);
      expect(p.unreleased.hidden).toBe(true);
    },
  );

  it.each([{}, { version: release.version }, { url: release.url }])(
    "does not offer an incomplete release: %j",
    async (metadata) => {
      const p = await page({ release: metadata });
      expect(p.primary.href).toBe("download.html");
      expect(p.primary.textContent).toBe("View releases");
      expect(p.file.href).toBe("https://github.com/milolabs/matters-app/releases");
      expect(p.released.hidden).toBe(true);
      expect(p.unreleased.hidden).toBe(false);
    },
  );

  it.each([{ offline: true }, { ok: false }])(
    "preserves served download links on fetch failure: %j",
    async (failure) => {
      const p = await page({ ...failure, release });
      expect(p.primary.href).toBe("download.html");
      expect(p.file.href).toBe("https://github.com/milolabs/matters-app/releases");
      expect(p.released.hidden).toBe(true);
    },
  );
});
