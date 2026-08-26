# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: packaged.spec.ts >> the package opens, migrates its database and reads a book
- Location: app/e2e/packaged.spec.ts:25:1

# Error details

```
TimeoutError: electronApplication.waitForEvent: Timeout 30000ms exceeded while waiting for event "window"
```

# Test source

```ts
  1  | import type { ElectronApplication, Page } from "@playwright/test";
  2  | 
  3  | /**
  4  |  * The application's window, which is no longer the first one opened.
  5  |  *
  6  |  * The splash is raised before anything slow happens, so it wins the race that
  7  |  * `firstWindow()` resolves. Asking for the first window therefore hands back a
  8  |  * frameless box with no bridge on it, and every assertion that follows fails
  9  |  * for a reason that has nothing to do with what was being tested.
  10 |  *
  11 |  * The two are told apart by what they load: the splash is a `data:` URL, the
  12 |  * application a registered `app://` origin — or the dev server, when one is
  13 |  * running.
  14 |  */
  15 | export async function mainWindow(app: ElectronApplication): Promise<Page> {
  16 |   const isApplication = (page: Page): boolean => !page.url().startsWith("data:");
  17 | 
  18 |   for (const open of app.windows()) {
  19 |     if (isApplication(open)) return open;
  20 |   }
> 21 |   return app.waitForEvent("window", { predicate: isApplication });
     |              ^ TimeoutError: electronApplication.waitForEvent: Timeout 30000ms exceeded while waiting for event "window"
  22 | }
  23 | 
```