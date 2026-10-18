// What a post offers and where its send stands, read from the post as the server answers it:
// its `actions`, which say exactly what the server would take now, and its `send`. A view
// offers a post control only from these, never from `status`, so the editor and Claude agree.

import type { Post, PostAction } from "../../shared/posts";
import type { SendView } from "../../shared/sends";

/** The act the server would take for the post now, by name, or undefined when it wouldn't. */
export function postAction(
  post: Pick<Post, "actions">,
  name: PostAction["name"],
): PostAction | undefined {
  return post.actions.find((a) => a.name === name);
}

/** The post's send while it is scheduled or going out, or null: a sent post's send is its record. */
export function activeSend(post: Pick<Post, "send">): SendView | null {
  const s = post.send;
  return s && (s.status === "scheduled" || s.status === "sending") ? s : null;
}
