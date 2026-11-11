/** The two buttons: plain, and the one that acts. */
export const pill =
  "h-8 cursor-default rounded-[8px] bg-button px-3.5 text-[13px] text-ink disabled:opacity-35";
export const pillPrimary =
  "h-8 cursor-default rounded-[8px] bg-ink px-3.5 text-[13px] font-semibold text-bg disabled:opacity-35";
/** A button that stays out of the way until it is wanted: no fill at rest. */
export const pillQuiet =
  "h-8 cursor-default rounded-[8px] px-3.5 text-[13px] text-mid hover:bg-button hover:text-ink disabled:opacity-35";
/** The button that asks the agent to act: the agent's colour, never black (ADR 0052, rule 10). */
export const pillAgent =
  "h-8 cursor-default rounded-[8px] bg-agent px-3.5 text-[13px] font-semibold text-bg disabled:opacity-35";
/** Quiet rounded input. */
export const field =
  "selectable h-[34px] min-w-0 flex-1 rounded-[9px] bg-fill px-3 text-[14px] outline-none placeholder:text-secondary focus:bg-bg focus:ring-1 focus:ring-edge";
/** A quiet icon button, as in a native toolbar. */
export const toolButton =
  "inline-flex size-[30px] cursor-default items-center justify-center rounded-[7px] text-mid hover:bg-button hover:text-ink";
