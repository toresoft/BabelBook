/**
 * Regenerates the bundled catalogue snapshot.
 *
 * A script rather than a committed binary alone, for the same reason as the
 * icons: the snapshot is 158 KB of somebody else's data, and a file that
 * nobody can see the making of is a file nobody can answer for. The pruning
 * lives in `main/catalog/shape.ts` and is imported, not duplicated — the shape
 * the script writes is the shape the application reads, by construction.
 *
 * Run it when a release wants fresher prices:
 *
 *     node app/scripts/fetch-catalog.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { pruneCatalog } from "../main/catalog/shape.ts";

const URL = "https://models.dev/api.json";
const OUT_DIR = join(import.meta.dirname, "..", "catalog");

const response = await fetch(URL, { signal: AbortSignal.timeout(60_000) });
if (!response.ok) {
  console.error(`models.dev answered ${response.status}; nothing was written`);
  process.exit(1);
}

const raw = await response.json();
const providers = pruneCatalog(raw);
const models = providers.reduce((total, provider) => total + provider.models.length, 0);
if (providers.length === 0 || models === 0) {
  // A prune that kept nothing means the shape changed upstream or the answer
  // was not the catalogue: writing it would ship an app with no providers.
  console.error("the answer pruned to nothing; nothing was written");
  process.exit(1);
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(
  join(OUT_DIR, "snapshot.json.gz"),
  gzipSync(Buffer.from(JSON.stringify({ at: new Date().toISOString(), providers }), "utf8")),
);

console.log(`catalogue written to app/catalog: ${providers.length} providers, ${models} models`);
