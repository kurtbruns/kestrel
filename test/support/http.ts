/**
 * What a spec needs to call the Worker over HTTP: its origin, an admin's headers, a JSON
 * reader, and a real image to upload. One copy, so every spec talks to the app the same way.
 */
import { adminAuth } from "./auth";

/** The origin specs address the Worker at (`SELF.fetch`). */
export const base = "https://kestrel.test";

/** An admin's headers, minted once per spec file. */
export const AUTH = await adminAuth();

/** An admin's headers for a JSON body. */
export const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

/** A response's JSON body, untyped: a spec asserts on its shape. */
export const readJson = async (r: Response): Promise<any> => r.json();

/** A real 1×1 PNG, for the specs that upload an image. */
export const PNG_1x1 = Uint8Array.from(
  atob(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC",
  ),
  (ch) => ch.charCodeAt(0),
);
