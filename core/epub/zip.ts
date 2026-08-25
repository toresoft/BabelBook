import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fromBuffer, validateFilename } from "yauzl-promise";
import { ZipFile } from "yazl";
import { EpubReadError, EpubWriteError } from "./errors.ts";

export const MIMETYPE_PATH = "mimetype";
export const MIMETYPE_BYTES = "application/epub+zip";

/**
 * A book is a few hundred entries and a few dozen megabytes. Anything past
 * these numbers is either a mistake or an attack, and either way we stop
 * before allocating.
 */
export const LIMITS = {
  maxEntries: 5_000,
  maxEntryBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
};

export interface ZipEntry {
  path: string;
  bytes: Buffer;
  compress: boolean;
}

export interface EpubArchive {
  entries: ZipEntry[];
  order: string[];
  get(path: string): Buffer | undefined;
  sha256: string;
}

export function sha256(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

function isUnsafeName(name: string): boolean {
  try {
    validateFilename(name);
    return false;
  } catch {
    return true;
  }
}

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer));
  }
  return Buffer.concat(chunks);
}

export async function readEpub(input: string | Buffer): Promise<EpubArchive> {
  const archive = typeof input === "string" ? await readFile(input) : input;

  // Filename validation is ours, not the library's: it has to become an
  // `EpubReadError` with a code the interface can speak about.
  const zip = await fromBuffer(archive, { validateFilenames: false });
  const entries: ZipEntry[] = [];
  let total = 0;

  try {
    for await (const entry of zip) {
      const path = entry.filename;

      if (isUnsafeName(path)) {
        throw new EpubReadError(`entry name escapes the archive: ${path}`, "UNSAFE_ENTRY_NAME");
      }
      if (entries.length + 1 > LIMITS.maxEntries) {
        throw new EpubReadError(`archive holds more than ${LIMITS.maxEntries} entries`, "TOO_MANY_ENTRIES");
      }
      if (entry.uncompressedSize > LIMITS.maxEntryBytes) {
        throw new EpubReadError(`entry is larger than ${LIMITS.maxEntryBytes} bytes: ${path}`, "ENTRY_TOO_LARGE");
      }
      total += entry.uncompressedSize;
      if (total > LIMITS.maxTotalBytes) {
        throw new EpubReadError(`archive expands past ${LIMITS.maxTotalBytes} bytes`, "ARCHIVE_TOO_LARGE");
      }
      if (
        entry.compressedSize > 0
        && entry.uncompressedSize / entry.compressedSize > LIMITS.maxCompressionRatio
      ) {
        throw new EpubReadError(
          `entry expands more than ${LIMITS.maxCompressionRatio} times: ${path}`,
          "SUSPICIOUS_COMPRESSION_RATIO",
        );
      }

      // A directory entry carries no bytes and nothing downstream can use it.
      if (path.endsWith("/")) continue;

      const bytes = await streamToBuffer(await entry.openReadStream());
      entries.push({ path, bytes, compress: path !== MIMETYPE_PATH });
    }
  } finally {
    await zip.close();
  }

  const byPath = new Map(entries.map((e) => [e.path, e.bytes]));
  return {
    entries,
    order: entries.map((e) => e.path),
    get: (path: string) => byPath.get(path),
    sha256: sha256(archive),
  };
}

export interface WriteOptions {
  /**
   * Default true. False writes the entries exactly as given, correcting
   * nothing — the only way to produce an archive that breaks the packaging
   * invariants, which the sabotages need. A writer that always corrects makes
   * the invariant that should catch the defect unreachable.
   */
  conformant?: boolean;
}

/** Fixed, so the same entries always produce the same archive. */
const MTIME = new Date("2026-01-01T00:00:00Z");

export async function writeEpub(entries: ZipEntry[], opts?: WriteOptions): Promise<Buffer> {
  const conformant = opts?.conformant !== false;

  let ordered = entries;
  if (conformant) {
    const mimetype = entries.find((e) => e.path === MIMETYPE_PATH) ?? {
      path: MIMETYPE_PATH,
      bytes: Buffer.from(MIMETYPE_BYTES, "utf8"),
      compress: false,
    };
    ordered = [
      { ...mimetype, compress: false },
      ...entries.filter((e) => e.path !== MIMETYPE_PATH),
    ];
  }

  const zip = new ZipFile();
  try {
    for (const entry of ordered) {
      zip.addBuffer(entry.bytes, entry.path, { compress: entry.compress, mtime: MTIME });
    }
    zip.end();
  } catch (cause) {
    throw new EpubWriteError(`cannot write the archive: ${String(cause)}`, "UNWRITABLE_ARCHIVE");
  }

  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
