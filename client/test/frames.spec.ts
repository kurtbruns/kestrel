// Holds the client project's happy-dom frame setting (vitest.config.ts): a preview frame
// mounts without printing anything. With frame page loading off, an <iframe> with no src
// prints a refused-load stack trace straight to stderr, past Vitest's `silent` and past a
// console spy, once per mounted preview: hundreds of lines in a green run. A dependency
// upgrade that brings it back fails here instead of burying the next real failure.

import { afterEach, expect, it } from "vitest";
import { settle } from "./support";

// The client program carries the DOM's types, not Node's, so the one Node stream this
// needs is typed here.
interface Stream {
  write(chunk: unknown, ...rest: unknown[]): boolean;
}
const stderr = (globalThis as unknown as { process: { stderr: Stream } }).process.stderr;
const write = stderr.write;

afterEach(() => {
  stderr.write = write;
  for (const frame of document.querySelectorAll("body > iframe")) {
    frame.remove();
  }
});

it("mounts a preview frame, as the editor does, without writing to stderr", async () => {
  const written: string[] = [];
  stderr.write = (chunk: unknown, ...rest: unknown[]): boolean => {
    written.push(String(chunk));
    return write.call(stderr, chunk, ...rest);
  };
  document.body.insertAdjacentHTML("beforeend", `<iframe title="Email preview"></iframe>`);
  const frame = document.querySelector<HTMLIFrameElement>("body > iframe");
  frame?.setAttribute("srcdoc", "<p>sample</p>");
  await settle();
  expect(frame?.contentDocument?.body?.textContent).toBe("sample");
  expect(written).toEqual([]);
});
