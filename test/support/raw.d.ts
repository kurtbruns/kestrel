// Vite's raw import, for a Worker spec that checks a dev script's source (the dev ticker's
// receipts cron) where there is no filesystem to read it from.
declare module "*?raw" {
  const text: string;
  export default text;
}
