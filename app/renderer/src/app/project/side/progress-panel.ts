import { ChangeDetectionStrategy, Component, inject, input } from "@angular/core";
import { TranslocoDirective, TranslocoService } from "@jsverse/transloco";
import type { PhaseProgress } from "../../../../../shared/dto.js";
import { between } from "../../core/durations";

/**
 * The five phases, one per line: what each was, when, and how it ended.
 *
 * Half the side column's template, in a file of its own. Everything it shows
 * is already on the phases it is given — it asks nothing of the main process,
 * and it is wrong nowhere the record is right.
 */
@Component({
  selector: "bb-progress-panel",
  standalone: true,
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./progress-panel.html",
  styleUrl: "./progress-panel.css",
})
export class ProgressPanel {
  readonly phases = input.required<PhaseProgress[]>();

  #transloco = inject(TranslocoService);

  /** How long a finished phase took, in the catalogue's own words. */
  spanOf(entry: PhaseProgress): string | null {
    if (entry.startedAt === null || entry.endedAt === null) return null;
    return between(this.#transloco, entry.startedAt, entry.endedAt);
  }

  /**
   * Why a phase failed: a sentence when the catalogue has one for the code,
   * the bare code when it has not. A raw code on screen beats a blank line,
   * and a sentence invented for a code nobody catalogued is a guess wearing
   * the catalogue's clothes.
   */
  why(entry: PhaseProgress): string | null {
    const code = entry.info?.["code"];
    if (typeof code !== "string") return null;
    const key = `codes.${code}`;
    const sentence = this.#transloco.translate(key);
    return sentence === key ? code : sentence;
  }
}
