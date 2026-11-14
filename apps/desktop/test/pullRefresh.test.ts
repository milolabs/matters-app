import { describe, expect, it } from "vitest";
import {
  createPull,
  PULL_ARM,
  PULL_MAX,
  PULL_QUIET_MS,
  PULL_SNAP_MS,
  pullShown,
  pullSnap,
} from "../src/renderer/pullRefresh.ts";

describe("pullShown", () => {
  it("resists more the further it goes, and never passes its limit", () => {
    expect(pullShown(0)).toBe(0);
    expect(pullShown(-20)).toBe(0);
    expect(pullShown(100) - pullShown(50)).toBeLessThan(pullShown(50));
    expect(pullShown(100_000)).toBeLessThanOrEqual(PULL_MAX);
  });
});

describe("pullSnap", () => {
  it("starts where the string was let go and comes to rest", () => {
    expect(pullSnap(60, 0)).toBe(60);
    expect(Math.abs(pullSnap(60, PULL_SNAP_MS - 1))).toBeLessThan(1);
    expect(pullSnap(60, PULL_SNAP_MS)).toBe(0);
  });
});

describe("createPull", () => {
  it("checks for mail when a pull from the top goes far enough", () => {
    const pull = createPull();
    for (let i = 0; i < 10; i++) pull.wheel(-PULL_ARM / 10, true, 1000 + i * 16);
    expect(pull.armed()).toBe(true);
    expect(pull.release()).toBe(true);
    expect(pull.pulling()).toBe(false);
  });

  it("does nothing for a short pull", () => {
    const pull = createPull();
    expect(pull.wheel(-40, true, 1000)).toBe(40);
    expect(pull.armed()).toBe(false);
    expect(pull.release()).toBe(false);
  });

  it("does not take the tail of a scroll that reached the top for a pull", () => {
    const pull = createPull();
    pull.wheel(-80, false, 1000);
    for (let i = 1; i <= 20; i++) expect(pull.wheel(-80, true, 1000 + i * 16)).toBe(0);
    const now = 1000 + 20 * 16;
    expect(pull.release()).toBe(false);
    // After a pause the same movement is a pull.
    expect(pull.wheel(-80, true, now + PULL_QUIET_MS + 1)).toBe(80);
  });

  it("does not start below the top, or going down", () => {
    const pull = createPull();
    expect(pull.wheel(-80, false, 1000)).toBe(0);
    expect(pull.wheel(80, true, 2000)).toBe(0);
    expect(pull.pulling()).toBe(false);
  });

  it("lets go when the fingers leave the trackpad, not when the fading run ends", () => {
    // A recorded pull: uneven while the fingers move, then the system's even, fading run.
    const fingers = [-1, -3, -2, -7, -8, -9, -8, -13, -20, -27, -20, -10, -21, -37, -11, -31];
    const fading = [-34, -34, -33, -37, -35, -34, -34, -32, -32, -30, -29, -28, -28, -27, -25];
    const pull = createPull();
    let at = 1000;
    for (const d of fingers) {
      pull.wheel(d, true, at);
      at += 8;
      expect(pull.coasting()).toBe(false);
    }
    let sent = 0;
    for (const d of fading) {
      pull.wheel(d, true, at);
      at += 8;
      sent += 1;
      if (pull.coasting()) break;
    }
    expect(sent).toBeLessThan(fading.length);
    expect(pull.armed()).toBe(true);
    expect(pull.release()).toBe(true);
    // The rest of the run is no new pull.
    expect(pull.wheel(-25, true, at)).toBe(0);
  });

  it("does not let the fading run after a short flick pull far enough", () => {
    const pull = createPull();
    let at = 1000;
    for (const d of [-4, -12, -9, -30]) {
      pull.wheel(d, true, at);
      at += 8;
    }
    for (let d = 40; d > 30; d -= 1) {
      pull.wheel(-d, true, at);
      at += 8;
    }
    expect(pull.coasting()).toBe(true);
    expect(pull.release()).toBe(false);
  });

  it("holds while the wheel of a mouse turns in even steps", () => {
    const pull = createPull();
    for (let i = 0; i < 12; i++) pull.wheel(-20, true, 1000 + i * 30);
    expect(pull.coasting()).toBe(false);
    expect(pull.armed()).toBe(true);
  });

  it("is taken back by pushing the list up again", () => {
    const pull = createPull();
    pull.wheel(-PULL_ARM, true, 1000);
    expect(pull.armed()).toBe(true);
    pull.wheel(50, true, 1016);
    expect(pull.armed()).toBe(false);
    expect(pull.pulling()).toBe(true);
    pull.wheel(PULL_ARM, true, 1032);
    expect(pull.pulling()).toBe(false);
    expect(pull.release()).toBe(false);
  });
});

describe("the dip and its ball", () => {
  it("is flat at rest and as deep in the middle as the pull", async () => {
    const { pullCurve, PULL_WIDTH } = await import("../src/renderer/pullRefresh.ts");
    expect(pullCurve(0)).toContain(`${PULL_WIDTH / 2} 0C`);
    expect(pullCurve(40)).toContain(`${PULL_WIDTH / 2} 40C`);
  });

  it("keeps the ball inside the dip, growing until the pull is enough", async () => {
    const { pullBall, PULL_ARMED_AT } = await import("../src/renderer/pullRefresh.ts");
    const small = pullBall(PULL_ARMED_AT / 2);
    const full = pullBall(PULL_ARMED_AT);
    expect(small.r).toBeLessThan(full.r);
    expect(pullBall(PULL_MAX).r).toBe(full.r);
    expect(full.cy + full.r).toBeLessThan(PULL_ARMED_AT);
  });
});
