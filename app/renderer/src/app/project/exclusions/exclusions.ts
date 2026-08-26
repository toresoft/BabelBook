import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ExclusionGroup } from "../../../../../shared/dto.js";
import { IpcService } from "../../core/ipc.service";

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
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./exclusions.html",
  styleUrl: "./exclusions.css",
})
export class Exclusions {
  readonly projectId = input.required<string>();

  readonly groups = signal<ExclusionGroup[]>([]);
  readonly staged = signal<Record<string, "translate" | "code">>({});
  readonly saving = signal(false);
  readonly failure = signal<string | null>(null);

  readonly total = computed(() =>
    this.groups().reduce((count, group) => count + group.units.length, 0));
  readonly changes = computed(() => Object.keys(this.staged()).length);

  #ipc = inject(IpcService);

  constructor() {
    effect(() => {
      const id = this.projectId();
      if (id !== "") void this.reload(id);
    });
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
  }

  unstage(unitId: string): void {
    this.staged.update(({ [unitId]: _dropped, ...rest }) => rest);
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
