/**
 * The two lines the app opens its own quote with, so a draft's quote is found by them and not by
 * any `>` line the person wrote (ADR 0142, rule 4). Pure.
 */

/** The line that opens a forward's part (ADR 0045), and so ends what the person wrote above it. */
export const FORWARD_MARK = "> Forwarded message";

/** The line `attribution` in reply.ts writes above a reply's quote: "On 3 Nov 2026, 10:29, Anna wrote:". */
const ATTRIBUTION = /^On .+ wrote:\s*$/;

/** Whether a line has the shape of the app's attribution of a reply's quote. */
export function isAttribution(line: string): boolean {
  return ATTRIBUTION.test(line);
}
