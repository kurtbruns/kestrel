import { describe, expect, it } from "vitest";
import { centerSquare } from "./square_image";

describe("centerSquare", () => {
  it("keeps the largest centered square of a wide, a tall, and a square image", () => {
    expect(centerSquare(800, 600)).toEqual({ x: 100, y: 0, side: 600 });
    expect(centerSquare(300, 1000)).toEqual({ x: 0, y: 350, side: 300 });
    expect(centerSquare(256, 256)).toEqual({ x: 0, y: 0, side: 256 });
  });

  it("rounds an odd margin down, so the square stays inside the image", () => {
    expect(centerSquare(101, 100)).toEqual({ x: 0, y: 0, side: 100 });
    expect(centerSquare(103, 100)).toEqual({ x: 1, y: 0, side: 100 });
  });
});
