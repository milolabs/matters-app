import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../site/site.js", import.meta.url), "utf8");

// Only the browser boundary is faked: execute the complete, unmodified page script, including
// its top-level await, in a fresh context so repeated tests cannot reuse a module's state.
async function page({
  clipboard = true,
  denied = false,
  code = true,
  release = {} as Record<string, unknown>,
  offline = false,
  ok = true,
} = {}) {
  const command = "curl -fsSL https://getmatters.app/install.sh | bash";
  const handlers = new Map<string, () => Promise<void>>();
  const codeElement = {};
  const button = {
    hidden: true,
    textContent: "Copy",
    dataset: { copy: command },
    parentElement: { querySelector: vi.fn(() => (code ? codeElement : null)) },
    addEventListener: vi.fn((event: string, fn: () => Promise<void>) => handlers.set(event, fn)),
  };
  const primary = [
    { href: "download.html", textContent: "Get Matters" },
    { href: "download.html", textContent: "Download" },
  ];
  const file = {
    href: "https://github.com/milolabs/matters-app/releases",
    textContent: "download the disk image",
  };
  const released = { hidden: true };
  const version = { textContent: "See releases", append: vi.fn() };
  const elements: Record<string, unknown[]> = {
    "[data-copy]": [button],
    '[data-download="file"]': [file],
    '[data-download]:not([data-download="file"])': primary,
    "[data-version]": [version],
    "[data-released]": [released],
  };
  const writeText = denied
    ? vi.fn().mockRejectedValue(new Error("Denied"))
    : vi.fn().mockResolvedValue(undefined);
  const selectAllChildren = vi.fn();
  const fetch = offline
    ? vi.fn().mockRejectedValue(new Error("Offline"))
    : vi.fn().mockResolvedValue({ ok, json: async () => release });
  await runInNewContext(`(async () => { ${source}\n })()`, {
    document: {
      querySelectorAll: (selector: string) => elements[selector] ?? [],
      createElement: () => ({ href: "", textContent: "" }),
    },
    navigator: clipboard ? { clipboard: { writeText } } : {},
    getSelection: () => ({ selectAllChildren }),
    fetch,
    setTimeout,
  });
  return {
    button,
    click: () => handlers.get("click")?.(),
    writeText,
    selectAllChildren,
    codeElement,
    primary,
    file,
    version,
    released,
    command,
    fetch,
  };
}

afterEach(() => vi.useRealTimers());

describe("the site's install and download controls (ADR 0139)", () => {
  it("keeps Copy hidden when the Clipboard API is unavailable", async () => {
    const p = await page({ clipboard: false });
    expect(p.button.hidden).toBe(true);
    expect(p.button.addEventListener).not.toHaveBeenCalled();
  });

  it("copies the exact command, confirms it and resets after 1600ms", async () => {
    vi.useFakeTimers();
    const p = await page();
    expect(p.button.hidden).toBe(false);
    await p.click();
    expect(p.writeText).toHaveBeenCalledWith(p.command);
    expect(p.button.textContent).toBe("Copied");
    expect(p.selectAllChildren).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1599);
    expect(p.button.textContent).toBe("Copied");
    vi.advanceTimersByTime(1);
    expect(p.button.textContent).toBe("Copy");
  });

  it("selects the command for manual copying when clipboard access is denied", async () => {
    vi.useFakeTimers();
    const p = await page({ denied: true });
    await p.click();
    expect(p.selectAllChildren).toHaveBeenCalledWith(p.codeElement);
    expect(p.button.textContent).toBe("Press ⌘C");
    vi.advanceTimersByTime(1600);
    expect(p.button.textContent).toBe("Copy");
  });

  it("still resets the button if a denied copy has no adjacent code element", async () => {
    vi.useFakeTimers();
    const p = await page({ denied: true, code: false });
    await expect(p.click()).resolves.toBeUndefined();
    expect(p.selectAllChildren).not.toHaveBeenCalled();
    expect(p.button.textContent).toBe("Press ⌘C");
    vi.advanceTimersByTime(1600);
    expect(p.button.textContent).toBe("Copy");
  });

  it.each(["alpha", "beta", undefined])(
    "routes the %s release buttons to installation instructions and only the file link to the image",
    async (stage) => {
      const url =
        "https://github.com/milolabs/matters-app/releases/download/v1.0.0/Matters-1.0.0-arm64.dmg";
      const p = await page({ release: { version: "1.0.0", date: "2026-11-15", url, stage } });
      for (const link of p.primary) {
        expect(link.href).toBe("download.html");
        expect(link.textContent).toBe(
          stage ? `Get the ${stage} (Apple silicon)` : "Get it for macOS (Apple silicon)",
        );
      }
      expect(p.file.href).toBe(url);
      expect(p.file.textContent).toBe("download the disk image");
      expect(p.released.hidden).toBe(false);
      expect(p.fetch).toHaveBeenCalledWith("release.json", { cache: "no-cache" });
    },
  );

  it.each([{}, { version: "1.0.0" }, { url: "https://example.test/file.dmg" }])(
    "preserves served download destinations for incomplete release %j",
    async (release) => {
      const p = await page({ release });
      expect(p.primary.map((link) => link.href)).toEqual(["download.html", "download.html"]);
      expect(p.primary.map((link) => link.textContent)).toEqual(["Get Matters", "Download"]);
      expect(p.file.href).toBe("https://github.com/milolabs/matters-app/releases");
      expect(p.released.hidden).toBe(true);
    },
  );

  it.each([{ offline: true }, { ok: false }])(
    "keeps copy working when release fetching fails (%j)",
    async (options) => {
      vi.useFakeTimers();
      const p = await page(options);
      expect(p.primary[0]?.href).toBe("download.html");
      await p.click();
      expect(p.writeText).toHaveBeenCalledWith(p.command);
      expect(p.button.textContent).toBe("Copied");
    },
  );
});
