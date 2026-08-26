import { ChangeDetectionStrategy, Component, signal } from "@angular/core";
import { RouterLink } from "@angular/router";
import { TranslocoDirective } from "@jsverse/transloco";
import { Glossaries } from "./glossaries";
import { Preferences } from "./preferences";
import { Providers } from "./providers";

const SECTIONS = ["providers", "glossaries", "translation", "application"] as const;
type Section = (typeof SECTIONS)[number];

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
  readonly sections = SECTIONS;
  readonly section = signal<Section>("providers");

  show(section: Section): void {
    this.section.set(section);
  }
}
