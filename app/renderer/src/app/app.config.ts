import { ApplicationConfig, provideBrowserGlobalErrorListeners } from "@angular/core";
import { provideRouter } from "@angular/router";
import { routes } from "./app.routes";
import { provideI18n } from "./core/i18n";
import { IpcService } from "./core/ipc.service";

/**
 * The interface language comes from the main process, which knows both the
 * user's setting and the system locale. Until it answers, Italian stands: a
 * window that renders raw keys while it waits looks broken.
 */
const initialLanguage = (globalThis as { navigator?: { language?: string } })
  .navigator?.language?.split("-")[0] ?? "it";

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideRouter(routes),
    ...provideI18n(initialLanguage),
    { provide: IpcService, useFactory: () => new IpcService() },
  ],
};
