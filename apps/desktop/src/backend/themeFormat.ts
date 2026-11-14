// What a theme is, for the turn that makes one (ADR 0134, rule 14), from the same tables main's
// check reads (`@matters/contracts`). Core builds the words from this data and imports nothing of
// the app, so the format the agent is told and the one main checks are one.
import {
  CONTRAST_NEEDED,
  CONTRAST_PAIRS,
  DEFAULT_THEME_COLORS,
  THEME_FILE_LIMIT,
  THEME_NAME_LIMIT,
  THEME_SCHEMES,
  THEME_TOKEN_USES,
  THEME_TOKENS,
} from "@matters/contracts";
import type { ThemeFormat } from "@matters/core";

export const THEME_FORMAT: ThemeFormat = {
  tokens: THEME_TOKENS.map((token) => ({ token, use: THEME_TOKEN_USES[token] })),
  schemes: THEME_SCHEMES,
  nameLimit: THEME_NAME_LIMIT,
  fileLimit: THEME_FILE_LIMIT,
  needed: CONTRAST_NEEDED,
  pairs: THEME_TOKENS.flatMap((ink) => {
    const surfaces = CONTRAST_PAIRS[ink];
    return surfaces === undefined ? [] : [{ ink, surfaces }];
  }),
  defaults: DEFAULT_THEME_COLORS,
};
