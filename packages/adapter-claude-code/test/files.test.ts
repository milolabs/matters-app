import { type AgentFile, type AgentRunError, isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_STREAM, Harness, request } from "./support.ts";

// ADR 0090, rules 2, 3 and 9: a file with no text goes whole, as a block of one stream-json message.

let h: Harness;
beforeEach(async () => {
  h = await Harness.create();
});
afterEach(async () => {
  await h.cleanup();
});

async function failure(promise: Promise<unknown>): Promise<AgentRunError> {
  try {
    await promise;
  } catch (error) {
    if (isAgentRunError(error)) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

const bytes = (s: string) => new TextEncoder().encode(s);
const PDF: AgentFile = { name: "a.pdf", mediaType: "application/pdf", bytes: bytes("%PDF-1.4 x") };
const PNG: AgentFile = {
  name: "b.png",
  mediaType: "image/png",
  bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]),
};

describe("run with files", () => {
  it("takes files", () => {
    expect(h.runtime().takesFiles).toBe(true);
  });

  it("sends one stream-json user message: the blocks, then the same text", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run({ ...request(), files: [PDF, PNG] });
    const { argv, stdin } = h.record();
    const at = argv.indexOf("--input-format");
    expect(argv[at + 1]).toBe("stream-json");
    expect(stdin.endsWith("\n")).toBe(true);
    expect(stdin.trim().split("\n")).toHaveLength(1);
    const line = JSON.parse(stdin);
    expect(line.type).toBe("user");
    expect(line.message.role).toBe("user");
    const [doc, img, text] = line.message.content;
    expect(doc).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: Buffer.from(PDF.bytes).toString("base64"),
      },
    });
    expect(img.type).toBe("image");
    expect(img.source.media_type).toBe("image/png");
    expect(text).toEqual({ type: "text", text: "MAIL-TEXT: please wire the money" });
    // The file and the mail still never reach argv.
    expect(argv.join(" ")).not.toContain("MAIL-TEXT");
    expect(argv.join(" ")).not.toContain(doc.source.data);
  });

  it("keeps the plain transport when there are no files", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run({ ...request(), files: [] });
    expect(h.record().argv).not.toContain("--input-format");
    expect(h.record().stdin).toBe("MAIL-TEXT: please wire the money");
  });

  it("refuses a file that is not what its type says, before anything starts", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const fake: AgentFile = { name: "x.pdf", mediaType: "application/pdf", bytes: bytes("MZ...") };
    const error = await failure(h.runtime().run({ ...request(), files: [fake] }));
    expect(error.message).toContain("not what its type says");
    expect(h.spawns).toHaveLength(0);
  });

  it("refuses more files than one turn may take", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const error = await failure(h.runtime().run({ ...request(), files: [PDF, PDF, PDF, PDF] }));
    expect(error.message).toContain("Too many files");
    expect(h.spawns).toHaveLength(0);
  });
});
