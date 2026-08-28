import type { Routes } from "@angular/router";
import { Library } from "./library/library";
import { NewProject } from "./new-project/new-project";
import { Project } from "./project/project";
import { Settings } from "./settings/settings";

export const routes: Routes = [
  { path: "", pathMatch: "full", redirectTo: "projects/all" },
  // `:bucket` and `:section` reach the components as inputs, via
  // withComponentInputBinding — the same way `:id` already does.
  { path: "projects/:bucket", component: Library },
  { path: "new", component: NewProject },
  { path: "project/:id", component: Project },
  { path: "settings/:section", component: Settings },
  { path: "settings", pathMatch: "full", redirectTo: "settings/providers" },
  { path: "**", redirectTo: "projects/all" },
];
