/**
 * Composition root: build the Router and register all routes.
 *
 * Auth: the admin/authoring surface is wrapped in `requireAuth`; reader/media
 * routes are public. Content / render / subscribers / sends / archive / webhook
 * routes are mounted here as they land in later milestones.
 */
import { Router } from "./router";
import { json } from "./lib/errors";
import { requireAuth } from "./auth/middleware";
import * as postRoutes from "./routes/posts";
import * as imageRoutes from "./routes/images";
import * as renderRoutes from "./routes/render_actions";
import * as publicRoutes from "./routes/public";
import * as subscriberRoutes from "./routes/subscribers";
import * as suppressionRoutes from "./routes/suppressions";
import * as scheduleRoutes from "./routes/schedule";
import * as sendRoutes from "./routes/sends";

export function createRouter(): Router {
  const r = new Router();
  const authed = [requireAuth];

  // --- system ---
  r.get("/health", () => json({ status: "ok", service: "kestrel" }));
  r.get("/api/whoami", (c) => json({ principal: c.principal }), authed);

  // --- posts + revisions (authed) ---
  r.post("/posts", postRoutes.createPost, authed);
  r.get("/posts", postRoutes.listPosts, authed);
  r.get("/posts/:id", postRoutes.getPost, authed);
  r.put("/posts/:id", postRoutes.updatePost, authed);
  r.delete("/posts/:id", postRoutes.deletePost, authed);
  r.get("/posts/:id/revisions", postRoutes.listRevisions, authed);
  r.get("/posts/:id/revisions/:n", postRoutes.getRevision, authed);

  // --- images (authed upload/list/delete) ---
  r.post("/posts/:id/images", imageRoutes.uploadImage, authed);
  r.get("/posts/:id/images", imageRoutes.listImages, authed);
  r.delete("/posts/:id/images/:filename", imageRoutes.deleteImage, authed);

  // --- render: preview + test (authed); all go through the one render path ---
  r.post("/posts/:id/preview", renderRoutes.preview, authed);
  r.get("/posts/:id/preview", renderRoutes.previewPage, authed);
  r.post("/posts/:id/test", renderRoutes.test, authed);
  r.get("/api/dev/outbox", renderRoutes.devOutbox, authed);

  // --- schedule / send / cancel (authed); freeze + soft-lock (M5) ---
  r.post("/posts/:id/schedule", scheduleRoutes.schedule, authed);
  r.post("/posts/:id/send", scheduleRoutes.sendNow, authed);
  r.get("/sends", sendRoutes.list, authed);
  r.get("/sends/:id", sendRoutes.get, authed);
  r.post("/sends/:id/cancel", sendRoutes.cancel, authed);

  // --- subscribers (authed admin) ---
  r.post("/subscribers", subscriberRoutes.create, authed);
  r.get("/subscribers", subscriberRoutes.list, authed);
  r.get("/subscribers/:id", subscriberRoutes.get, authed);

  // --- suppressions (authed admin) ---
  r.get("/suppressions", suppressionRoutes.list, authed);
  r.post("/suppressions", suppressionRoutes.add, authed);
  r.delete("/suppressions/:email", suppressionRoutes.clear, authed);

  // --- public reader routes (token-scoped; no login) ---
  r.get("/subscribe", publicRoutes.subscribeForm);
  r.post("/subscribe", publicRoutes.subscribe);
  r.get("/confirm", publicRoutes.confirm);
  r.get("/unsubscribe", publicRoutes.unsubscribeLanding);
  r.post("/unsubscribe", publicRoutes.unsubscribe);

  // --- media bytes (public; readers + archive load these unauthenticated) ---
  r.get("/media/:key(.*)", imageRoutes.serveMedia);

  return r;
}
