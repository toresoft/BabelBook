import type { Routes } from "@angular/router";
import { Library } from "./library/library";
import { NewProject } from "./new-project/new-project";
import { Project } from "./project/project";
import { Providers } from "./settings/providers";

export const routes: Routes = [
  { path: "", component: Library },
  { path: "new", component: NewProject },
  // `:id` reaches the component as its `id` input, via withComponentInputBinding.
  { path: "project/:id", component: Project },
  // The providers screen is the whole of settings for now; plan 5 adds the
  // glossaries, translation and application sections beside it.
  { path: "settings", component: Providers },
  { path: "**", redirectTo: "" },
];
