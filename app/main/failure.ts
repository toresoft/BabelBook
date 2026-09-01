import { BabelError } from "../../core/errors.ts";

/**
 * The one module that reads what `node:fs` and `node:sqlite` threw.
 *
 * Same rule as `classify.ts` on the engine side, for the same reason: an errno
 * means nothing to a reader and everything to the decision about what happens
 * next.
 */

interface Context {
  /** The path being read or written, when the caller knows it. */
  path?: string;
}

const CONFIG: Record<string, string> = {
  ENOSPC: "DISK_FULL",
  EACCES: "PATH_NOT_WRITABLE",
  EPERM: "PATH_NOT_WRITABLE",
  EROFS: "PATH_NOT_WRITABLE",
};

export function classifySystemError(error: unknown, context: Context = {}): BabelError {
  if (error instanceof BabelError) return error;

  const detail: Record<string, string | number | boolean> =
    context.path === undefined ? {} : { path: context.path };
  // A classifier that throws in a catch block replaces the failure it was asked to name.
  const body = typeof error === "object" && error !== null
    ? (error as { code?: unknown; message?: unknown })
    : undefined;
  const errno = typeof body?.code === "string" ? body.code : "";

  if (errno === "ENOENT") {
    return new BabelError("the file is not where it was", {
      code: "SOURCE_MISSING", fault: "input", detail, cause: error,
    });
  }

  const configured = CONFIG[errno];
  if (configured !== undefined) {
    return new BabelError("the machine would not let us write", {
      code: configured, fault: "config", detail: { ...detail, errno }, cause: error,
    });
  }

  // SQLite says this in words rather than in an errno, and it is the one
  // database failure that passes on its own.
  const message = body?.message;
  if (typeof message === "string" && /database is locked|database is busy/i.test(message)) {
    return new BabelError("the database was busy", {
      code: "DATABASE_BUSY", fault: "transient", detail, cause: error,
    });
  }

  return new BabelError("something failed in a way nobody has named", {
    code: "UNKNOWN", fault: "defect", detail, cause: error,
  });
}
