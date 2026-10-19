/** The vendored QR encoder (integrations plan KTD8). */

import { describe, expect, it } from "vitest";

import { QrCode } from "../ui/qr.js";

describe("qr.js", () => {
  it("encodes the pairing link into a version 3 symbol with the three finder patterns at the corners", () => {
    const qr = QrCode.encodeText("https://t.me/tg_test_bot?start=123456", QrCode.Ecc.MEDIUM);
    expect(qr.version).toBe(3);
    expect(qr.size).toBe(29);
    // A finder: a dark 7x7 ring, a light ring, a dark 3x3 centre.
    const finder = (ox: number, oy: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3));
          expect([ox + x, oy + y, qr.getModule(ox + x, oy + y)]).toEqual([ox + x, oy + y, ring !== 2]);
        }
      }
    };
    finder(0, 0);
    finder(qr.size - 7, 0);
    finder(0, qr.size - 7);
  });
});
