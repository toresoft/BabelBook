/**
 * `yauzl-promise` ships no types. Only the surface this project uses is
 * declared here, and it is declared against the source rather than the README:
 * the exported validator is `validateFilename`, not `validateFileName`, and
 * `open()` accepts a path only — a Buffer goes through `fromBuffer()`.
 */
declare module "yauzl-promise" {
  import type { Readable } from "node:stream";

  export interface ZipOptions {
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    validateFilenames?: boolean;
    strictFilenames?: boolean;
    supportMacArchive?: boolean;
  }

  export class Entry {
    filename: string;
    uncompressedSize: number;
    compressedSize: number;
    compressionMethod: number;
    openReadStream(): Promise<Readable>;
  }

  export class Zip {
    close(): Promise<void>;
    readEntry(): Promise<Entry | null>;
    [Symbol.asyncIterator](): AsyncIterableIterator<Entry>;
  }

  export function open(path: string, options?: ZipOptions): Promise<Zip>;
  export function fromBuffer(buffer: Buffer, options?: ZipOptions): Promise<Zip>;
  export function validateFilename(filename: string): void;
}
