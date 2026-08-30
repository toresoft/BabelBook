import { ChangeDetectionStrategy, Component, input, output } from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail } from "../../../../../shared/dto.js";

/**
 * The book, beside the work.
 *
 * What used to be a header above the tabs: it scrolled away with the list and
 * was gone exactly when a long list made it worth having. Here it stays put,
 * whichever tab is open.
 *
 * It asks nothing of the main process: the project arrives already loaded, and
 * the acts are handed back to the screen that owns them.
 */
@Component({
  selector: "bb-side",
  standalone: true,
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./side.html",
  styleUrl: "./side.css",
})
export class Side {
  readonly project = input.required<ProjectDetail>();

  readonly start = output<void>();
  readonly pause = output<void>();
  readonly compose = output<void>();
  readonly remove = output<void>();

  /** True when the machine would accept this event right now. */
  can(action: string): boolean {
    return this.project().actions.includes(action);
  }
}
