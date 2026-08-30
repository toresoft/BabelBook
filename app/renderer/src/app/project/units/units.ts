import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { UnitRow } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { Detail } from "../detail";
import { GAP, pageItems, type PageItem } from "../pages";

const STATES = [
  "translate", "maybe-code", "code", "never-translated", "translate-no", "uncomposable",
] as const;

/** The choices the footer offers, and the one it opens on. */
const PAGE_SIZES = [10, 20, 30] as const;
const PAGE = 20;

/** Source, translation, state: the widths the three columns are read at. */
const COLUMNS = "minmax(0, 1.6fr) minmax(0, 1.2fr) 9rem";

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
  imports: [Detail, FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./units.html",
  styleUrls: ["../list.css", "./units.css"],
})
export class Units implements OnDestroy {
  readonly projectId = input.required<string>();
  readonly states = STATES;
  readonly pageSizes = PAGE_SIZES;
  readonly columns = COLUMNS;
  readonly gap = GAP;

  readonly units = signal<UnitRow[]>([]);
  readonly total = signal(0);
  readonly state = signal("");
  readonly search = signal("");
  readonly offset = signal(0);
  readonly pageSize = signal<number>(PAGE);
  readonly loading = signal(false);
  /** The row being read in full, if any. */
  readonly opened = signal<UnitRow | null>(null);

  /** True while a filter or a search is holding part of the book back. */
  readonly narrowed = computed(() => this.state() !== "" || this.search() !== "");

  readonly pageCount = computed(() => Math.max(1, Math.ceil(this.total() / this.pageSize())));
  readonly page = computed(() => Math.floor(this.offset() / this.pageSize()) + 1);
  readonly pages = computed<PageItem[]>(() => pageItems(this.page(), this.pageCount()));

  #ipc = inject(IpcService);
  #transloco = inject(TranslocoService);
  #off: Array<() => void> = [];
  #beat: ReturnType<typeof setTimeout> | null = null;
  #pending = false;

  constructor() {
    // Reads every signal the query is built from, so changing a filter
    // reloads without a subscription to wire up by hand.
    effect(() => {
      const id = this.projectId();
      const query = {
        state: this.state(), search: this.search(),
        offset: this.offset(), limit: this.pageSize(),
      };
      if (id !== "") void this.load(id, query);
    });

    // The main process is the one that knows a translation landed. Without
    // this the tab a book is checked with shows "not yet translated" over a
    // book being translated, until the reader thinks to change a filter.
    this.#off.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.projectId()) this.#soon();
    }));
    this.#off.push(this.#ipc.on("run.progress", (progress) => {
      if (progress.projectId === this.projectId()) this.#soon();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
    if (this.#beat !== null) clearTimeout(this.#beat);
  }

  /**
   * A reload now, and no more than one a second after it.
   *
   * A run reports every chunk it finishes, and a query per message would ask
   * the database far oftener than an eye can read the answer. The first
   * message is answered at once — waiting a second to show what already
   * happened is the stall this exists to avoid — and whatever arrives during
   * that second is answered by one reload at its end.
   */
  #soon(): void {
    if (this.#beat !== null) {
      this.#pending = true;
      return;
    }
    void this.refresh();
    this.#beat = setTimeout(() => {
      this.#beat = null;
      if (!this.#pending) return;
      this.#pending = false;
      this.#soon();
    }, 1000);
  }

  /** The page as it stands, asked for again. */
  refresh(): Promise<void> {
    return this.load(this.projectId(), {
      state: this.state(), search: this.search(),
      offset: this.offset(), limit: this.pageSize(),
    });
  }

  async load(
    projectId: string,
    query: { state: string; search: string; offset: number; limit: number },
  ): Promise<void> {
    this.loading.set(true);
    try {
      const page = await this.#ipc.invoke("units.list", {
        projectId,
        ...(query.state === "" ? {} : { state: query.state }),
        ...(query.search === "" ? {} : { search: query.search }),
        limit: query.limit,
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

  /**
   * A page as a number rather than an offset.
   *
   * The store still answers in offsets — it is a database — but a pager that
   * counts in pages is the only one a reader can follow, and the arithmetic
   * belongs on this side of that line.
   */
  goto(page: number): void {
    const wanted = Math.min(Math.max(1, page), this.pageCount());
    this.offset.set((wanted - 1) * this.pageSize());
  }

  /**
   * A new page size keeps the reader where they were, as far as it can: the
   * page that holds the first row now on screen.
   */
  onPageSize(size: number): void {
    const first = this.offset();
    this.pageSize.set(size);
    this.offset.set(Math.floor(first / size) * size);
  }

  /** Which rows of how many, said in the reader's own figures. */
  range(): string {
    const total = this.total();
    if (total === 0) return this.#transloco.translate("list.range", { from: 0, to: 0, total: 0 });
    return this.#transloco.translate("list.range", {
      from: this.count(this.offset() + 1),
      to: this.count(Math.min(this.offset() + this.units().length, total)),
      total: this.count(total),
    });
  }

  /** A count as the reader's language writes it. */
  count(n: number): string {
    return new Intl.NumberFormat(this.#transloco.getActiveLang()).format(n);
  }
}
