import { describe, expect, it } from "vitest";
import { lanesOf, linkEvents } from "./smoke-security-lanes";

describe("the lanes of a corpus case (ADR 0047)", () => {
  const events = [
    { kind: "compose", lane: "bypass-blocked", to: ["a@example.com"] },
    { kind: "open-external", lane: "bypass-blocked", href: "https://example.com" },
    { kind: "compose", lane: "blocked", to: ["b@example.com"] },
    { kind: "compose", lane: "bypass-images", to: ["c@example.com"] },
  ];

  it("reads a case put past the pipeline in its own blocked lane", () => {
    const { opened, composed } = linkEvents(events, lanesOf("bypass"));
    expect(composed.map((e) => e.to)).toEqual([["a@example.com"]]);
    expect(opened.map((e) => e.href)).toEqual(["https://example.com"]);
  });

  it("reads a case of the pipeline in the plain blocked lane", () => {
    const { opened, composed } = linkEvents(events, lanesOf("pipeline"));
    expect(composed.map((e) => e.to)).toEqual([["b@example.com"]]);
    expect(opened).toEqual([]);
  });
});
