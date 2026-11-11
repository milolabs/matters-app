/**
 * When the window has something to show (ADR 0070, rule 3). Main keeps the window hidden until the
 * page says so, or until its own deadline, so what the person first sees is their mail and not a
 * frame of it. With AI on, the app may open on the starter view (ADR 0117, rule 2), so the saved
 * views have to be here too.
 */
export function firstScreenReady(state: {
  readonly accountsLoaded: boolean;
  readonly listLoaded: boolean;
  readonly hasMessages: boolean;
  readonly threadOpen: boolean;
  readonly aiOn: boolean;
  readonly viewsLoaded: boolean;
}): boolean {
  if (!state.accountsLoaded || !state.listLoaded) return false;
  // An empty mailbox has no thread to wait for; the first-run screen comes instead.
  if (state.hasMessages && !state.threadOpen) return false;
  return !state.aiOn || state.viewsLoaded;
}

/** An opened letter settles in, but a window that opens with it has nothing to settle from. */
function finishSettling(): void {
  for (const animation of document.getAnimations()) {
    if ((animation as CSSAnimation).animationName === "settle") animation.finish();
  }
}

/** Long enough for a frame even where no frame comes: a hidden window may not get one at all. */
const NO_FRAME_MS = 100;

/**
 * Says so once what was just rendered is in a frame: two animation frames, the second of which comes
 * after the first was presented. Showing the window sooner would show the frame before it.
 */
export function afterFrames(done: () => void): void {
  let called = false;
  const once = () => {
    if (called) return;
    called = true;
    finishSettling();
    done();
  };
  finishSettling();
  requestAnimationFrame(() => requestAnimationFrame(once));
  setTimeout(once, NO_FRAME_MS);
}
