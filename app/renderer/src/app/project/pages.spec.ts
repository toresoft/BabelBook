import { describe, expect, it } from "vitest";
import { GAP, pageItems } from "./pages";

describe("pageItems", () => {
  it("shows every page while they fit: a gap that hides one number is longer than it", () => {
    expect(pageItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("keeps the ends, the current page and its neighbours", () => {
    expect(pageItems(5, 20)).toEqual([1, GAP, 4, 5, 6, GAP, 20]);
  });

  it("opens no gap where there is nothing to hide", () => {
    expect(pageItems(2, 20)).toEqual([1, 2, 3, GAP, 20]);
    expect(pageItems(19, 20)).toEqual([1, GAP, 18, 19, 20]);
  });

  it("says one page for one page, and never zero", () => {
    expect(pageItems(1, 1)).toEqual([1]);
    expect(pageItems(1, 0)).toEqual([]);
  });
});
