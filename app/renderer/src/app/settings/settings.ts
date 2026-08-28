import { ChangeDetectionStrategy, Component, computed, input } from "@angular/core";
import { RouterLink } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import { Glossaries } from "./glossaries";
import { Preferences } from "./preferences";
import { Providers } from "./providers";

const SECTIONS = ["providers", "glossaries", "translation", "application"] as const;
type Section = (typeof SECTIONS)[number];

const isSection = (value: string): value is Section =>
  (SECTIONS as readonly string[]).includes(value);

/**
 * The four sections of the settings, behind one door.
 *
 * Each section owns its own state and its own channels; this component only
 * decides which one is on screen. Loading all four at once would ask the main
 * process four questions to answer one.
 */
@Component({
  selector: "bb-settings",
  standalone: true,
  imports: [RouterLink, TranslocoDirective, Providers, Glossaries, Preferences],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: "./settings.html",
  styleUrl: "./settings.css",
})
export class Settings {
  readonly section = input<string>("providers");

  /**
   * The section the URL names, or the one a new installation starts from.
   *
   * A URL may name anything; the panels are four, and a bogus parameter would
   * otherwise open on an empty screen that no column entry stands for.
   */
  readonly active = computed((): Section => {
    const section = this.section();
    return isSection(section) ? section : "providers";
  });
}
