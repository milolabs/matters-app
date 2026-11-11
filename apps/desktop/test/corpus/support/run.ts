// Shared by the corpus tiers (ADR 0047): one test per check, and a summary at the end.

import { appendFileSync } from "node:fs";
import {
  type Check,
  type CorpusCase,
  judge,
  loadManifest,
  type Tier,
  TierSummary,
} from "@matters/testkit/corpus";
import { afterAll, expect, it } from "vitest";

/** In the report only: where a failing check comes from. */
const cite = (c: CorpusCase) => `${c.id} [${c.sources.join("; ")}]`;

/**
 * Registers a test for every check of every case that has this tier. `measure` returns what each
 * named check measures for the case (computed once per case); a check it cannot answer is a
 * failure, never a skip.
 */
export function runTier(
  tier: Tier,
  measure: (c: CorpusCase, checks: readonly Check[]) => Promise<Record<string, unknown>>,
  options: { timeoutMs?: number; filter?: (c: CorpusCase) => boolean } = {},
): void {
  const summary = new TierSummary(tier);
  const cases = loadManifest().filter((c) => c.tiers[tier] && (options.filter?.(c) ?? true));
  for (const c of cases) {
    const spec = c.tiers[tier];
    if (!spec) continue;
    const shared: { value?: Promise<Record<string, unknown>> } = {};
    for (const check of spec.checks) {
      it(
        `${c.id} › ${check.name}`,
        async () => {
          shared.value ??= measure(c, spec.checks);
          const measured = await shared.value;
          expect(
            Object.hasOwn(measured, check.name),
            `${cite(c)}: no measurement for ${check.name}`,
          ).toBe(true);
          const verdict = judge(check, measured[check.name]);
          summary.record(c, check, verdict);
          if (verdict.status === "fail") {
            // CORPUS_REPORT=file: the measured value of every failing check, as JSON lines, for
            // writing a new gap into the manifest (ADR 0047, rule 5).
            const report = process.env.CORPUS_REPORT;
            if (report) {
              const line = {
                tier,
                id: c.id,
                check: check.name,
                ideal: check.ideal,
                actual: measured[check.name],
              };
              appendFileSync(report, `${JSON.stringify(line)}\n`);
            }
            expect.fail(`${cite(c)}: ${verdict.why}`);
          }
        },
        options.timeoutMs ?? 30_000,
      );
    }
  }
  afterAll(() => {
    console.log(`\n${summary.print()}\n`);
  });
}
