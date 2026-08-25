/**
 * The core never produces a sentence for a reader. An error carries a stable
 * `code`; the interface composes the wording from it, in its own language.
 */
export class EpubError extends Error {
  code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class EpubReadError extends EpubError {}
export class EpubWriteError extends EpubError {}
export class ScanError extends EpubError {}
