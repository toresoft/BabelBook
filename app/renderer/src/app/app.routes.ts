import type { Routes } from "@angular/router";
import { Library } from "./library/library";
import { NewProject } from "./new-project/new-project";

export const routes: Routes = [
  { path: "", component: Library },
  { path: "new", component: NewProject },
  { path: "**", redirectTo: "" },
];
