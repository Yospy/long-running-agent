import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default excludes (node_modules, dist, .git, etc.) plus runs/** — an agent run's own
    // workspace can contain its own test files (a different runner, e.g. Jest), which must never
    // be picked up by the harness's own `npm test`.
    exclude: ["**/node_modules/**", "**/dist/**", "**/.git/**", "runs/**"],
  },
});
