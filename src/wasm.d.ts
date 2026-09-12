/** Wrangler (and the Vitest workers pool) resolve a `.wasm` import to a compiled
 *  `WebAssembly.Module`. Declared so `import mod from "…/x.wasm"` type-checks. */
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}
