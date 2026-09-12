-- Indexes for the default sort keys of the admin list views (filter/sort/pagination).
-- The status columns are already indexed (0001/0003); these cover the two remaining
-- default-sort keys so paging the roster and the post list stays cheap. The send list's
-- default sort (fire_at) is already covered by idx_sends_status_fire. Email
-- contains-search (LIKE '%term%') can't use an index, so nothing is added for it.

CREATE INDEX IF NOT EXISTS idx_subscribers_created ON subscribers (created_at);
CREATE INDEX IF NOT EXISTS idx_posts_updated ON posts (updated_at);
