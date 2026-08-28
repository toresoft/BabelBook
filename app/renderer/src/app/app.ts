import { ChangeDetectionStrategy, Component, inject, OnDestroy, signal } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import { BUCKETS } from "../../../shared/buckets.js";
import type { Bucket } from "../../../shared/buckets.js";
import { IpcService } from "./core/ipc.service";
import { SECTIONS } from "./settings/sections";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterLink, RouterLinkActive, RouterOutlet, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./app.html",
})
export class App implements OnDestroy {
  protected readonly buckets = BUCKETS;
  protected readonly sections = SECTIONS;
  protected readonly counts = signal<Record<Bucket, number>>(
    Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>,
  );

  #ipc = inject(IpcService);
  #off: Array<() => void> = [];

  constructor() {
    void this.reload();
    // The counts are as perishable as the library itself: a run that finishes
    // moves a project from one group to another, and a column showing stale
    // numbers is worse than one showing none.
    this.#off.push(this.#ipc.on("project.changed", () => void this.reload()));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
  }

  private async reload(): Promise<void> {
    try {
      this.counts.set(await this.#ipc.invoke("projects.counts", undefined));
    } catch {
      // No bridge — a component test. Zeroes are the honest placeholder.
    }
  }
}
