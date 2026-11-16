// The person's own signature blocks and the model's (ADR 0142, rule 6): a block of the answer is
// kept only when it is one of the person's, each of theirs once; the checks of an answer run on what
// is kept.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  acceptAnswers,
  acceptRewrite,
  acceptWrite,
  keepOwnBlocks,
  keepsGaps,
  signatureBlocks,
  withoutSignature,
} from "../src/index.ts";

describe("keepOwnBlocks", () => {
  it("the reviewer's case: a block the model put before the person's goes, theirs stays", () => {
    expect(keepOwnBlocks("Thanks.\n\n--\nAnna", "Thank you.\n\n--\nBot\n\n--\nAnna")).toBe(
      "Thank you.\n\n--\nAnna",
    );
  });

  it("the model's blocks go before, between and after two of the person's", () => {
    const before = "Hi.\n\n--\nAnna\n\n--\nSales lead";
    const answer =
      "Hello.\n\n--\nBot\n\n--\nAnna\n\n-- \nBot two\n\n--\nSales lead\n\n--\nBot three";
    expect(keepOwnBlocks(before, answer)).toBe("Hello.\n\n--\nAnna\n\n--\nSales lead");
    // In whatever order the answer has them, each once.
    expect(keepOwnBlocks(before, "Hello.\n\n--\nSales lead\n\n--\nAnna")).toBe(
      "Hello.\n\n--\nSales lead\n\n--\nAnna",
    );
    // One of the person's written twice is theirs once; the second stands for nothing and goes.
    expect(keepOwnBlocks("Hi.\n\n--\nAnna", "Hello.\n\n--\nAnna\n\n--\nAnna")).toBe(
      "Hello.\n\n--\nAnna",
    );
  });

  it("compares blocks by their lines, white space at line ends aside", () => {
    expect(keepOwnBlocks("Hi.\n\n-- \nAnna  ", "Hello.\r\n\r\n--\r\nAnna\r\n")).toBe(
      "Hello.\n\n-- \nAnna  ",
    );
  });

  it("a block the model reworded is not the person's: theirs comes back where the model put it", () => {
    expect(keepOwnBlocks("Thanks.\n\n--\nAnna", "Thank you.\n\n--\nAnna K.")).toBe(
      "Thank you.\n\n--\nAnna",
    );
    // Reworded and moved above another of theirs: restored in the reworded one's place.
    expect(
      keepOwnBlocks("Hi.\n\n--\nAnna\n\n--\nSales lead", "Hello.\n\n--\nSales\n\n--\nAnna"),
    ).toBe("Hello.\n\n--\nSales lead\n\n--\nAnna");
  });

  it("a block of the person's the answer has nothing in place of is lost: refused", () => {
    expect(keepOwnBlocks("Thanks.\n\n--\nAnna", "Thank you.")).toBeNull();
    expect(keepOwnBlocks("Hi.\n\n--\nAnna\n\n--\nSales lead", "Hello.\n\n--\nAnna")).toBeNull();
    expect(acceptRewrite({ rewritten: "Thank you." }, "Thanks.\n\n--\nAnna")).toEqual({
      ok: false,
      reason: "dropped",
    });
  });

  it("text that is all the model's loses every block", () => {
    expect(keepOwnBlocks("", "Hi.\n\n--\nBot\n\n-- \nBot two")).toBe("Hi.");
    expect(withoutSignature("Hi.\n\n--\nBot\n\n-- \nBot two")).toBe("Hi.");
    expect(withoutSignature("No block here\n")).toBe("No block here\n");
  });

  it("a heading underline is never a block, in the answer or in the person's text", () => {
    expect(withoutSignature("Summary\n--\nTotal: [amount].\n\n--\nBot")).toBe(
      "Summary\n--\nTotal: [amount].",
    );
    expect(signatureBlocks("Summary\n--\nTotal")).toEqual([]);
    expect(keepOwnBlocks("Summary\n--\nTotal", "Sum\n--\nAll")).toBe("Sum\n--\nAll");
    // A `--` right under a line inside a block is that block's text, not a new block.
    expect(signatureBlocks("Hi\n\n--\nAnna\n--\nmore")).toEqual(["--\nAnna\n--\nmore"]);
  });
});

describe("the checks run on what is kept", () => {
  it("the reviewer's case: a gap that stood only in the model's block is lost, in all three", () => {
    const own = "Confirm [date].";
    const signed = "Confirmed.\n\n--\n[date]";
    expect(acceptRewrite({ rewritten: signed }, own)).toEqual({ ok: false, reason: "gaps" });
    expect(acceptWrite({ written: signed }, own)).toEqual({ ok: false, reason: "gaps" });
    expect(
      acceptAnswers({ withAnswers: "Confirm, yes I can.\n\n--\n[date]", added: 1 }, own),
    ).toEqual({ ok: false, reason: "gaps" });
  });

  it("a gap in the person's block comes back with it", () => {
    const own = "See you.\n\n--\nAnna, [phone]";
    expect(acceptRewrite({ rewritten: "See you soon.\n\n--\nAnna" }, own)).toEqual({
      ok: true,
      value: "See you soon.\n\n--\nAnna, [phone]",
    });
  });

  it("an answer that is only a block of the model's is empty once cut", () => {
    expect(acceptWrite({ written: "--\nBot" }, "")).toEqual({ ok: false, reason: "shape" });
  });
});

// Lines from a small set, so delimiters, heading underlines, gaps and repeats meet often.
const line = fc.constantFrom("Hi", "Anna", "Bot", "[date]", "[x]", "--", "-- ", "", "  ");
const text = fc.array(line, { maxLength: 12 }).map((ls) => ls.join("\n"));
/** A text built from blocks, so the answers often hold the person's blocks, moved or not. */
const blocky = fc
  .tuple(text, fc.array(fc.array(line, { maxLength: 3 }), { maxLength: 4 }))
  .map(([body, blocks]) => [body, ...blocks.map((b) => ["--", ...b].join("\n"))].join("\n\n"));

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

describe("keepOwnBlocks, for any text of the person's and any answer", () => {
  const pair = fc.oneof(
    fc.tuple(text, text),
    fc.tuple(blocky, blocky),
    blocky.chain((before) =>
      fc
        .tuple(
          text,
          fc.shuffledSubarray(signatureBlocks(before)),
          fc.array(blocky, { maxLength: 2 }),
        )
        .chain(([body, theirs, more]) =>
          fc
            .shuffledSubarray([...theirs, ...more], { minLength: theirs.length + more.length })
            .map((parts) => [before, [body, ...parts].join("\n\n")] as const),
        ),
    ),
  );

  it("keeps every block of the person's exactly once and none other, or refuses", () => {
    fc.assert(
      fc.property(pair, ([before, answer]) => {
        const kept = keepOwnBlocks(before, answer);
        const theirs = signatureBlocks(before);
        // Refused exactly when the answer has fewer blocks than the person had.
        expect(kept === null).toBe(signatureBlocks(answer).length < theirs.length);
        if (kept === null) return;
        expect(sorted(signatureBlocks(kept))).toEqual(sorted(theirs));
        // Cutting again changes nothing.
        expect(keepOwnBlocks(before, kept)).toBe(kept);
      }),
      { numRuns: 2000 },
    );
  });

  it("never lets an answer through that lost a gap the check requires", () => {
    fc.assert(
      fc.property(pair, ([own, answer]) => {
        const kept = keepOwnBlocks(own, answer.trim());
        const checks = [
          acceptRewrite({ rewritten: answer }, own),
          acceptWrite({ written: answer }, own),
          acceptAnswers({ withAnswers: answer, added: 1 }, own),
        ];
        for (const got of checks) {
          if (!got.ok) continue;
          // What was checked is what is used: the kept text, with every gap of the person's.
          expect(got.value).toBe(kept);
          expect(keepsGaps(own, got.value)).toBe(true);
        }
        if (kept !== null && !keepsGaps(own, kept)) {
          for (const got of checks) expect(got.ok).toBe(false);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
