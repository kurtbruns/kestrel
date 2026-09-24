// Vite's raw import, for a Worker spec that checks a file's source where there is no
// filesystem to read it from: the dev ticker's receipts cron, and the SQL under src/.
declare module "*?raw" {
  const text: string;
  export default text;
}

// Vite's glob import, the raw form of it only (each matching file's text, by path).
interface ImportMeta {
  glob(
    pattern: string,
    options: { query: "?raw"; import: "default"; eager: true },
  ): Record<string, string>;
}
