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

  // --- media bytes (public; readers + archive load these unauthenticated) ---
  r.get("/media/:key(.*)", imageRoutes.serveMedia);

  return r;
}
