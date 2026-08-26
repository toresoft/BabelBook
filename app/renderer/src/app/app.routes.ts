import type { Routes } from "@angular/router";
import { Library } from "./library/library";
import { NewProject } from "./new-project/new-project";
import { Project } from "./project/project";
import { Settings } from "./settings/settings";

export const routes: Routes = [
  { path: "", component: Library },
  { path: "new", component: NewProject },
  // `:id` reaches the component as its `id` input, via withComponentInputBinding.
  { path: "project/:id", component: Project },
  { path: "settings", component: Settings },
  { path: "**", redirectTo: "" },
];
