import {
  ApplicationConfig, inject, provideAppInitializer, provideBrowserGlobalErrorListeners,
} from "@angular/core";
import { provideRouter, withComponentInputBinding } from "@angular/router";
import { TranslocoService } from "@jsverse/transloco";
import { routes } from "./app.routes";
import { provideI18n } from "./core/i18n";
import { IpcService } from "./core/ipc.service";

/**
 * The system's language is the first guess, not the answer.
 *
 * It is what the window renders with while the stored setting is being read:
 * a window that renders raw keys for a moment looks broken, and Italian — or
 * whatever the desktop is set to — is a better placeholder than nothing.
 */
const systemLanguage = (globalThis as { navigator?: { language?: string } })
  .navigator?.language?.split("-")[0] ?? "it";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Route parameters arrive as component inputs, so a screen declares what
    // it needs instead of reaching into ActivatedRoute to find it.
    provideRouter(routes, withComponentInputBinding()),
    ...provideI18n(systemLanguage),
    { provide: IpcService, useFactory: () => new IpcService() },

    // The chosen language is settled before the first render.
    //
    // Without this the setting applies while the window is open and is
    // forgotten at the next start — which is indistinguishable, to the person
    // who set it, from a setting that does nothing.
    provideAppInitializer(async () => {
      const transloco = inject(TranslocoService);
      const ipc = inject(IpcService);
      try {
        const settings = await ipc.invoke("settings.get", undefined);
        if (settings.uiLanguage !== transloco.getActiveLang()) {
          transloco.setActiveLang(settings.uiLanguage);
        }
      } catch {
        // No bridge — a component test, or a preload that failed to load. The
        // system's language stands, which is the best guess available.
      }
    }),
  ],
};
