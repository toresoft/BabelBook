import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective } from "@jsverse/transloco";
import type { UnitRow } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";

const STATES = [
  "translate", "maybe-code", "code", "never-translated", "translate-no", "uncomposable",
] as const;

const PAGE = 50;

/**
 * Source and translation, side by side.
 *
 * This is the tab with which a book is actually checked, and the prototype had
 * nothing like it: a translation could only be judged by opening the finished
 * EPUB and reading it, which is far too late to change anything.
 */
@Component({
  selector: "bb-units",
  standalone: true,
  imports: [FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./units.html",
  styleUrl: "./units.css",
})
export class Units {
  readonly projectId = input.required<string>();
  readonly states = STATES;
  /** The page size, on the template too: the pager is hidden while one page holds all. */
  readonly pageSize = PAGE;

  readonly units = signal<UnitRow[]>([]);
  readonly total = signal(0);
  readonly state = signal("");
  readonly search = signal("");
  readonly offset = signal(0);
  readonly loading = signal(false);

  #ipc = inject(IpcService);

  constructor() {
    // Reads every signal the query is built from, so changing a filter
    // reloads without a subscription to wire up by hand.
    effect(() => {
      const id = this.projectId();
      const query = { state: this.state(), search: this.search(), offset: this.offset() };
      if (id !== "") void this.load(id, query);
    });
  }

  async load(
    projectId: string, query: { state: string; search: string; offset: number },
  ): Promise<void> {
    this.loading.set(true);
    try {
      const page = await this.#ipc.invoke("units.list", {
        projectId,
        ...(query.state === "" ? {} : { state: query.state }),
        ...(query.search === "" ? {} : { search: query.search }),
        limit: PAGE,
        offset: query.offset,
      });
      this.units.set(page.units);
      this.total.set(page.total);
    } finally {
      this.loading.set(false);
    }
  }

  /** A new filter starts at the beginning: page 4 of a different question is nowhere. */
  onState(state: string): void {
    this.offset.set(0);
    this.state.set(state);
  }

  onSearch(search: string): void {
    this.offset.set(0);
    this.search.set(search);
  }

  more(): void {
    this.offset.update((at) => at + PAGE);
  }

  back(): void {
    this.offset.update((at) => Math.max(0, at - PAGE));
  }
}
