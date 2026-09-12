-- Indexes for the default sort keys of the admin list views (filter/sort/pagination).
-- The status columns are already indexed (0001/0003); these add the two default-sort
-- keys that weren't, so paging the roster and the post list stays cheap. The send list
-- relies on idx_sends_status_fire (status, fire_at): it serves the status-filtered sort,
-- and the unfiltered fire_at sort is a small scan we accept at newsletter scale rather
-- than adding a third index. Email contains-search (LIKE '%term%') can't use an index.

CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers (created_at);
CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts (updated_at);
