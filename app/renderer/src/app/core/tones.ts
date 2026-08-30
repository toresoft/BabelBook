/** The daisyUI tone a state's badge wears. */
export type Tone = "primary" | "success" | "error" | "warning" | "neutral";

/*
 * The state is seen before it is read: the tone is the colour of what the
 * state means, and every state that asks nothing of the user keeps the
 * neutral line.
 *
 * One table, not one per screen that shows a state: two copies agree today
 * and only by coincidence — a state added to one and not the other would
 * teach the tone instead of the state, silently, in whichever screen was
 * left behind.
 */
const TONES: Record<string, Tone> = {
  ready: "primary",
  running: "primary",
  composing: "primary",
  done: "success",
  failed: "error",
  "waiting-terms": "warning",
  "waiting-code": "warning",
};

/** The tone a state's badge wears: the colour of what the state means. */
export function tone(state: string): Tone {
  return TONES[state] ?? "neutral";
}
