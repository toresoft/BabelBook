import type { PackageDoc } from "./package.ts";
import { scan } from "./scan.ts";

export type Layout = "reflowable" | "pre-paginated";

export interface LayoutReport {
  book: Layout | "mixed";
  /** archive path of the document → the layout that applies to it */
  byDocument: Record<string, Layout>;
  prePaginated: number;
}

function directoryOf(path: string): string {
  const at = path.lastIndexOf("/");
  return at === -1 ? "" : path.slice(0, at + 1);
}

/** The package-level default, `reflowable` when nothing declares one. */
function packageLayout(pkg: PackageDoc): Layout {
  const events = scan(pkg.source, pkg.path);
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i];
    if (event.kind !== "opentag" || event.name !== "meta") continue;
    if (event.attrs?.find((a) => a.name === "property")?.value !== "rendition:layout") continue;
    if (event.attrs?.some((a) => a.name === "refines")) continue;
    const next = events[i + 1];
    if (next && next.kind === "text" && next.text?.trim() === "pre-paginated") return "pre-paginated";
  }
  return "reflowable";
}

/**
 * `rendition:layout` is declared at two levels, and both have to be read: the
 * `<meta>` in the package, and the per-`<itemref>` override carried by
 * `properties`. A book can mix reflowable chapters with pre-paginated plates.
 *
 * Detection does not solve anything — translation lengthens text by 15% to 35%
 * towards the romance and germanic languages, and where the text is absolutely
 * positioned inside a fixed-pixel viewport the longer sentence leaves its box.
 * No automatic check sees that: EPUBCheck does not render, and overflow is not
 * a violation of the specification. This makes the problem sayable, so the
 * interface can warn before the user spends.
 */
export function detectLayout(pkg: PackageDoc): LayoutReport {
  const fallback = packageLayout(pkg);
  const byId = new Map(pkg.manifest.map((item) => [item.id, item]));
  const dir = directoryOf(pkg.path);

  const byDocument: Record<string, Layout> = {};
  let prePaginated = 0;
  let reflowable = 0;

  for (const item of pkg.spine) {
    const manifest = byId.get(item.idref);
    if (!manifest) continue;

    const properties = item.properties ?? "";
    const layout: Layout = properties.includes("rendition:layout-pre-paginated")
      ? "pre-paginated"
      : properties.includes("rendition:layout-reflowable")
        ? "reflowable"
        : fallback;

    byDocument[`${dir}${manifest.href}`] = layout;
    if (layout === "pre-paginated") prePaginated += 1;
    else reflowable += 1;
  }

  const book: Layout | "mixed" =
    prePaginated > 0 && reflowable > 0 ? "mixed" : prePaginated > 0 ? "pre-paginated" : "reflowable";

  return { book, byDocument, prePaginated };
}
