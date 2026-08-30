import { ChangeDetectionStrategy, Component, HostListener, input, output } from "@angular/core";
import { TranslocoDirective } from "@jsverse/transloco";

/**
 * A row, opened.
 *
 * The tables cut long text to two or three lines — that is what makes a list a
 * list — and this is where the whole of it is read, with everything else the
 * row knows and everything that can be done about it.
 *
 * One dialog for the three tabs rather than three: a block, a term and a unit
 * are opened the same way, closed by the same key, and a reader who learns it
 * once has learned it everywhere.
 */
@Component({
  selector: "bb-detail",
  standalone: true,
  imports: [TranslocoDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./detail.html",
  styleUrl: "./detail.css",
})
export class Detail {
  readonly title = input.required<string>();
  readonly subtitle = input<string>("");
  readonly closed = output<void>();

  /**
   * Escape closes it, wherever the focus happens to be.
   *
   * The dialog is rendered only while it is open, so the listener exists only
   * then; a `keydown` on the dialog itself would need the focus to be inside
   * it, which it is not when the row that opened it still holds it.
   */
  @HostListener("document:keydown.escape")
  onEscape(): void {
    this.closed.emit();
  }
}
