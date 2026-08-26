import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { APP_ICON, TRAY_ICON } from "../main/icons.ts";

/** The pixels of a base64 PNG data URL, as RGBA rows. */
function pixels(dataUrl: string): { size: number; rgba: Array<[number, number, number, number]> } {
  const png = Buffer.from(dataUrl.split(",")[1]!, "base64");
  expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  const size = png.readUInt32BE(16);
  expect(png[24]).toBe(8);   // bit depth
  expect(png[25]).toBe(6);   // RGBA

  let at = 8;
  const parts: Buffer[] = [];
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    if (png.subarray(at + 4, at + 8).toString("latin1") === "IDAT") {
      parts.push(png.subarray(at + 8, at + 8 + length));
    }
    at += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(parts));
  const stride = 1 + size * 4;
  const rgba: Array<[number, number, number, number]> = [];
  for (let y = 0; y < size; y++) {
    // Every row must use filter 0, or the bytes below are not colours.
    expect(raw[y * stride]).toBe(0);
    for (let x = 0; x < size; x++) {
      const start = y * stride + 1 + x * 4;
      rgba.push([raw[start]!, raw[start + 1]!, raw[start + 2]!, raw[start + 3]!]);
    }
  }
  return { size, rgba };
}

/**
 * What the mark has to be, rather than what it looks like.
 *
 * The icon that shipped before this was a rectangle of one flat colour: a
 * valid PNG, the right size, and nothing a person could recognise. Every
 * assertion here is one that a mark like that would fail.
 */
describe("the application mark", () => {
  it("is a 32-pixel square for the tray, and 128 for the window", () => {
    expect(pixels(TRAY_ICON).size).toBe(32);
    expect(pixels(APP_ICON).size).toBe(128);
  });

  // Production break: a single flat colour is a rectangle, not a mark.
  it("has a shape, not one colour filling a box", () => {
    for (const icon of [TRAY_ICON, APP_ICON]) {
      const opaque = pixels(icon).rgba.filter(([, , , alpha]) => alpha > 0);
      const colours = new Set(opaque.map((colour) => colour.join(",")));

      expect(colours.size).toBeGreaterThan(1);
    }
  });

  it("leaves its corners transparent, so it is a mark and not a tile", () => {
    const { size, rgba } = pixels(TRAY_ICON);
    const at = (x: number, y: number) => rgba[y * size + x]!;

    for (const [x, y] of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) {
      expect(at(x!, y!)[3]).toBe(0);
    }
  });

  it("covers enough of its box to be seen at all", () => {
    const { size, rgba } = pixels(TRAY_ICON);
    const opaque = rgba.filter(([, , , alpha]) => alpha > 0).length;

    // A mark drawn too small reads as dirt on the panel; too large and the
    // rounded corners stop being visible.
    expect(opaque / (size * size)).toBeGreaterThan(0.4);
    expect(opaque / (size * size)).toBeLessThan(0.9);
  });

  it("draws the same shape at both sizes", () => {
    // Sampled at the same fractions of each icon, the two must agree: one
    // drawing scaled, not two that can drift apart.
    const tray = pixels(TRAY_ICON);
    const app = pixels(APP_ICON);
    const opaqueAt = (icon: typeof tray, u: number, v: number) => {
      const x = Math.floor(u * icon.size);
      const y = Math.floor(v * icon.size);
      return icon.rgba[y * icon.size + x]![3] > 0;
    };

    for (const u of [0.2, 0.5, 0.8]) {
      for (const v of [0.2, 0.5, 0.8]) {
        expect({ u, v, opaque: opaqueAt(tray, u, v) })
          .toEqual({ u, v, opaque: opaqueAt(app, u, v) });
      }
    }
  });
});
