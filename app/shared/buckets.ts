import type { ProjectState } from "../../core/workflow/project.machine.ts";

/**
 * The eleven states of a project, under the five names a person looks for.
 *
 * The groups do not partition, and that is the design: `new`,
 * `needs-language`, `ready`, `incomplete` and `failed` appear only under
 * Projects, with their own label on the tile. A group earns its place by
 * answering a question someone actually asks — *what is waiting for me?*,
 * *what is running?* — and "not started yet" is not one of them: a project
 * just created is already being looked at.
 *
 * `to-approve` is the group that justifies the extra name. Those two states
 * are the only ones in which a project will never move on its own, and
 * without a place of their own a book stalled at a gate has nowhere to be
 * found.
 */
export type Bucket = "all" | "to-approve" | "running" | "paused" | "done";

export const BUCKETS: readonly Bucket[] = ["all", "to-approve", "running", "paused", "done"];

const STATES: Record<Bucket, readonly ProjectState[]> = {
  all: [],
  "to-approve": ["waiting-terms", "waiting-code"],
  running: ["running", "composing"],
  paused: ["paused"],
  done: ["done"],
};

/** The states a group holds. Empty for `all`, which holds them all. */
export function statesOf(bucket: Bucket): readonly ProjectState[] {
  return STATES[bucket];
}

export function isBucket(value: string): value is Bucket {
  return (BUCKETS as readonly string[]).includes(value);
}
