import {
  ChangeDetectionStrategy, Component, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";
import type { Report } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";

/**
 * What happened to a book.
 *
 * The report carries codes; the sentences are composed here from the
 * catalogue, in the reader's language. Two things it must never blur: a
 * degradation is not a declaration, and a check that did not run is not a
 * check that passed.
 */
@Component({
  selector: "bb-report",
  standalone: true,
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./report.html",
  styleUrl: "./report.css",
})
export class ReportView {
  readonly projectId = input.required<string>();

  readonly report = signal<Report | null>(null);
  readonly loading = signal(true);

  #ipc = inject(IpcService);
  #off: Array<() => void> = [];

  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id !== "") void this.reload(id);
    });

    // A report read while the run is still going is a report of a moment: it is
    // asked again whenever the run moves.
    this.#off.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.projectId()) void this.reload();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
  }

  async reload(projectId = this.projectId()): Promise<void> {
    this.loading.set(true);
    try {
      this.report.set(await this.#ipc.invoke("report.get", { projectId }));
    } finally {
      this.loading.set(false);
    }
  }

  /** The invariants that failed, first: a passing list is not what is read. */
  failed(report: Report): Report["invariants"] {
    return report.invariants.filter((invariant) => !invariant.ok && !invariant.skipped);
  }

  passed(report: Report): number {
    return report.invariants.filter((invariant) => invariant.ok).length;
  }

  async open(path: string): Promise<void> {
    await this.#ipc.invoke("file.open", { path });
  }

  async reveal(path: string): Promise<void> {
    await this.#ipc.invoke("file.reveal", { path });
  }

  /** The name the book was produced under, offered as where to save it. */
  suggestedName(): string {
    return this.report()?.outputPath?.split("/").pop() ?? "book.epub";
  }

  async exportEpub(): Promise<void> {
    const to = await this.#ipc.invoke("ui.chooseSave", {
      defaultName: this.suggestedName(), kind: "epub",
    });
    if (to === null) return;
    // The name travels with the request: a retranslation under a new language
    // leaves the old EPUB in the same folder, and the copy must be of the
    // book this report is about.
    await this.#ipc.invoke("project.export", {
      id: this.projectId(), to, from: this.suggestedName(),
    });
  }
}
