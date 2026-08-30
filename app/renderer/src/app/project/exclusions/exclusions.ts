import {
  ChangeDetectionStrategy, Component, computed, effect, inject, input, OnDestroy, signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { ExclusionGroup } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";
import { Detail } from "../detail";
import { GAP, pageItems, type PageItem } from "../pages";

/** One excluded block, out of the group it was listed under. */
interface Row {
  unitId: string;
  ordinal: number;
  text: string;
  forced: boolean;
  state: string;
  reason: string | null;
  doc: string;
}

/** Block, content, kind, and what can be said about it. */
const COLUMNS = "minmax(0, 0.9fr) minmax(0, 1.7fr) 9rem minmax(0, 13rem)";

const PAGE_SIZES = [10, 20, 30] as const;

/**
 * The exclusions gate: what will not be translated, and why.
 *
 * Grouped by state and reason, because that is how it is read — "forty blocks
 * excluded by the stylesheet" is one question, not forty. A block the user has
 * already ruled on stays listed and marked, so there is somewhere to undo it
 * from.
 */
@Component({
  selector: "bb-exclusions",
  standalone: true,
  imports: [Detail, FormsModule, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./exclusions.html",
  styleUrls: ["../list.css", "./exclusions.css"],
})
export class Exclusions implements OnDestroy {
  readonly projectId = input.required<string>();
  readonly columns = COLUMNS;
  readonly pageSizes = PAGE_SIZES;
  readonly gap = GAP;

  readonly groups = signal<ExclusionGroup[]>([]);
  readonly staged = signal<Record<string, "translate" | "code">>({});
  readonly saving = signal(false);
  readonly failure = signal<string | null>(null);

  readonly total = computed(() =>
    this.groups().reduce((count, group) => count + group.units.length, 0));
  readonly changes = computed(() => Object.keys(this.staged()).length);

  /** The block being read in full, if any. */
  readonly opened = signal<Row | null>(null);
  readonly kind = signal("");
  readonly query = signal("");
  readonly pageSize = signal<number>(20);
  readonly page = signal(1);

  /**
   * The groups, flattened into rows.
   *
   * The screen used to be the grouping itself — "forty blocks excluded by the
   * stylesheet" as one heading. The revised design makes the kind a column and
   * a filter instead, which asks the same question and lets a search cross the
   * groups; the reason still travels with every row, because a verdict cannot
   * be judged without it.
   */
  readonly all = computed<Row[]>(() => this.groups().flatMap((group) =>
    group.units.map((unit) => ({
      unitId: unit.unitId,
      ordinal: unit.ordinal,
      text: unit.text,
      forced: unit.forced,
      state: group.state,
      reason: group.reason,
      doc: group.doc,
    }))));

  /** The kinds present, in the order they first appear: the filter's options. */
  readonly kinds = computed(() => [...new Set(this.all().map((row) => row.state))]);

  readonly visible = computed(() => {
    const kind = this.kind();
    const query = this.query().trim().toLowerCase();
    return this.all().filter((row) => {
      if (kind !== "" && row.state !== kind) return false;
      if (query === "") return true;
      return `${row.text} ${row.doc}`.toLowerCase().includes(query);
    });
  });

  readonly pageCount = computed(() =>
    Math.max(1, Math.ceil(this.visible().length / this.pageSize())));
  readonly rows = computed(() => {
    const from = (Math.min(this.page(), this.pageCount()) - 1) * this.pageSize();
    return this.visible().slice(from, from + this.pageSize());
  });
  readonly pages = computed<PageItem[]>(() => pageItems(this.page(), this.pageCount()));
  readonly narrowed = computed(() => this.kind() !== "" || this.query() !== "");

  #ipc = inject(IpcService);
  #off: Array<() => void> = [];
  #transloco = inject(TranslocoService);

  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id !== "") void this.reload(id);
    });

    // The code index decides these while the gate may already be on screen:
    // without this it shows the blocks the extractor guessed, not the ones the
    // index settled on.
    this.#off.push(this.#ipc.on("project.changed", (changed) => {
      if (changed.id === this.projectId()) void this.reload();
    }));
  }

  ngOnDestroy(): void {
    for (const off of this.#off) off();
  }

  async reload(projectId = this.projectId()): Promise<void> {
    this.groups.set(await this.#ipc.invoke("exclusions.list", { projectId }));
  }

  /** What a row will be once saved: the staged verdict, or what stands now. */
  verdict(unitId: string, current: string): string {
    return this.staged()[unitId] ?? current;
  }

  force(unitId: string, state: "translate" | "code"): void {
    this.staged.update((all) => ({ ...all, [unitId]: state }));
    this.opened.set(null);
  }

  unstage(unitId: string): void {
    this.staged.update(({ [unitId]: _dropped, ...rest }) => rest);
    this.opened.set(null);
  }

  onKind(kind: string): void {
    this.page.set(1);
    this.kind.set(kind);
  }

  onQuery(query: string): void {
    this.page.set(1);
    this.query.set(query);
  }

  goto(page: number): void {
    this.page.set(Math.min(Math.max(1, page), this.pageCount()));
  }

  onPageSize(size: number): void {
    const first = (this.page() - 1) * this.pageSize();
    this.pageSize.set(size);
    this.page.set(Math.floor(first / size) + 1);
  }

  /** Which rows of how many, in the reader's own figures. */
  range(): string {
    const total = this.visible().length;
    const from = total === 0 ? 0 : (Math.min(this.page(), this.pageCount()) - 1) * this.pageSize() + 1;
    return this.#transloco.translate("list.range", {
      from, to: Math.min(from + this.rows().length - 1, total), total,
    });
  }

  async clear(unitId: string): Promise<void> {
    await this.#ipc.invoke("exclusions.clear", {
      projectId: this.projectId(), unitIds: [unitId],
    });
    await this.reload();
  }

  async save(): Promise<void> {
    const changes = Object.entries(this.staged())
      .map(([unitId, state]) => ({ unitId, state }));
    if (changes.length === 0) return;

    this.saving.set(true);
    this.failure.set(null);
    try {
      // One call, like the terms gate: this is a single decision about a
      // screenful, and a half-applied one cannot be told apart from a user
      // who chose exactly those.
      await this.#ipc.invoke("exclusions.force", { projectId: this.projectId(), changes });
      this.staged.set({});
      await this.reload();
    } catch (error) {
      this.failure.set((error as { code?: string }).code ?? "unknown");
    } finally {
      this.saving.set(false);
    }
  }

  /** Unblocks the machine. Saving first: deciding is not committing. */
  async approveGate(): Promise<void> {
    await this.save();
    await this.#ipc.invoke("run.approve", { projectId: this.projectId(), gate: "code" });
  }
}
