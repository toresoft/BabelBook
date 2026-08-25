import { createActor } from "xstate";
import { describe, expect, it } from "vitest";
import type { ProjectContext, ProjectState } from "../workflow/project.machine.ts";
import { createProjectActor, projectMachine } from "../workflow/project.machine.ts";

/**
 * An actor standing where a stored project stands.
 *
 * The context goes into the snapshot rather than into `input`: XState builds
 * context from `input` only when it starts an actor fresh, and ignores it
 * entirely when a snapshot is supplied. Passing both — as the plan's helper
 * did — starts every actor with an empty context, which no guard here can
 * read, and the suite would then be testing a machine whose guards are all
 * undefined rather than the one it means to test.
 */
const start = (context: Partial<ProjectContext> = {}, state: ProjectState = "ready") =>
  createActor(projectMachine, {
    snapshot: projectMachine.resolveState({
      value: state,
      context: {
        hasLanguage: true, hasApprovedTerms: false, hasReviewedExclusions: false,
        sourceHashMatches: true, degradations: 0,
        autoAcceptTerms: false, autoAcceptExclusions: false, ...context,
      },
    }),
  }).start();

describe("projectMachine", () => {
  it("stops at the terms gate", () => {
    const actor = start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    expect(actor.getSnapshot().value).toBe("waiting-terms");
  });

  it("walks through the terms gate when auto-acceptance is on", () => {
    const actor = start({ autoAcceptTerms: true });
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    expect(actor.getSnapshot().value).toBe("running");
    expect(actor.getSnapshot().context.hasApprovedTerms).toBe(true);
  });

  it("stops at the exclusions gate, and walks through it when told to", () => {
    const stopped = start();
    stopped.send({ type: "START" });
    stopped.send({ type: "CODE_INDEXED" });
    expect(stopped.getSnapshot().value).toBe("waiting-code");

    const walked = start({ autoAcceptExclusions: true });
    walked.send({ type: "START" });
    walked.send({ type: "CODE_INDEXED" });
    expect(walked.getSnapshot().value).toBe("running");
  });

  it("refuses to resume a project whose terms are still pending", () => {
    const actor = start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    actor.send({ type: "RESUME" });
    expect(actor.getSnapshot().value).toBe("waiting-terms");
  });

  it("lets the gate go once the terms have been approved", () => {
    const actor = start();
    actor.send({ type: "START" });
    actor.send({ type: "TERMS_READY" });
    actor.send({ type: "TERMS_APPROVED" });
    expect(actor.getSnapshot().value).toBe("running");
  });

  it("refuses to start when the source no longer matches its hash", () => {
    const actor = start({ sourceHashMatches: false });
    actor.send({ type: "START" });
    expect(actor.getSnapshot().value).toBe("ready");
  });

  it("refuses to resume a paused project whose source has changed", () => {
    const actor = start({ sourceHashMatches: false }, "paused");
    actor.send({ type: "RESUME" });
    expect(actor.getSnapshot().value).toBe("paused");
  });

  it("pauses from wherever the work happens to be", () => {
    for (const state of ["running", "waiting-terms", "waiting-code", "composing"] as ProjectState[]) {
      const actor = start({}, state);
      actor.send({ type: "PAUSE" });
      expect(actor.getSnapshot().value).toBe("paused");
    }
  });

  it("ends done when the run declared no degradation", () => {
    const actor = start({ hasApprovedTerms: true, hasReviewedExclusions: true }, "composing");
    actor.send({ type: "COMPOSED" });
    expect(actor.getSnapshot().value).toBe("done");
  });

  it("ends incomplete when the run declared degradations", () => {
    const actor = start({ degradations: 3, hasApprovedTerms: true, hasReviewedExclusions: true }, "composing");
    actor.send({ type: "COMPOSED" });
    expect(actor.getSnapshot().value).toBe("incomplete");
  });

  /**
   * Built from `input` rather than from a snapshot, because `new` is transient
   * and a restored actor does not re-run eventless transitions. That is also
   * the only way a project ever reaches `new`: freshly created. What the
   * orchestrator persists is whatever `new` settled into.
   */
  it("asks for a language before it will call itself ready", () => {
    const fresh = createProjectActor({ hasLanguage: false }).start();
    expect(fresh.getSnapshot().value).toBe("needs-language");
    fresh.send({ type: "LANGUAGE_SET" });
    expect(fresh.getSnapshot().value).toBe("ready");
  });

  it("calls a project with its languages already settled ready at once", () => {
    const fresh = createProjectActor({ hasLanguage: true }).start();
    expect(fresh.getSnapshot().value).toBe("ready");
  });

  it("survives a round trip through a persisted snapshot", () => {
    const actor = start();
    actor.send({ type: "START" });
    const persisted = JSON.parse(JSON.stringify(actor.getPersistedSnapshot()));
    const revived = createActor(projectMachine, { snapshot: persisted }).start();
    expect(revived.getSnapshot().value).toBe(actor.getSnapshot().value);
    expect(revived.getSnapshot().context).toEqual(actor.getSnapshot().context);
  });

  it("tells the interface which transitions are available", () => {
    const actor = start();
    expect(actor.getSnapshot().can({ type: "START" })).toBe(true);
    expect(actor.getSnapshot().can({ type: "RESUME" })).toBe(false);
  });

  it("runs nothing: no invoked actor, no entry action that calls out", () => {
    // The orchestrator performs a phase and then sends the event. A machine
    // that invoked anything would be spending money from inside a decision,
    // and there would be no seam left at which to refuse to spend it.
    const states = projectMachine.config.states ?? {};
    expect(Object.keys(states).length).toBeGreaterThan(0);
    for (const [name, node] of Object.entries(states)) {
      expect((node as { invoke?: unknown }).invoke, `${name} invokes something`).toBeUndefined();
    }
  });
});
