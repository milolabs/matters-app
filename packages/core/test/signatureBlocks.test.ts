// The person's own signature blocks and the model's (ADR 0142, rule 6): a block of the answer is
// kept only when it is one of the person's, each of theirs once, and one the model dropped is put
// back; the checks of an answer run on what is kept.
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

  it("a block of the person's the answer dropped comes back after the kept ones, in their order", () => {
    // The model was told to write no sign-off, and took the person's out too.
    expect(keepOwnBlocks("Thanks.\n\n--\nAnna", "Thank you.")).toBe("Thank you.\n\n--\nAnna");
    expect(keepOwnBlocks("Hi.\n\n--\nAnna\n\n--\nSales lead", "Hello.\n\n--\nAnna")).toBe(
      "Hello.\n\n--\nAnna\n\n--\nSales lead",
    );
    // The one it kept stays where it is; the one it dropped follows.
    expect(keepOwnBlocks("Hi.\n\n--\nAnna\n\n--\nSales lead", "Hello.\n\n--\nSales lead")).toBe(
      "Hello.\n\n--\nSales lead\n\n--\nAnna",
    );
    // The model's one block stands for the first of the person's; the rest follow in their order.
    expect(
      keepOwnBlocks("Hi.\n\n--\nAnna\n\n--\nSales lead\n\n--\n555 0100", "Hello.\n\n--\nBot"),
    ).toBe("Hello.\n\n--\nAnna\n\n--\nSales lead\n\n--\n555 0100");
    // Never refused for it: the rewrite is used with the sign-off back.
    expect(acceptRewrite({ rewritten: "Thank you." }, "Thanks.\n\n--\nAnna")).toEqual({
      ok: true,
      value: "Thank you.\n\n--\nAnna",
    });
    expect(acceptWrite({ written: "Thank you." }, "Thanks.\n\n--\nAnna")).toEqual({
      ok: true,
      value: "Thank you.\n\n--\nAnna",
    });
    expect(
      acceptAnswers({ withAnswers: "Thanks, Tuesday works.", added: 1 }, "Thanks.\n\n--\nAnna"),
    ).toEqual({ ok: true, value: "Thanks, Tuesday works.\n\n--\nAnna" });
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

  it("a gap in the person's block that the model dropped is theirs, and is kept when it comes back", () => {
    const own = "See you.\n\n--\nAnna, [phone]";
    const back = { ok: true, value: "See you soon.\n\n--\nAnna, [phone]" };
    expect(acceptRewrite({ rewritten: "See you soon." }, own)).toEqual(back);
    expect(acceptWrite({ written: "See you soon." }, own)).toEqual(back);
    expect(acceptAnswers({ withAnswers: "See you soon.", added: 1 }, own)).toEqual(back);
  });

  it("a gap the model moved from the body into a block of its own is cut with it: refused", () => {
    const own = "Pay [amount] by Friday.\n\n--\nAnna";
    // The model's block stands for the person's, which comes back in its place; the gap is gone.
    const moved = "Please pay by Friday.\n\n--\nTotal: [amount]";
    expect(keepOwnBlocks(own, moved)).toBe("Please pay by Friday.\n\n--\nAnna");
    expect(acceptRewrite({ rewritten: moved }, own)).toEqual({ ok: false, reason: "gaps" });
    expect(acceptWrite({ written: moved }, own)).toEqual({ ok: false, reason: "gaps" });
    expect(acceptAnswers({ withAnswers: moved, added: 1 }, own)).toEqual({
      ok: false,
      reason: "gaps",
    });
    // The same with the person's block kept too: the model's is cut, and the gap with it.
    const beside = "Please pay by Friday.\n\n--\nAnna\n\n--\nTotal: [amount]";
    expect(acceptRewrite({ rewritten: beside }, own)).toEqual({ ok: false, reason: "gaps" });
  });

  it("an answer that is only a block of the model's is empty once cut", () => {
    expect(acceptWrite({ written: "--\nBot" }, "")).toEqual({ ok: false, reason: "shape" });
  });
});

// Lines from a small set, so delimiters, heading underlines, gaps, the person's own `>` lines
// (a blockquote above the signature is theirs, ADR 0142, rule 4) and repeats meet often.
const line = fc.constantFrom("Hi", "Anna", "Bot", "[date]", "[x]", "--", "-- ", "", "  ", "> Hi");
const text = fc.array(line, { maxLength: 12 }).map((ls) => ls.join("\n"));
/** A text built from blocks, so the answers often hold the person's blocks, moved or not. */
const blocky = fc
  .tuple(text, fc.array(fc.array(line, { maxLength: 3 }), { maxLength: 4 }))
  .map(([body, blocks]) => [body, ...blocks.map((b) => ["--", ...b].join("\n"))].join("\n\n"));

function sorted(xs: readonly string[]): string[] {
  return [...xs].sort();
}

/** Whether `part` is `whole` with some of it left out, the rest in the same order. */
function within(part: readonly string[], whole: readonly string[]): boolean {
  let i = 0;
  for (const x of whole) if (i < part.length && part[i] === x) i++;
  return i === part.length;
}

/** The answer's blocks that are the person's, in the answer's order, each of theirs once. */
function matchedOf(theirs: readonly string[], answer: readonly string[]): string[] {
  const left = [...theirs];
  return answer.flatMap((block) => {
    const i = left.indexOf(block);
    if (i < 0) return [];
    left.splice(i, 1);
    return [block];
  });
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

  it("keeps every block of the person's exactly once and none other, never refusing", () => {
    fc.assert(
      fc.property(pair, ([before, answer]) => {
        const kept = keepOwnBlocks(before, answer);
        const theirs = signatureBlocks(before);
        const answered = signatureBlocks(answer);
        const blocks = signatureBlocks(kept);
        expect(typeof kept).toBe("string");
        // The person's blocks, each once, and no other.
        expect(sorted(blocks)).toEqual(sorted(theirs));
        // As many as the answer had blocks stand where it had them: the answer's own copies of
        // the person's in the answer's order, the person's in place of the model's in theirs.
        const stand = Math.min(answered.length, theirs.length);
        expect(within(matchedOf(theirs, answered), blocks.slice(0, stand))).toBe(true);
        // Those it had no block for follow, in the person's order.
        expect(within(blocks.slice(stand), theirs)).toBe(true);
        if (answered.length === 0) expect(blocks).toEqual(theirs);
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
        if (!keepsGaps(own, kept)) {
          for (const got of checks) expect(got.ok).toBe(false);
        }
        // A quoted line is let through only as often as the person's own text has it.
        const quoted = (t: string) => t.split("\n").filter((l) => l.trimEnd() === "> Hi").length;
        if (quoted(kept) > quoted(own)) {
          for (const got of checks) if (got.ok) expect(got.value).toBe(own);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
