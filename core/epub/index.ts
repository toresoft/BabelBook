/**
 * The EPUB layer's public surface. Plans 2, 3 and 4 import from here and from
 * nowhere else inside `epub/`.
 */
export { EpubError, EpubReadError, EpubWriteError, ScanError } from "../errors.ts";
export { LIMITS, readEpub, sha256, writeEpub } from "./zip.ts";
export type { EpubArchive, ZipEntry } from "./zip.ts";
export { assertUtf8, assertWellFormed, decodeEntities, escapeAttr, escapeText, scan } from "./scan.ts";
export type { ScanAttr, ScanEvent, ScanKind } from "./scan.ts";
export { XHTML_ENTITIES } from "./entities.ts";
export {
  BLOCKS, NAV_BLOCKS, NEVER_TRANSLATED, OPAQUE, TRANSLATABLE_ATTRIBUTES, extract, isWork,
} from "./blocks.ts";
export type {
  ExtractInput, ExtractReport, Placeholder, PlaceholderAttr, TranslationUnit, UnitKind, UnitState,
} from "./blocks.ts";
export { archiveCodeSurfaces } from "./css.ts";
export { buildSkeleton, fillSkeleton, SkeletonError } from "./skeleton.ts";
export type { FillResult, Skeleton } from "./skeleton.ts";
export { render, SpliceError } from "./splice.ts";
export { findPackagePath, readPackage, resolveHref, writeLanguage, writeRootLang } from "./package.ts";
export type { ManifestItem, PackageDoc, SpineItem } from "./package.ts";
export { hasOverlays, removeOverlays } from "./overlay.ts";
export type { OverlayRemoval } from "./overlay.ts";
export { detectLayout } from "./layout.ts";
export type { Layout, LayoutReport } from "./layout.ts";
export { inspect } from "./inspect.ts";
export type { EpubModel, GuideRef, NavEntry } from "./inspect.ts";
export { checkInvariants } from "./invariants.ts";
export type { CheckInput, InvariantResult } from "./invariants.ts";
export { findJar, introducedMessages, runEpubcheck } from "./epubcheck.ts";
export type { EpubcheckMessage, EpubcheckResult } from "./epubcheck.ts";
