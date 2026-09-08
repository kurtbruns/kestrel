/**
 * Kestrel — Worker entry point.
 *
 * One Worker exposes both handlers (spec §6, §13):
 *   - fetch()     → HTTP API + public reader pages + archive + webhooks
 *                   (the URLPattern router and auth are wired in M1, issue #2)
 *   - scheduled() → the reconciling send sweep, once a minute
 *                   (wired in M6, issue #7)
 *
 * M0 is a booting skeleton: only `GET /health` is live so the scaffold and
 * the test harness have something real to exercise.
 */
export default {
  async fetch(request): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (request.method === "GET" && pathname === "/health") {
      return Response.json({ status: "ok", service: "kestrel" });
    }
    return new Response("Not found", { status: 404 });
  },

  async scheduled(): Promise<void> {
    // The reconciling send sweep is wired in M6 (issue #7).
  },
} satisfies ExportedHandler<Env>;
