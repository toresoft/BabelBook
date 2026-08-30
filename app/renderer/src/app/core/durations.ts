import type { TranslocoService } from "@jsverse/transloco";

/**
 * A span of time as the catalogue writes it: the run's own clock, each
 * phase's, and the log's share one voice.
 *
 * Built through the catalogue rather than with the letters `m`/`s` in the
 * code: Italian and English agree on those symbols today, which is not a
 * reason to assume every language will.
 */
export function between(catalogue: TranslocoService, from: string, to: string): string {
  const totalSeconds = Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 1000));
  return spell(catalogue, totalSeconds);
}

/** A number of seconds, spelt the same way `between` spells a span. */
export function spell(catalogue: TranslocoService, totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes === 0) {
    return catalogue.translate("project.duration.seconds", { seconds: totalSeconds });
  }
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return catalogue.translate("project.duration.minutes", { minutes, seconds });
}
