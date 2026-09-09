/** Ambient type for `*.md` imports bundled as Wrangler Text modules. */
declare module "*.md" {
  const content: string;
  export default content;
}
