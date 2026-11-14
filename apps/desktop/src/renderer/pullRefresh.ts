/**
 * Pulling the list down past its top to check for new mail. The page sees only wheel events, with
 * no word on when the fingers lift, so a pull is read from their timing: it starts with the first
 * event after a pause, at the top of the list, going up. It ends when the events stop, or sooner,
 * when they turn into the even, fading run the system sends after the fingers have left the
 * trackpad: fingers move unevenly, that run never grows.
 */

/** How far the list can be drawn down, in px. The string never goes further. */
export const PULL_MAX = 64;
/** Wheel distance past which letting go checks for mail. */
export const PULL_ARM = 200;
/** A pause this long between wheel events ends one gesture; the next event starts another. */
export const PULL_QUIET_MS = 140;
/** This many events in a row, none larger than the one before, are the run after the fingers left. */
export const PULL_COAST = 5;
/** How long the string swings after it is let go. */
export const PULL_SNAP_MS = 420;

const STIFFNESS = 150;

/** How far the list is drawn for a wheel distance: it resists more the further it goes. */
export function pullShown(raw: number): number {
  if (raw <= 0) return 0;
  return PULL_MAX * (1 - Math.exp(-raw / STIFFNESS));
}

/** How far the list is drawn when letting go starts to check for mail. */
export const PULL_ARMED_AT = pullShown(PULL_ARM);

/** How wide the dip in the edge is, in px. */
export const PULL_WIDTH = 232;

/**
 * The edge above the list, sagging `depth` px in its middle as the M of the mark does under its
 * ball (docs/brand): flat where it leaves the edge and flat again at the bottom.
 */
export function pullCurve(depth: number): string {
  const w = PULL_WIDTH;
  const d = Math.round(depth * 100) / 100;
  return `M0 0C${w * 0.3} 0 ${w * 0.34} ${d} ${w / 2} ${d}C${w * 0.66} ${d} ${w * 0.7} 0 ${w} 0`;
}

/** The ball in the dip: its radius, and the height of its centre. It grows as the pull nears enough. */
export function pullBall(depth: number): { readonly r: number; readonly cy: number } {
  const r = 3 + 2 * Math.min(1, Math.max(0, depth) / PULL_ARMED_AT);
  return { r, cy: depth - r - 3.5 };
}

/**
 * Where the let-go string is `ms` after release from `from` px: a swing that dies out. Below zero
 * it is above its rest, which the list's edge hides.
 */
export function pullSnap(from: number, ms: number): number {
  if (ms >= PULL_SNAP_MS) return 0;
  return from * Math.exp(-ms / 80) * Math.cos((ms / 130) * 2 * Math.PI);
}

export interface Pull {
  /**
   * One wheel event. `atTop`: the list is scrolled to its start. Returns the wheel distance
   * pulled so far, 0 when this event is not part of a pull.
   */
  wheel(deltaY: number, atTop: boolean, nowMs: number): number;
  /** The fingers have left the trackpad: what still arrives is the system's fading run. */
  coasting(): boolean;
  /** The pull is over. True when it went far enough to check for mail. */
  release(): boolean;
  pulling(): boolean;
  armed(): boolean;
}

export function createPull(): Pull {
  let raw = 0;
  let pulling = false;
  let lastMs = Number.NEGATIVE_INFINITY;
  // The run of events that never grew: its first size, the latest, and how many followed.
  let runFirst = 0;
  let runLast = 0;
  let run = 0;
  // How far the pull had gone when that run began: what the fingers did, without the run.
  let runFrom = 0;
  const fading = () => run >= PULL_COAST && runLast < runFirst;
  return {
    wheel(deltaY, atTop, nowMs) {
      const fresh = nowMs - lastMs > PULL_QUIET_MS;
      lastMs = nowMs;
      if (!pulling) {
        // The tail of a scroll that reached the top is not a pull: only a new gesture is.
        if (!fresh || !atTop || deltaY >= 0) return 0;
        pulling = true;
        raw = 0;
        runLast = 0;
      }
      const size = Math.abs(deltaY);
      const up = deltaY < 0;
      if (up && size <= runLast) run += 1;
      else {
        run = 0;
        runFirst = up ? size : 0;
      }
      // Pushing back ends the run: the next event up starts another.
      runLast = up ? size : 0;
      raw = Math.max(0, raw - deltaY);
      // Events as large as the run's first are still the fingers', and what was pushed back is
      // no longer pulled: the run counts from here.
      if (!up || size === runFirst) runFrom = raw;
      // Pushed all the way back: the gesture scrolls the list again.
      if (raw === 0) pulling = false;
      return raw;
    },
    coasting: () => pulling && fading(),
    release() {
      // Only the fingers pull far enough: the fading run after a flick does not count.
      const fire = pulling && (fading() ? runFrom : raw) >= PULL_ARM;
      pulling = false;
      raw = 0;
      return fire;
    },
    pulling: () => pulling,
    armed: () => pulling && raw >= PULL_ARM,
  };
}
