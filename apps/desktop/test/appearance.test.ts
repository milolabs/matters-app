import { describe, expect, it } from "vitest";
import {
  appearanceInfo,
  builtInTheme,
  type ChosenTheme,
  DEFAULT_APPEARANCE,
  differsFromDefault,
  fixedSchemeOf,
  isAppearanceMode,
  isOwnThemeId,
  isResetAppearanceChord,
  isThemeId,
  ownThemeFile,
  ownThemeId,
  ownThemeIdOfFile,
  ownThemes,
  parseAppearance,
  RESET_APPEARANCE_ACCELERATOR,
  readAppearanceInfo,
  resolveChosenTheme,
  serializeAppearance,
  themeSourceFor,
  windowColors,
  windowGround,
} from "../src/main/appearance.ts";
import { BUILT_IN_THEMES } from "../src/main/builtInThemes.ts";
import {
  applyThemeColors,
  CHANNEL_APPEARANCE,
  createAppearanceBridge,
} from "../src/preload/appearanceBridge.ts";

// ADR 0134: the mode and theme main keeps in appearance.json, main's state, and the bridge.

describe("parseAppearance", () => {
  it("reads each of the three modes", () => {
    for (const mode of ["system", "light", "dark"] as const) {
      expect(parseAppearance(JSON.stringify({ mode }))).toEqual({ mode, theme: null });
    }
  });

  it("starts at the default without a file", () => {
    expect(parseAppearance(null)).toEqual({ mode: "system", theme: null });
    expect(DEFAULT_APPEARANCE).toEqual({ mode: "system", theme: null });
  });

  it("reads anything else as the default", () => {
    for (const text of [
      "",
      "{",
      "null",
      "42",
      '"dark"',
      '["dark"]',
      "{}",
      '{"mode":"Dark"}',
      '{"mode":"sepia"}',
      '{"mode":1}',
      '{"mode":null}',
      '{"mode":{"dark":true}}',
    ]) {
      expect(parseAppearance(text), text).toEqual({ mode: "system", theme: null });
    }
  });

  it("passes over keys it does not know, and does not write them back", () => {
    const read = parseAppearance('{"mode":"dark","shape":"round","__proto__":{"mode":"light"}}');
    expect(read).toEqual({ mode: "dark", theme: null });
    expect(serializeAppearance(read)).toBe('{"mode":"dark"}');
  });

  it("writes what it reads", () => {
    for (const mode of ["system", "light", "dark"] as const) {
      expect(parseAppearance(serializeAppearance({ mode, theme: null }))).toEqual({
        mode,
        theme: null,
      });
    }
  });

  it("knows only the three modes", () => {
    expect(["system", "light", "dark"].every(isAppearanceMode)).toBe(true);
    for (const v of ["", "auto", "DARK", 0, null, undefined, {}]) {
      expect(isAppearanceMode(v)).toBe(false);
    }
  });
});

const INFO = {
  mode: "dark",
  fixedScheme: null,
  theme: "paper",
  themeChosen: true,
  themes: [
    {
      id: "paper",
      name: "Paper",
      source: "built-in",
      schemes: ["light", "dark"],
      swatches: [
        { ground: "#fbf9f4", ink: "#24211c", accent: "#5a43b8" },
        { ground: "#1f1d1a", ink: "#f3efe7", accent: "#c0b3f5" },
      ],
    },
  ],
  fallback: null,
} as const;

describe("the appearance bridge", () => {
  const page = {};
  const rig = (answer: unknown = INFO) => {
    const posted: unknown[] = [];
    const invoked: unknown[][] = [];
    const bridge = createAppearanceBridge(
      {
        invoke: async (...args) => {
          invoked.push(args);
          if (answer instanceof Error) throw answer;
          return answer;
        },
        post: (m) => posted.push(m),
      },
      page,
    );
    return { bridge, posted, invoked };
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const ask = (r: ReturnType<typeof rig>, body: Record<string, unknown>) =>
    r.bridge.message({ source: page, data: { mattersAppearance: { requestId: "a", ...body } } });

  it("asks main for the appearance, sets a mode, chooses and removes a theme, and resets", async () => {
    const r = rig();
    ask(r, { action: "get" });
    ask(r, { action: "set", mode: "dark" });
    ask(r, { action: "reset", mode: "dark" });
    ask(r, { action: "theme", id: "paper" });
    ask(r, { action: "theme", id: null });
    ask(r, { action: "remove", id: "own-0123456789ab" });
    await flush();
    expect(r.invoked).toEqual([
      [CHANNEL_APPEARANCE, "get"],
      [CHANNEL_APPEARANCE, "set", "dark"],
      [CHANNEL_APPEARANCE, "reset"],
      [CHANNEL_APPEARANCE, "theme", "paper"],
      [CHANNEL_APPEARANCE, "theme", null],
      [CHANNEL_APPEARANCE, "remove", "own-0123456789ab"],
    ]);
    expect(r.posted).toHaveLength(6);
    for (const m of r.posted) {
      expect(m).toEqual({ mattersAppearanceAnswer: { requestId: "a", answer: INFO } });
    }
  });

  it("hands main a theme's text and the page main's answer, either way", async () => {
    const kept = { ok: true, theme: INFO.themes[0], appearance: INFO };
    const r = rig(kept);
    ask(r, { action: "add", text: '{"name":"x"}' });
    await flush();
    expect(r.invoked).toEqual([[CHANNEL_APPEARANCE, "add", '{"name":"x"}']]);
    expect(r.posted).toEqual([{ mattersAppearanceAnswer: { requestId: "a", answer: kept } }]);

    const refused = {
      ok: false,
      problems: [
        {
          kind: "contrast",
          mode: "light",
          ink: "ink",
          surface: "bg",
          ratio: 1.2,
          needed: 4.5,
          message: "In light, …",
        },
        { kind: "format", reason: "not-hex", at: "light.bg", message: "light.bg has to be …" },
      ],
    };
    const no = rig(refused);
    ask(no, { action: "add", text: "{}" });
    await flush();
    expect(no.posted).toEqual([{ mattersAppearanceAnswer: { requestId: "a", answer: refused } }]);
  });

  it("refuses an ask that is not well formed without asking main", async () => {
    const r = rig();
    for (const mode of ["sepia", undefined, 1, "url(x)"]) ask(r, { action: "set", mode });
    for (const id of ["../appearance", "own-xyz", "Paper", "", 1, undefined]) {
      ask(r, { action: "theme", id });
    }
    for (const id of [null, "../../etc/passwd", "own-0123456789ab.json"]) {
      ask(r, { action: "remove", id });
    }
    ask(r, { action: "add", text: 42 });
    ask(r, { action: "add", text: "x".repeat(16 * 1024 * 4 + 1) });
    ask(r, { action: "add", path: "/Users/x/theme.json" });
    ask(r, { action: "rm" });
    await flush();
    expect(r.invoked).toEqual([]);
    expect(r.posted).toHaveLength(17);
    for (const m of r.posted) {
      expect(m).toEqual({ mattersAppearanceAnswer: { requestId: "a", answer: null } });
    }
  });

  it("ignores other sources and malformed asks", async () => {
    const r = rig();
    r.bridge.message({
      source: {},
      data: { mattersAppearance: { requestId: "a", action: "get" } },
    });
    r.bridge.message({ source: page, data: { mattersAppearance: { action: "get" } } });
    r.bridge.message({
      source: page,
      data: { mattersAppearance: { requestId: "r".repeat(101), action: "get" } },
    });
    r.bridge.message({ source: page, data: "mattersAppearance" });
    await flush();
    expect(r.invoked).toEqual([]);
    expect(r.posted).toEqual([]);
  });

  it("passes on only a well-formed answer, and null when main fails", async () => {
    for (const answer of [
      null,
      { ...INFO, mode: "sepia" },
      { ...INFO, theme: "../x" },
      {
        ...INFO,
        themes: [{ ...INFO.themes[0], swatches: [{ ground: "red", ink: "", accent: "" }] }],
      },
      "dark",
      new Error("gone"),
    ]) {
      const r = rig(answer);
      ask(r, { action: "get" });
      await flush();
      expect(r.posted).toEqual([{ mattersAppearanceAnswer: { requestId: "a", answer: null } }]);
    }
    const extra = rig({ ...INFO, path: "/Users/x" });
    ask(extra, { action: "get" });
    await flush();
    expect(extra.posted).toEqual([{ mattersAppearanceAnswer: { requestId: "a", answer: INFO } }]);
  });

  it("puts the colours on first, then tells the page; only checked hex crosses", () => {
    const r = rig();
    const applied: unknown[] = [];
    const apply = (c: unknown) => {
      applied.push(c);
      // The page has not been told yet when the colours go on.
      expect(r.posted).toHaveLength(applied.length - 1);
    };
    r.bridge.changed({ appearance: INFO, colors: { dark: { bg: "#141416" } } }, apply);
    r.bridge.changed({ appearance: INFO, colors: { dark: { bg: "url(x)" } } }, apply);
    r.bridge.changed({ appearance: INFO, colors: { dark: { font: "#141416" } } }, apply);
    r.bridge.changed({ appearance: { mode: "sepia" }, colors: null }, apply);
    r.bridge.changed(null, apply);
    expect(applied).toEqual([{ dark: { bg: "#141416" } }, null, { dark: {} }]);
    expect(r.posted).toEqual([
      { mattersAppearanceChanged: INFO },
      { mattersAppearanceChanged: INFO },
      { mattersAppearanceChanged: INFO },
    ]);
  });
});

describe("the colours on the root element", () => {
  const style = () => {
    const props = new Map<string, string>();
    return {
      props,
      setProperty: (n: string, v: string) => void props.set(n, v),
      removeProperty: (n: string) => {
        props.delete(n);
        return "";
      },
    };
  };

  it("puts on the set of the scheme in force, and takes everything off at the default", () => {
    const s = style();
    s.props.set("--boot-step", "1");
    const colors = { light: { bg: "#fbf9f4" }, dark: { bg: "#1f1d1a", ink: "#f3efe7" } };
    applyThemeColors(s, colors, "dark");
    expect(Object.fromEntries(s.props)).toEqual({
      "--boot-step": "1",
      "--bg": "#1f1d1a",
      "--ink": "#f3efe7",
    });
    applyThemeColors(s, colors, "light");
    expect(Object.fromEntries(s.props)).toEqual({ "--boot-step": "1", "--bg": "#fbf9f4" });
    applyThemeColors(s, null, "light");
    expect(Object.fromEntries(s.props)).toEqual({ "--boot-step": "1" });
  });
});

describe("main's state", () => {
  const night = builtInTheme(BUILT_IN_THEMES, "night");
  const paper = builtInTheme(BUILT_IN_THEMES, "paper");
  const own =
    (text: string | null, kind: "text" | "missing" | "unreadable" = "text") =>
    () =>
      kind === "text" && text !== null
        ? { kind, text }
        : { kind: kind === "text" ? "missing" : kind };

  it("reads the chosen theme and its id from the file", () => {
    expect(parseAppearance('{"mode":"light","theme":"paper"}')).toEqual({
      mode: "light",
      theme: "paper",
    });
    expect(parseAppearance('{"mode":"light","theme":"own-0123456789ab"}').theme).toBe(
      "own-0123456789ab",
    );
    for (const theme of ["../x", "Paper", "own-1", 1, null, "a".repeat(40)]) {
      expect(parseAppearance(JSON.stringify({ mode: "dark", theme })).theme).toBeNull();
    }
    expect(serializeAppearance({ mode: "light", theme: "night" })).toBe(
      '{"mode":"light","theme":"night"}',
    );
  });

  it("makes own ids and file names only of twelve hex digits", () => {
    expect(ownThemeId("0123456789AB")).toBe("own-0123456789ab");
    expect(() => ownThemeId("../x")).toThrow();
    expect(ownThemeFile("own-0123456789ab")).toBe("own-0123456789ab.json");
    expect(ownThemeFile("paper")).toBeNull();
    expect(ownThemeIdOfFile("own-0123456789ab.json")).toBe("own-0123456789ab");
    for (const f of ["paper.json", "own-0123456789ab.txt", ".DS_Store", "own-0123456789ab"]) {
      expect(ownThemeIdOfFile(f)).toBeNull();
    }
    expect(isThemeId("paper") && isOwnThemeId("own-0123456789ab")).toBe(true);
    expect(isOwnThemeId("paper")).toBe(false);
  });

  it("applies a chosen built-in or own theme, and says why it fell back to the default", () => {
    expect(resolveChosenTheme(null, BUILT_IN_THEMES, own(null))).toEqual({
      theme: null,
      fallback: null,
    });
    expect(resolveChosenTheme("night", BUILT_IN_THEMES, own(null)).theme?.theme.name).toBe("Night");
    const file = JSON.stringify({ name: "Mine", dark: { bg: "#101010" } });
    const mine = resolveChosenTheme("own-0123456789ab", BUILT_IN_THEMES, own(file));
    expect(mine.theme).toMatchObject({ id: "own-0123456789ab", source: "own" });

    const cases: [ChosenTheme, RegExp][] = [
      [resolveChosenTheme("sepia", BUILT_IN_THEMES, own(null)), /not in this version/],
      [resolveChosenTheme("own-0123456789ab", BUILT_IN_THEMES, own(null)), /no longer there/],
      [
        resolveChosenTheme("own-0123456789ab", BUILT_IN_THEMES, own(null, "unreadable")),
        /could not be read/,
      ],
      [resolveChosenTheme("own-0123456789ab", BUILT_IN_THEMES, own("{")), /refused: .*not JSON/],
      [
        resolveChosenTheme(
          "own-0123456789ab",
          BUILT_IN_THEMES,
          own('{"name":"Grey","light":{"ink":"#eeeeee"}}'),
        ),
        /refused: In light, the text \(ink\) on the ground \(bg\)/,
      ],
    ];
    for (const [chosen, why] of cases) {
      expect(chosen.theme).toBeNull();
      expect(chosen.fallback).toMatch(why);
      expect(chosen.fallback).toMatch(/Matters started in the default\.$/);
    }
  });

  it("lists own themes from their files by name, and leaves out what fails or is not one", () => {
    const files: Record<string, string> = {
      "own-00000000000b.json": JSON.stringify({ name: "beta", light: {} }),
      "own-00000000000a.json": JSON.stringify({ name: "Alpha", dark: {} }),
      "own-00000000000c.json": "{",
      "paper.json": JSON.stringify({ name: "Sneaky", light: {} }),
    };
    const listed = ownThemes(Object.keys(files), (f) => {
      const text = files[f];
      return text === undefined ? { kind: "missing" } : { kind: "text", text };
    });
    expect(listed.map((t) => [t.id, t.theme.name])).toEqual([
      ["own-00000000000a", "Alpha"],
      ["own-00000000000b", "beta"],
    ]);
  });

  it("fixes the scheme for a theme with one set, and leaves the mode free with both (rule 7)", () => {
    expect(fixedSchemeOf(night)).toBe("dark");
    expect(themeSourceFor("light", night)).toBe("dark");
    expect(themeSourceFor("system", night)).toBe("dark");
    expect(fixedSchemeOf(paper)).toBeNull();
    expect(themeSourceFor("light", paper)).toBe("light");
    expect(themeSourceFor("system", null)).toBe("system");
  });

  it("gives a window the theme's ground, or the default's", () => {
    expect(windowGround(null, true)).toBe("#1e1e20");
    expect(windowGround(null, false)).toBe("#ffffff");
    expect(windowGround(night, true)).toBe("#141416");
    expect(windowGround(paper, false)).toBe("#fbf9f4");
    // A dark-only theme has no light ground; while it is on the window is never light anyway.
    expect(windowGround(night, false)).toBe("#ffffff");
    expect(windowColors(null)).toBeNull();
    expect(windowColors(night)?.dark?.bg).toBe("#141416");
  });

  it("says what Appearance shows, and when there is something to reset", () => {
    const info = appearanceInfo(
      { mode: "light", theme: "night" },
      night,
      null,
      [night, paper].filter((t) => t !== null),
    );
    expect(info).toMatchObject({
      mode: "light",
      fixedScheme: "dark",
      theme: "night",
      themeChosen: true,
      fallback: null,
    });
    expect(info.themes.map((t) => [t.id, t.source, t.schemes])).toEqual([
      ["night", "built-in", ["dark"]],
      ["paper", "built-in", ["light", "dark"]],
    ]);
    expect(readAppearanceInfo(info)).toEqual(info);
    const fell = appearanceInfo({ mode: "system", theme: "own-0123456789ab" }, null, "why", []);
    expect(fell).toMatchObject({ theme: null, themeChosen: true, fallback: "why" });
    expect(differsFromDefault({ mode: "system", theme: null })).toBe(false);
    expect(differsFromDefault({ mode: "dark", theme: null })).toBe(true);
    expect(differsFromDefault({ mode: "system", theme: "own-0123456789ab" })).toBe(true);
  });

  it("knows the keys of the way back on each platform, and nothing near them", () => {
    const key = (over: Partial<Record<string, unknown>>) => ({
      type: "keyDown",
      code: "Digit0",
      alt: true,
      shift: true,
      meta: false,
      control: false,
      ...over,
    });
    expect(RESET_APPEARANCE_ACCELERATOR).toBe("CmdOrCtrl+Alt+Shift+0");
    expect(isResetAppearanceChord(key({ meta: true }), "darwin")).toBe(true);
    expect(isResetAppearanceChord(key({ control: true }), "win32")).toBe(true);
    expect(isResetAppearanceChord(key({ control: true }), "linux")).toBe(true);
    for (const [over, platform] of [
      [{ control: true }, "darwin"],
      [{ meta: true }, "linux"],
      [{ meta: true, alt: false }, "darwin"],
      [{ meta: true, shift: false }, "darwin"],
      [{ meta: true, code: "Digit9" }, "darwin"],
      [{ meta: true, type: "keyUp" }, "darwin"],
      [{ control: true, meta: true }, "win32"],
    ] as const) {
      expect(isResetAppearanceChord(key(over), platform)).toBe(false);
    }
  });
});
