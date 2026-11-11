# Matters brand

The mark is **Weight**: an M made of rope, bent by one heavy ball. What matters weighs more.

## Rules

- Dark first. The icon is a dark plate (`#1D1C1F`) with a light M (`#F5F1EA`). Light is a variant.
- Only the ball is round. The M has flat ends, flat-topped peaks and corners of radius s/6.
- The ball is the only color: `#9A88F5` on dark, `#5B45C9` on light. Never red: red is the
  system's unread badge.
- Wordmark: Rubik SemiBold, tracking −3%. Inside the app: the system UI font.

## Construction (plate = 100)

| Measure      | Value                        |
| ------------ | ---------------------------- |
| Glyph width  | 100 / φ = 61.8               |
| Glyph height | width · φ / 2 = 50           |
| Stroke s     | width / φ⁴ = 9               |
| Ball         | diameter s · φ² = 23.6       |
| Lowest point | height / φ from the top      |
| Rope         | wraps the ball (R = r + s/2), straight tangents to the posts |

Three masters keep small sizes crisp: **regular** (48 px and up), **small** (24–47 px, stroke 11),
**micro** (16–23 px, stroke 13.5).

## Files

| Folder     | What                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| `mark/`    | Glyph only, per master, in dark, light and one-color versions; the macOS and desktop icons as SVG |
| `ios/`     | App icon 1024, dark (default), light and tinted; full-bleed squares, the system masks them |
| `android/` | Adaptive icon layers (108 dp, glyph inside the 66 dp safe zone), monochrome layer, Play Store 512 |
| `web/`     | `favicon.svg`, `favicon.ico` (16/32/48), `apple-touch-icon.png`, PWA 192/512 and maskable 512 |

The desktop app's own icons live in `apps/desktop/build/icons`: `icon.icns` (macOS, 16–1024),
`icon.ico` (Windows, 16–256), `png/` (Linux, 16–512) and `icon.png` (1024, the dock icon in dev runs).
