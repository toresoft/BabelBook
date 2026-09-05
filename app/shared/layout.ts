/**
 * The sizes the window and the stylesheet have to agree about.
 *
 * They are declared here, in `shared/`, for the same reason the channels are:
 * one of the two facts lives in the main process and the other in a media
 * query, and a number copied into both places drifts silently. Nothing here
 * imports Electron, so `app/test/window.test.ts` can hold it against the CSS.
 */

/**
 * The width under which the project screen stops being two columns.
 *
 * Below it `project.css` sends the book's column under the list rather than
 * squeezing it: the media query is the fact, this is its name in TypeScript.
 */
export const TWO_COLUMN_WIDTH = 960;

/**
 * The narrowest the window may be dragged.
 *
 * Above the breakpoint, with room to spare: `BrowserWindow`'s width counts the
 * frame the platform draws, while the media query measures only the page
 * inside it. A floor set at the breakpoint itself would still let the right
 * column collapse — the very state it is here to forbid.
 */
export const MIN_WINDOW_WIDTH = 1000;

/**
 * The shortest the window may be dragged.
 *
 * Height cannot collapse the column — the side scrolls — so this floor is only
 * about a window too short to say anything: under it the book's column is a
 * header, a button, and no room for the panel below them.
 */
export const MIN_WINDOW_HEIGHT = 600;
