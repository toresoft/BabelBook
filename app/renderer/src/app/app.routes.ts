import type { Routes } from "@angular/router";
import { Library } from "./library/library";

export const routes: Routes = [
  { path: "", component: Library },
  { path: "**", redirectTo: "" },
];
