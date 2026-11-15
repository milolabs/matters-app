import { describe, expect, it, vi } from "vitest";
import { createEraseBridge } from "../src/preload/eraseBridge.ts";
import { createStorageBridge } from "../src/preload/storageBridge.ts";

// The page is untrusted. Only the window's own well-shaped requests may reach main.
for (const [name, create, requestKey, answerKey, action, channel] of [
  ["erase", createEraseBridge, "mattersErase", "mattersEraseAnswer", "state", "matters:erase"],
  [
    "storage",
    createStorageBridge,
    "mattersStorage",
    "mattersStorageAnswer",
    "eraseOverview",
    "matters:storage",
  ],
] as const) {
  function rig() {
    const page = {};
    const invoke = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true }));
    const post = vi.fn();
    const bridge = create({ invoke, post }, page);
    const send = (ask: unknown) => bridge.message({ source: page, data: { [requestKey]: ask } });
    return { page, invoke, post, bridge, send };
  }

  describe(`${name} bridge request boundary`, () => {
    it.each([
      null,
      1,
      "request",
      {},
      { requestId: 1, action },
      { requestId: "x".repeat(101), action },
    ])("ignores malformed requests: %j", (ask) => {
      const r = rig();
      r.send(ask);
      expect(r.invoke).not.toHaveBeenCalled();
      expect(r.post).not.toHaveBeenCalled();
    });

    it("ignores requests from another window and malformed event data", () => {
      const r = rig();
      r.bridge.message({ source: {}, data: { [requestKey]: { requestId: "1", action } } });
      for (const data of [null, undefined, 42, "request", {}])
        r.bridge.message({ source: r.page, data });
      expect(r.invoke).not.toHaveBeenCalled();
      expect(r.post).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 1, "https://example.org", "constructor"])(
      "answers unsupported actions without invoking main: %j",
      (invalid) => {
        const r = rig();
        r.send({ requestId: "1", action: invalid });
        expect(r.invoke).not.toHaveBeenCalled();
        expect(r.post).toHaveBeenCalledExactlyOnceWith({
          [answerKey]: { requestId: "1", answer: null },
        });
      },
    );

    it("accepts a 100-character request ID and correlates the response", async () => {
      const r = rig();
      const requestId = "x".repeat(100);
      r.send({ requestId, action, path: "/arbitrary", earlierCopy: true });
      expect(r.invoke).toHaveBeenCalledExactlyOnceWith(channel, action);
      await vi.waitFor(() =>
        expect(r.post).toHaveBeenCalledExactlyOnceWith({
          [answerKey]: { requestId, answer: { ok: true } },
        }),
      );
    });

    it.each([null, undefined, false, 42, "backend text"])(
      "normalizes non-object answers to null: %j",
      async (answer) => {
        const r = rig();
        r.invoke.mockResolvedValueOnce(answer);
        r.send({ requestId: "1", action });
        await vi.waitFor(() =>
          expect(r.post).toHaveBeenCalledExactlyOnceWith({
            [answerKey]: { requestId: "1", answer: null },
          }),
        );
      },
    );

    it("answers a rejected invocation without leaking its error", async () => {
      const r = rig();
      r.invoke.mockRejectedValueOnce(new Error("private backend detail"));
      r.send({ requestId: "1", action });
      await vi.waitFor(() =>
        expect(r.post).toHaveBeenCalledExactlyOnceWith({
          [answerKey]: { requestId: "1", answer: null },
        }),
      );
    });
  });
}

describe("storage erase arguments", () => {
  function rig() {
    const page = {};
    const invoke = vi.fn(async () => ({}));
    const bridge = createStorageBridge({ invoke, post: () => {} }, page);
    return {
      invoke,
      send: (ask: object) =>
        bridge.message({ source: page, data: { mattersStorage: { requestId: "1", ...ask } } }),
    };
  }

  it.each([true, false, "true", 1, null, undefined])(
    "requires literal true to include the earlier copy: %j",
    (earlierCopy) => {
      const r = rig();
      r.send({
        action: "erase",
        earlierCopy,
        pages: [
          "microsoftPersonal",
          null,
          "microsoftWork",
          "microsoftPersonal",
          "https://example.org",
          1,
        ],
      });
      expect(r.invoke).toHaveBeenCalledExactlyOnceWith(
        "matters:storage",
        "erase",
        earlierCopy === true,
        ["microsoftPersonal", "microsoftWork"],
      );
    },
  );

  it.each([undefined, null, "microsoftWork", {}])(
    "treats non-array page lists as empty: %j",
    (pages) => {
      const r = rig();
      r.send({ action: "erase", pages });
      expect(r.invoke).toHaveBeenCalledExactlyOnceWith("matters:storage", "erase", false, []);
    },
  );

  it.each(["microsoftWork", "microsoftPersonal", "https://example.org", "constructor", undefined])(
    "only passes declared permission page names: %j",
    (page) => {
      const r = rig();
      r.send({ action: "permissionPage", page });
      const allowed = page === "microsoftWork" || page === "microsoftPersonal";
      expect(r.invoke).toHaveBeenCalledExactlyOnceWith(
        "matters:storage",
        "permissionPage",
        allowed ? page : null,
      );
    },
  );
});

describe("erase bridge actions and progress", () => {
  it.each([
    "state",
    "retry",
    "startAgain",
    "leave",
    "quit",
    "keychain",
    "show",
    "microsoftWork",
    "microsoftPersonal",
    "pages",
  ])("forwards the declared %s action without page-supplied arguments", (action) => {
    const page = {};
    const invoke = vi.fn(async () => ({}));
    createEraseBridge({ invoke, post: () => {} }, page).message({
      source: page,
      data: { mattersErase: { requestId: "1", action, path: "/arbitrary", args: ["arbitrary"] } },
    });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("matters:erase", action);
  });

  it("forwards progress objects and drops primitive payloads", () => {
    const post = vi.fn();
    const bridge = createEraseBridge({ invoke: async () => ({}), post }, {});
    for (const data of [null, undefined, false, 1, "progress"]) bridge.progress(data);
    expect(post).not.toHaveBeenCalled();
    const progress = { kind: "step", step: "database", bytes: 123 };
    bridge.progress(progress);
    expect(post).toHaveBeenCalledExactlyOnceWith({ mattersEraseProgress: progress });
  });
});
