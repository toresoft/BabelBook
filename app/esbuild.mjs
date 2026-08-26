/**
 * Bundles the three Node-side entry points of the application.
 *
 * The renderer is built by the Angular CLI; everything that runs outside the
 * window is bundled here, so that `dist/` holds plain JavaScript and Electron
 * never has to resolve TypeScript or workspace packages at runtime.
 */
import { cp } from "node:fs/promises";
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
    // The main process reaches the core, which reaches yauzl-promise, which
    // loads a native .node binding esbuild cannot inline. Everything under
    // node_modules is therefore required at runtime rather than bundled;
    // only our own sources are inlined.
    packages: "external",
  },
  {
    // The preload runs with sandbox: true, and Electron loads a sandboxed
    // preload as CommonJS. An ESM bundle here does not throw: it fails
    // silently, with the window already open and no bridge on it.
    entryPoints: ["preload/preload.ts"],
    outfile: "dist/preload/preload.js",
    format: "cjs",
  },
  {
    // The utility process is a third process boundary: it receives its work
    // and store through a MessagePort, never by opening the main database.
    entryPoints: ["engine/main.ts"],
    outfile: "dist/engine/main.js",
    format: "esm",
    packages: "external",
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

/**
 * The migrations are read from disk at startup, not imported, so the bundler
 * does not see them. Without this copy the packaged app opens a database it has
 * no schema for — and only on a machine where nobody ran the tests.
 */
await cp("main/db/migrations", "dist/main/migrations", { recursive: true });

/**
 * The bundled catalogue snapshot is read the same way. It is the floor the
 * provider list stands on when there is no network and no cache yet; a package
 * without it is an app whose settings screen has nothing to offer.
 */
await cp("catalog", "dist/catalog", { recursive: true });
