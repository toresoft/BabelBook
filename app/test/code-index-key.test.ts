import { describe, expect, it } from "vitest";
import { CODE_INDEX_VERSION } from "../../core/translate/versions.ts";
import { codeIndexKey } from "../main/run/code-index-key.ts";

/**
 * A key of its own, derived from the run's.
 *
 * The code index is a different piece of work from the translation: it was
 * produced by a different prompt and answers a different question. Putting its
 * version in the shared key would throw away a translated book every time a
 * question about code is corrected — paying twice for something that has not
 * changed.
 */
describe("the code index key", () => {
  it("changes when the run's key changes", () => {
    expect(codeIndexKey("a")).not.toBe(codeIndexKey("b"));
  });

  it("changes when the version changes, and the run's key does not", () => {
    expect(codeIndexKey("a", CODE_INDEX_VERSION)).not.toBe(codeIndexKey("a", CODE_INDEX_VERSION + 1));
  });

  it("is the same key twice for the same inputs", () => {
    expect(codeIndexKey("a")).toBe(codeIndexKey("a"));
  });
});
