import { TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IpcService } from "./core/ipc.service";
import { provideI18n } from "./core/i18n";
import { App } from "./app";
import { routes } from "./app.routes";

// The counts a lived-in library would have: a group's number must be a fact
// the main process told, not a zero that merely means "not asked yet".
const worldCounts = { all: 7, "to-approve": 2, running: 1, paused: 0, done: 4 };

function bridge(answers: Record<string, unknown> = {}) {
  return vi.fn(async (channel: string, payload?: unknown) => {
    // What the test asked for wins over the defaults. The other way round, an
    // override of a channel that has a default is dropped in silence, and the
    // test passes while measuring the fixture instead of its own case.
    if (channel in answers) {
      const answer = answers[channel];
      if (answer instanceof Error) throw answer;
      return typeof answer === "function" ? answer(payload) : answer;
    }
    // The shell renders routed screens, not stubs of them: the library the
    // router opens the window on needs its rows, and everything any screen
    // asks beyond these must survive an `undefined`.
    if (channel === "projects.list") return [];
    if (channel === "projects.counts") return worldCounts;
    // `/new` reads this to decide whether a book can be translated at all.
    if (channel === "providers.list") return [];
    return undefined;
  });
}

function mount(answers: Record<string, unknown> = {}) {
  const invoke = bridge(answers);
  // The real IpcService, with the fake installed as the preload bridge: what
  // the shell invokes then crosses the true path, the one production uses.
  (globalThis as { window?: { babelbook?: unknown } }).window!.babelbook =
    { invoke, on: () => () => {} };
  TestBed.configureTestingModule({
    imports: [App],
    providers: [provideRouter(routes), ...provideI18n("it"), IpcService],
  });
  const fixture = TestBed.createComponent(App);
  return { fixture, invoke, router: TestBed.inject(Router) };
}

afterEach(() => {
  // The bridge is the one global the renderer owns. A spec that leaves it
  // installed hands the next one answers it never chose.
  delete (globalThis as { window?: { babelbook?: unknown } }).window!.babelbook;
});

const calls = (invoke: ReturnType<typeof bridge>, channel: string) =>
  invoke.mock.calls.filter(([name]) => name === channel);

describe("App", () => {
  /**
   * The shell that never leaves.
   *
   * The defect this replaces was not a missing button: entering "New project"
   * left nothing on screen to go back to, because the Cancel inside the form
   * appears only after an EPUB has been analysed. A column that never goes away
   * does not fix that — it makes it unable to happen, and this is the assertion
   * that says so.
   */
  it("keeps the column standing on the screen with no way out of its own", async () => {
    const { fixture, router } = mount();
    await router.navigateByUrl("/new");
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=shell-nav]")).not.toBeNull();
    expect(fixture.nativeElement.querySelector("[data-testid=nav-all]")).not.toBeNull();
  });

  it("shows each group's count beside its name", async () => {
    const { fixture } = mount({ "projects.counts": { all: 7, "to-approve": 2, running: 1, paused: 0, done: 4 } });
    await fixture.whenStable();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector("[data-testid=count-to-approve]").textContent).toContain("2");
  });
});
