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
export function handleRendererProtocol(rendererRoot: string): void {
  const indexPath = join(rendererRoot, "index.html");

  protocol.handle(RENDERER_SCHEME, async (request) => {
    const { pathname } = new URL(request.url);
    const resolved = resolveWithinRoot(rendererRoot, pathname === "/" ? "/index.html" : pathname);
    if (resolved === null) return new Response("Forbidden", { status: 403 });

    // A path with no extension is a router URL, not a missing asset: the
    // single page answers for it, and the router reads it from the location.
    const target = existsSync(resolved) ? resolved : extname(resolved) === "" ? indexPath : resolved;
    return net.fetch(pathToFileURL(target).toString());
  });
}
