// The themes that come with the app (ADR 0134, rule 12). They are data in the format of a theme
// file and pass the same check as one the person adds (`test/themes.test.ts` runs them through
// `parseTheme`). Quiet like the default: warm neutrals, one violet for the agent, nothing loud.

/** A built-in theme: its id (never `own-…`) and the file it would be. */
export interface BuiltInTheme {
  readonly id: string;
  readonly file: {
    readonly name: string;
    readonly light?: Readonly<Record<string, string>>;
    readonly dark?: Readonly<Record<string, string>>;
  };
}

export const BUILT_IN_THEMES: readonly BuiltInTheme[] = [
  {
    // Both sets: a warm paper by day, a warm brown-grey by night. The mode stays free (rule 7).
    id: "paper",
    file: {
      name: "Paper",
      light: {
        bg: "#fbf9f4",
        chrome: "#f5f2ea",
        fill: "#efebe2",
        soft: "#f6f3ec",
        selected: "#ebe7dd",
        button: "#e5e0d5",
        pill: "#e6e1d6",
        hairline: "#e7e2d8",
        edge: "#c8c1b2",
        ink: "#24211c",
        mid: "#4f4a42",
        secondary: "#635d53",
        agent: "#5a43b8",
        "agent-soft": "#f1eef8",
        "agent-edge": "#b4a9e3",
        "agent-wash": "#f8f6f8",
        late: "#b23a14",
        good: "#1e6a3c",
        hit: "#f6e0a0",
        "hit-ink": "#3d2c00",
      },
      dark: {
        bg: "#1f1d1a",
        chrome: "#25221e",
        fill: "#2e2a25",
        soft: "#24211d",
        selected: "#34302a",
        button: "#3c372f",
        pill: "#3d3830",
        hairline: "#35312b",
        edge: "#4e483f",
        ink: "#f3efe7",
        mid: "#cdc6ba",
        secondary: "#ada597",
        agent: "#c0b3f5",
        "agent-soft": "#2b2735",
        "agent-edge": "#615892",
        "agent-wash": "#26232a",
        late: "#ff8a62",
        good: "#79cf9b",
        hit: "#6a5013",
        "hit-ink": "#fff0c2",
      },
    },
  },
  {
    // Dark only, deeper than the default's: it keeps the app dark while it is on (rule 7).
    id: "night",
    file: {
      name: "Night",
      dark: {
        bg: "#141416",
        chrome: "#1a1a1d",
        fill: "#222226",
        soft: "#1b1b1e",
        selected: "#27272c",
        button: "#2f2f35",
        pill: "#303036",
        hairline: "#29292e",
        edge: "#42424a",
        ink: "#ececef",
        mid: "#bdbdc4",
        secondary: "#9e9ea6",
        agent: "#ab9ff5",
        "agent-soft": "#221f33",
        "agent-edge": "#534c8f",
        "agent-wash": "#1c1a26",
        late: "#ff7a52",
        good: "#66c48e",
        hit: "#5e470f",
        "hit-ink": "#fff0c2",
      },
    },
  },
];
