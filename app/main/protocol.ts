import { existsSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { net, protocol } from "electron";

/**
 * The renderer is not served from file://.
 *
 * Under file:// the Angular router, relative requests and any Content Security
 * Policy worth writing all misbehave in ways that read as bugs in the
 * application. A registered standard scheme gives the window a real origin.
 */
export const RENDERER_SCHEME = "app";
export const RENDERER_HOST = "bundle";
export const RENDERER_ORIGIN = `${RENDERER_SCHEME}://${RENDERER_HOST}`;

/**
 * Covers are served from a second host on the same scheme.
 *
 * The window cannot read files, and a cover is the one project artefact it has
 * to show. A separate host keeps them out of the renderer's own tree, so a
 * book called `index.html` cannot shadow the application.
 */
export const COVER_HOST = "cover";

export function coverUrl(projectId: string, file: string): string {
  return `${RENDERER_SCHEME}://${COVER_HOST}/${encodeURIComponent(projectId)}/${encodeURIComponent(file)}`;
}

/** Must run before the app is ready, or the privileges are ignored. */
export function registerRendererScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: RENDERER_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Resolves a request path inside `root`, or null when it escapes it.
 *
 * A URL can say `../../..`; a handler that joins without checking hands the
 * window the whole disk.
 */
export function resolveWithinRoot(root: string, pathname: string): string | null {
  const target = normalize(join(root, decodeURIComponent(pathname)));
  if (target !== root && !target.startsWith(root + sep)) return null;
  return target;
}

/** Serves the built renderer over the app:// scheme. Call once, after ready. */
export function handleRendererProtocol(rendererRoot: string, projectsRoot?: string): void {
  const indexPath = join(rendererRoot, "index.html");

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const { host, pathname } = new URL(request.url);

    if (host === COVER_HOST) {
      if (projectsRoot === undefined) return new Response("Not found", { status: 404 });
      const cover = resolveWithinRoot(projectsRoot, pathname);
      if (cover === null || !existsSync(cover)) return new Response("Not found", { status: 404 });
      return net.fetch(pathToFileURL(cover).toString());
    }

    const resolved = resolveWithinRoot(rendererRoot, pathname === "/" ? "/index.html" : pathname);
    if (resolved === null) return new Response("Forbidden", { status: 403 });

    // A path with no extension is a router URL, not a missing asset: the
    // single page answers for it, and the router reads it from the location.
    const target = existsSync(resolved) ? resolved : extname(resolved) === "" ? indexPath : resolved;
    return net.fetch(pathToFileURL(target).toString());
  });
}
