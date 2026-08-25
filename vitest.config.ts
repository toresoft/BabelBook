import { defineConfig } from "vitest/config";

/**
 * Worktrees live inside the repository, so a bare path filter such as
 * `vitest run app/test` matches `.claude/worktrees/<agent>/app/test` too and
 * runs another branch's suite alongside this one. Excluding them here keeps
 * the filter meaning what it says.
 */
export default defineConfig({
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", ".worktrees/**", ".angular/**"],
  },
});
