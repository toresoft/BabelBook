import { ChangeDetectionStrategy, Component, input, output, signal } from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";
import type { ProjectDetail } from "../../../../../shared/dto.js";
import { Detail } from "../detail";

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
  imports: [Detail, TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./side.html",
  styleUrls: ["../list.css", "./side.css"],
})
export class Side {
  readonly project = input.required<ProjectDetail>();

  readonly start = output<void>();
  readonly pause = output<void>();
  readonly compose = output<void>();
  readonly remove = output<void>();

  /** Whether the description dialog is open; the description itself stays on `project()`. */
  readonly descriptionOpen = signal(false);

  /** True when the machine would accept this event right now. */
  can(action: string): boolean {
    return this.project().actions.includes(action);
  }
}
