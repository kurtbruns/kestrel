// Build-time constants scripts/build-client.mjs defines for the bundle (esbuild `define`).

/** True in the dev flavor, false in production; a branch on it is compiled out. */
declare const __DEV__: boolean;
