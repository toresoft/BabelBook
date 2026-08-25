import type { TranslationUnit } from "./blocks.ts";
import type { EpubModel } from "./inspect.ts";
import { assertWellFormed, scan } from "./scan.ts";

export interface InvariantResult {
  id: string;
  name: string;
  ok: boolean;
  /** what differs, named. An invariant that only says "failed" costs an investigation. */
  details: string[];
  skipped?: boolean;
}

export interface CheckInput {
  before: EpubModel;
  after: EpubModel;
  units: TranslationUnit[];
  /** units whose range could not be trusted */
  distrusted: number;
  skippedDocs: Array<{ path: string; reason: string }>;
  targetLanguage: string;
  overlaysRemoved: { overlays: number; audio: number } | null;
  /** the empty fill returned the original */
  skeletonIdentity: boolean;
}

const AUDIO_EXTENSIONS = [".mp3", ".m4a", ".m4b", ".aac", ".ogg", ".oga", ".opus", ".wav", ".mp4"];

function hasExtension(path: string, extensions: string[]): boolean {
  const lower = path.toLowerCase();
  return extensions.some((ext) => lower.endsWith(ext));
}

function primarySubtag(tag: string): string {
  return tag.split("-")[0].toLowerCase();
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at + 1);
}

function resolve(from: string, href: string): { path: string; fragment: string } {
  const [target, fragment = ""] = href.split("#");
  if (target === "") return { path: from, fragment };
  const segments = `${directoryOf(from)}${target}`.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "." || segment === "") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return { path: out.join("/"), fragment };
}

function resolves(model: EpubModel, from: string, href: string): boolean {
  const { path, fragment } = resolve(from, href);
  if (!model.resourcePaths.includes(path)) return false;
  if (fragment === "") return true;
  const ids = model.elementIds[path];
  return ids === undefined || ids.includes(fragment);
}

/** Occurrences of each element name in a document, however malformed it is. */
function elementCounts(source: string, path: string): Map<string, number> {
  const counts = new Map<string, number>();
  let events;
  try {
    events = scan(source, path);
  } catch {
    return counts;
  }
  for (const event of events) {
    if (event.kind !== "opentag" || event.name === undefined) continue;
    counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
  }
  return counts;
}

function countsDiffer(before: Map<string, number>, after: Map<string, number>): string[] {
  const details: string[] = [];
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const was = before.get(name) ?? 0;
    const is = after.get(name) ?? 0;
    if (was !== is) details.push(`${name}: ${was} → ${is}`);
  }
  return details;
}

/** A leftover numeric marker means a placeholder never came back as a tag. */
function orphanMarkers(source: string): boolean {
  return /<\/?\d+\/?>/.test(source);
}

function result(id: string, name: string, details: string[]): InvariantResult {
  return { id, name, ok: details.length === 0, details };
}

function skipped(id: string, name: string, why: string): InvariantResult {
  return { id, name, ok: true, details: [why], skipped: true };
}

export function checkInvariants(input: CheckInput): InvariantResult[] {
  const { before, after, units, overlaysRemoved } = input;
  const results: InvariantResult[] = [];

  const removable = (path: string): boolean =>
    overlaysRemoved !== null
    && (path.toLowerCase().endsWith(".smil") || hasExtension(path, AUDIO_EXTENSIONS));

  // I1
  {
    const details: string[] = [];
    const now = new Set(after.resourcePaths);
    for (const path of before.resourcePaths) {
      if (!now.has(path) && !removable(path)) details.push(`gone: ${path}`);
    }
    const was = new Set(before.resourcePaths);
    for (const path of after.resourcePaths) {
      if (!was.has(path)) details.push(`appeared: ${path}`);
    }
    results.push(result("I1", "same set of resources", details));
  }

  // I2
  {
    const details: string[] = [];
    for (const [path, hash] of Object.entries(before.binaryHashes)) {
      const now = after.binaryHashes[path];
      if (now === undefined) continue;
      if (now !== hash) details.push(`changed: ${path}`);
    }
    results.push(result("I2", "binary resources unchanged", details));
  }

  // I3 — the overlay removal is allowed to take its own items out.
  {
    const keep = (line: string): boolean =>
      overlaysRemoved === null
      || !(line.includes("|application/smil+xml|") || line.includes("|audio/"));
    const was = before.manifest.split("\n").filter(keep).join("\n");
    const details = was === after.manifest ? [] : [`manifest differs:\n${was}\n---\n${after.manifest}`];
    results.push(result("I3", "manifest unchanged", details));
  }

  // I4
  results.push(
    result("I4", "spine unchanged", before.spine === after.spine ? [] : ["spine differs"]),
  );

  // I5
  {
    const details: string[] = [];
    for (const [path, ids] of Object.entries(before.elementIds)) {
      const now = after.elementIds[path];
      if (now === undefined) {
        if (!removable(path)) details.push(`document gone: ${path}`);
        continue;
      }
      if (now.join(",") !== ids.join(",")) details.push(`${path}: ${ids.join(",")} → ${now.join(",")}`);
    }
    results.push(result("I5", "element ids unchanged", details));
  }

  // I6 — differential: a book may arrive broken, and blaming the run for a
  // defect that was already there costs hours.
  {
    const details: string[] = [];
    for (const link of before.internalLinks) {
      if (!resolves(before, link.from, link.href)) continue;
      if (!resolves(after, link.from, link.href)) details.push(`${link.from} → ${link.href}`);
    }
    results.push(result("I6", "internal links resolvable", details));
  }

  // I7
  {
    const details: string[] = [];
    if (before.nav.length !== after.nav.length) {
      details.push(`entries: ${before.nav.length} → ${after.nav.length}`);
    } else {
      for (const [i, entry] of before.nav.entries()) {
        const now = after.nav[i];
        if (now.href !== entry.href) details.push(`entry ${i} href: ${entry.href} → ${now.href}`);
        if (now.depth !== entry.depth) details.push(`entry ${i} depth: ${entry.depth} → ${now.depth}`);
        if (entry.label !== "" && now.label === "") details.push(`entry ${i} lost its label`);
      }
    }
    results.push(result("I7", "navigation hierarchy", details));
  }

  // I8
  results.push(
    result(
      "I8",
      "unique identifier unchanged",
      before.uniqueIdentifier === after.uniqueIdentifier
        ? []
        : [`${before.uniqueIdentifier} → ${after.uniqueIdentifier}`],
    ),
  );

  // I9
  results.push(
    result(
      "I9",
      "identity metadata unchanged",
      before.identityMetadata === after.identityMetadata ? [] : ["identifiers, title or creator changed"],
    ),
  );

  // I10
  results.push(
    result(
      "I10",
      "opf:* attributes preserved",
      before.opfAttributes === after.opfAttributes ? [] : ["opf:* attributes differ"],
    ),
  );

  // I11 — an invariant that passes because it had nothing to check lies about
  // the worth of the suite.
  if (before.guide.length === 0) {
    results.push(skipped("I11", "EPUB 2 guide preserved", "the book carries no guide"));
  } else {
    const canonical = (model: EpubModel): string =>
      model.guide.map((g) => `${g.type}|${g.title}|${g.href}`).join("\n");
    results.push(
      result(
        "I11",
        "EPUB 2 guide preserved",
        canonical(before) === canonical(after) ? [] : ["guide differs"],
      ),
    );
  }

  // I12
  {
    const details: string[] = [];
    for (const [path, source] of Object.entries(after.documents)) {
      try {
        assertWellFormed(source, path);
      } catch (cause) {
        details.push(`${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
    results.push(result("I12", "documents reparseable", details));
  }

  // I13
  results.push(
    result("I13", "mimetype conformant", after.mimetypeConformant ? [] : ["mimetype is not first and stored"]),
  );

  // I14
  results.push(
    result(
      "I14",
      "OPF path unchanged",
      before.opfPath === after.opfPath ? [] : [`${before.opfPath} → ${after.opfPath}`],
    ),
  );

  // I15
  results.push(
    result(
      "I15",
      "no discarded units",
      input.distrusted === 0 ? [] : [`${input.distrusted} units had an unreliable range`],
    ),
  );

  // I16
  results.push(
    result(
      "I16",
      "no skipped documents",
      input.skippedDocs.map((d) => `${d.path}: ${d.reason}`),
    ),
  );

  // I17 — the unit ranges are offsets in the document *before*; in the
  // document after, every rewritten unit changed length and moved what
  // follows. The comparison is made on element counts instead, which no
  // rewriting is allowed to change.
  {
    const details: string[] = [];
    const documents = new Set(units.map((u) => u.doc));
    for (const path of documents) {
      const was = before.documents[path];
      const now = after.documents[path];
      if (was === undefined || now === undefined) {
        details.push(`${path} is not in both models`);
        continue;
      }
      for (const line of countsDiffer(elementCounts(was, path), elementCounts(now, path))) {
        details.push(`${path} ${line}`);
      }
      if (orphanMarkers(now)) details.push(`${path} still carries a numeric marker`);
    }
    results.push(result("I17", "placeholders preserved", details));
  }

  // I18
  {
    const details: string[] = [];
    for (const unit of units) {
      const now = after.documents[unit.doc];
      if (now === undefined) continue;
      for (const placeholder of unit.placeholders ?? []) {
        if (!placeholder.opaque) continue;
        const content = placeholder.rawContent ?? "";
        if (content === "") continue;
        // The whole element, not just its text: a bare substring search would
        // still find "ls" after `<code>ls</code>` became `<code>tools</code>`.
        if (!now.includes(`${placeholder.open}${content}${placeholder.close}`)) {
          details.push(`${unit.id} lost the content of placeholder ${placeholder.index}`);
        }
      }
    }
    results.push(result("I18", "opaque content unchanged", details));
  }

  // I19
  {
    const details: string[] = [];
    const target = primarySubtag(input.targetLanguage);
    for (const [path, language] of Object.entries(after.languages)) {
      if (primarySubtag(language) !== target) details.push(`${path}: ${language}`);
    }
    results.push(result("I19", "language consistent", details));
  }

  // I20
  {
    const details: string[] = [];
    for (const unit of units) {
      const source = before.documents[unit.doc];
      if (source === undefined) {
        details.push(`${unit.id} names a document the book does not have`);
        continue;
      }
      if (source.slice(unit.range[0], unit.range[1]) !== unit.raw) {
        details.push(`${unit.id} does not describe its document`);
      }
    }
    results.push(result("I20", "unit coverage", details));
  }

  // I21
  results.push(
    result(
      "I21",
      "skeleton round-trips",
      input.skeletonIdentity ? [] : ["an empty fill did not return the original"],
    ),
  );

  // I22 — a half-done removal is worse than none: EPUBCheck refuses a
  // media-overlay pointing at an item that is not there, and an orphaned
  // media:duration raises MED-016.
  {
    const details: string[] = [];
    if (after.overlays.smil.length > 0) details.push(`${after.overlays.smil.length} smil files remain`);
    if (after.overlays.mediaAttributes > 0) {
      details.push(`${after.overlays.mediaAttributes} media-overlay attributes remain`);
    }
    if (after.overlays.mediaMetadata > 0) {
      details.push(`${after.overlays.mediaMetadata} media:* metadata remain`);
    }
    if (overlaysRemoved !== null) {
      if (overlaysRemoved.overlays !== before.overlays.smil.length) {
        details.push(`claimed ${overlaysRemoved.overlays} overlays, found ${before.overlays.smil.length}`);
      }
      const audioBefore = before.resourcePaths.filter((p) => hasExtension(p, AUDIO_EXTENSIONS));
      const audioAfter = after.resourcePaths.filter((p) => hasExtension(p, AUDIO_EXTENSIONS));
      const gone = audioBefore.length - audioAfter.length;
      if (overlaysRemoved.audio !== gone) {
        details.push(`claimed ${overlaysRemoved.audio} audio files, ${gone} disappeared`);
      }
    }
    results.push(result("I22", "overlays removed whole", details));
  }

  return results;
}
