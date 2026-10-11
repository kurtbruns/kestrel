import { describe, expect, it } from "vitest";
import { savesSettled, trackSaves } from "./pending_save";

describe("pending saves", () => {
  it("settles at once with nothing tracked, waits for a tracked save, and never rejects", async () => {
    await expect(savesSettled()).resolves.toBeUndefined();
    let land!: () => void;
    trackSaves(new Promise<void>((r) => (land = r)));
    let settled = false;
    const waiting = savesSettled().then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    land();
    await waiting;
    expect(settled).toBe(true);
    trackSaves(Promise.reject(new Error("save failed")));
    await expect(savesSettled()).resolves.toBeUndefined();
  });
});
