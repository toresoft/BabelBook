import { Injectable, type Provider } from "@angular/core";
import { provideTransloco, Translation, TranslocoLoader } from "@jsverse/transloco";
import en from "../../../../locales/en.json";
import it from "../../../../locales/it.json";

export const AVAILABLE_LANGUAGES = ["it", "en"] as const;

const CATALOGUES: Record<string, Translation> = { it, en };

/**
 * The catalogues are bundled, not fetched.
 *
 * Transloco's default loader asks over HTTP, which in a desktop window means a
 * request against the app:// origin that can fail after the window is already
 * open — an interface that renders raw keys and no error. Importing the JSON
 * makes a missing catalogue a build failure instead.
 */
@Injectable({ providedIn: "root" })
export class BundledTranslocoLoader implements TranslocoLoader {
  getTranslation(language: string): Promise<Translation> {
    return Promise.resolve(CATALOGUES[language] ?? CATALOGUES["it"]!);
  }
}

export function provideI18n(initial: string): Provider[] {
  return [
    provideTransloco({
      config: {
        availableLangs: [...AVAILABLE_LANGUAGES],
        defaultLang: AVAILABLE_LANGUAGES.includes(initial as "it" | "en") ? initial : "it",
        fallbackLang: "en",
        reRenderOnLangChange: true,
        prodMode: true,
      },
      loader: BundledTranslocoLoader,
    }),
  ];
}
