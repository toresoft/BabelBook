import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { isCatalog, pruneCatalog, type Catalog, type CatalogProvider } from "./shape.ts";

export const CATALOG_URL = "https://models.dev/api.json";

/**
 * How long the catalogue is waited for.
 *
 * A server that refuses a connection fails at once; one that accepts it and
 * then says nothing would otherwise hold the button that asked — the refresh
 * is awaited by the interface — until undici's own default gave up, minutes
 * later. Long enough for four megabytes on a slow line, short enough that a
 * silent server is an answer rather than a wait.
 */
const CATALOG_TIMEOUT_MS = 30_000;

export interface CatalogPaths {
  /** The snapshot shipped inside the package. */
  bundled: string;
  /** Where refreshes land, inside the user's data directory. */
  cache: string;
}

export interface LoadedCatalog {
  catalog: Catalog;
  /**
   * True when serving the snapshot shipped with the package rather than
   * anything downloaded since. The state line shows it, because "bundled" is
   * the honest answer to how old these prices are.
   */
  bundled: boolean;
  /**
   * True when a refresh was attempted and could not confirm the data current.
   * Offline is the normal case, not an error: the catalogue answers anyway and
   * this flag says by how much to trust its dates.
   */
  stale: boolean;
  /** True only when new data was written: the one fact a caller acts on. */
  changed: boolean;
  /**
   * When the network last confirmed this catalogue current, or null when it
   * never has.
   *
   * A different fact from `at`, and the one that answers the question a date
   * alone answers wrongly: a catalogue produced three weeks ago and confirmed
   * unchanged two minutes ago is current, and reads as stale without this.
   */
  checkedAt: string | null;
}

export interface RefreshDeps {
  /** The network call, injected so no test reaches it. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Refused rather than installed: a file that is not a catalogue. */
export class CatalogError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "CatalogError";
    this.code = code;
  }
}

/**
 * A cache file: a catalogue, the ETag that produced it, and where it came
 * from. An import is a user's choice and outranks the bundled snapshot even
 * when older; a download is only fresher data, and must prove it.
 */
interface CacheFile extends Catalog {
  etag: string | null;
  origin: "download" | "import";
}

/**
 * A snapshot file is read the same way whichever side of the package boundary
 * it came from: gzipped JSON that must be a catalogue, or it is not read.
 */
async function readSnapshot(path: string): Promise<CacheFile | null> {
  let text: string;
  try {
    text = gunzipSync(await readFile(path)).toString("utf8");
  } catch {
    // A missing or unreadable file is the caller's ordinary situation — the
    // first start has no cache, a torn download is not supposed to exist — and
    // is answered with null rather than with a crash.
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isCatalog(parsed)) return null;

  const candidate = parsed as CacheFile;
  return {
    ...candidate,
    etag: typeof candidate.etag === "string" ? candidate.etag : null,
    origin: candidate.origin === "import" ? "import" : "download",
  };
}

/**
 * What the application serves: the newer of the cache and the bundled snapshot.
 *
 * The comparison is by production date, not file time: a cache downloaded last
 * week is older than a snapshot shipped in this morning's update, and after an
 * update the bundled file is the fresher copy on disk. One cache beats that
 * rule — an import, which a user chose on purpose and which therefore wins
 * whatever its age, with the date line left to declare how old it is.
 */
export async function readCatalog(paths: CatalogPaths): Promise<LoadedCatalog> {
  const bundledSnapshot = await readSnapshot(paths.bundled);
  if (bundledSnapshot === null) {
    // The snapshot is part of the package, next to the code that reads it; a
    // package without it is a build defect, and pretending otherwise would
    // start an app whose provider list is a mystery to its own settings screen.
    throw new Error(`no bundled catalogue at ${paths.bundled}`);
  }

  const cache = await readSnapshot(paths.cache);
  const checkedAt = await readChecked(paths.cache);
  const cacheWins = cache !== null
    && (cache.origin === "import" || Date.parse(cache.at) > Date.parse(bundledSnapshot.at));
  if (cacheWins) {
    return { catalog: cache!, bundled: false, stale: false, changed: false, checkedAt };
  }
  return { catalog: bundledSnapshot, bundled: true, stale: false, changed: false, checkedAt };
}

/**
 * Writes the cache whole or not at all: a temporary file, then a rename.
 *
 * An update interrupted between the two leaves a complete old catalogue and a
 * stray temporary file, which is fine; one interrupted mid-write would leave a
 * truncated catalogue, which is worse than an old one because it looks current.
 */
/** Beside the catalogue, not inside it: a 304 must not rewrite four megabytes. */
function checkedPath(cachePath: string): string {
  return `${cachePath}.checked`;
}

async function readChecked(cachePath: string): Promise<string | null> {
  try {
    const at = (await readFile(checkedPath(cachePath), "utf8")).trim();
    return Number.isNaN(Date.parse(at)) ? null : at;
  } catch {
    return null;
  }
}

async function writeChecked(cachePath: string, at: string): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(checkedPath(cachePath), at, "utf8");
}

async function writeCache(path: string, cache: CacheFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, gzipSync(Buffer.from(JSON.stringify(cache), "utf8")));
  await rename(temp, path);
}

/**
 * Asks the network for a newer catalogue, in the background and never on the
 * critical path of anything.
 *
 * The rule throughout is that a failed refresh is not an error to show: the
 * catalogue that already works keeps answering, flagged `stale`. The three
 * ways this can go wrong — offline, an answer that is not a catalogue, a
 * server that is having a bad day — all land in that one place.
 */
export async function refreshCatalog(
  paths: CatalogPaths,
  deps: RefreshDeps = {},
): Promise<LoadedCatalog> {
  const current = await readCatalog(paths);
  const headers: Record<string, string> = {};
  if (!current.bundled) {
    const cache = await readSnapshot(paths.cache);
    if (cache?.etag != null) headers["if-none-match"] = cache.etag;
  }

  const fetcher = deps.fetch ?? fetch;
  let response: Response;
  try {
    response = await fetcher(CATALOG_URL, {
      headers,
      // A timeout, like the endpoint probes next door: giving up is one of the
      // ways this can go wrong, and they all land in `stale`.
      signal: AbortSignal.timeout(deps.timeoutMs ?? CATALOG_TIMEOUT_MS),
    });
  } catch {
    return { ...current, stale: true, changed: false };
  }

  if (response.status === 304) {
    // Nothing newer exists; the cache stays exactly as it is, and the moment
    // of the check is noted beside it rather than inside it.
    const checkedAt = new Date().toISOString();
    await writeChecked(paths.cache, checkedAt);
    return { ...current, stale: false, changed: false, checkedAt };
  }
  if (!response.ok) return { ...current, stale: true, changed: false };

  let providers: CatalogProvider[];
  try {
    providers = pruneCatalog(JSON.parse(await response.text()));
  } catch {
    return { ...current, stale: true, changed: false };
  }
  // A prune that kept nothing is not a catalogue: an empty object, an error
  // page that happened to parse, a shape change upstream. Serving it would
  // empty the provider list, so it is refused like any other bad answer.
  if (providers.length === 0) return { ...current, stale: true, changed: false };

  const at = new Date().toISOString();
  await writeCache(paths.cache, {
    at, etag: response.headers.get("etag"), providers, origin: "download",
  });
  await writeChecked(paths.cache, at);
  return { catalog: { at, providers }, bundled: false, stale: false, changed: true, checkedAt: at };
}

/**
 * Reads a file chosen by the user as a catalogue.
 *
 * Two shapes are accepted: the pruned snapshot this application writes, which
 * carries its own date, and the raw api.json that a machine with a network
 * hands out — pruned here, and dated by the import, because a file with no
 * date has only the moment it was chosen. A gzipped file is accepted as bytes
 * (utf8-reading it first would mangle it); anything else is refused with a
 * code, and what already worked stays where it is.
 */
export function parseImportedCatalog(
  file: Buffer | string,
  now: () => Date = () => new Date(),
): Catalog {
  let text: string;
  if (typeof file !== "string" && file[0] === 0x1f && file[1] === 0x8b) {
    try {
      text = gunzipSync(file).toString("utf8");
    } catch {
      throw new CatalogError("BAD_CATALOG", "the file is not a catalogue");
    }
  } else {
    text = typeof file === "string" ? file : file.toString("utf8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CatalogError("BAD_CATALOG", "the file is not a catalogue");
  }

  if (isCatalog(parsed)) return parsed;

  const pruned = pruneCatalog(parsed);
  if (pruned.length > 0) return { at: now().toISOString(), providers: pruned };

  throw new CatalogError("BAD_CATALOG", "the file is not a catalogue");
}

/**
 * Installs a catalogue the user chose, atomically, as an import.
 *
 * An import wins over the bundled snapshot whatever its age — it is a choice,
 * not fresh data — so the next start serves it, and the state line is where
 * its age is declared.
 */
export async function installCatalog(paths: CatalogPaths, catalog: Catalog): Promise<void> {
  await writeCache(paths.cache, { ...catalog, etag: null, origin: "import" });
}
