/**
 * Bundles the two Node-side entry points of the application.
 *
 * The renderer is built by the Angular CLI; everything that runs outside the
 * window is bundled here, so that `dist/` holds plain JavaScript and Electron
 * never has to resolve TypeScript or workspace packages at runtime.
 */
import { build } from "esbuild";

/** Electron ships its own copy; bundling it would produce a second, broken one. */
const EXTERNAL = ["electron"];

/** Electron 43 embeds Node 24. */
const TARGET = "node24";

const bundles = [
  {
    // The main process is loaded through package.json "main", and this package
    // is "type": "module", so the main bundle must be ESM.
    entryPoints: ["main/main.ts"],
    outfile: "dist/main/main.js",
    format: "esm",
  },
  {
    // The preload runs with sandbox: true, and Electron loads a sandboxed
    // preload as CommonJS. An ESM bundle here does not throw: it fails
    // silently, with the window already open and no bridge on it.
    entryPoints: ["preload/preload.ts"],
    outfile: "dist/preload/preload.js",
    format: "cjs",
  },
];

await Promise.all(
  bundles.map((bundle) =>
    build({
      ...bundle,
      bundle: true,
      platform: "node",
      target: TARGET,
      external: EXTERNAL,
      sourcemap: true,
      logLevel: "info",
    }),
  ),
);
