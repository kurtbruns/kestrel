// Build-time constants scripts/build-client.mjs defines for the bundle (esbuild `define`).

/** True in the dev flavor, false in production; a branch on it is compiled out. */
declare const __DEV__: boolean;

// Icons import as their file text (scripts/build-client.mjs: esbuild's text loader; the
// client test project: the svg-as-text plugin in vitest.config.ts).
declare module "*.svg" {
  const markup: string;
  export default markup;
}

// Vite's raw import, used by the client test setup to load the real admin shell.
declare module "*?raw" {
  const text: string;
  export default text;
}
