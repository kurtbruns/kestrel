-- 0004_one_active_send_per_post — make "one active send per post" a DB guarantee (I4, I6).
--
-- A post has at most one in-flight send at a time; that is what stops an issue from
-- being scheduled — and sent — twice. Until now the rule lived only in freeze()'s
-- check-then-insert (getActiveSendForPost → INSERT), which is a race: two concurrent
-- requests across Worker isolates can both pass the check and both insert a scheduled
-- send. D1 serializes writes so this is latent rather than observed, but an invariant
-- this load-bearing shouldn't rest on check-then-act when the database can enforce it.
--
-- A PARTIAL unique index does exactly that: uniqueness on post_id, but only over the
-- active statuses. Terminal states (sent / canceled / failed) fall outside the
-- predicate, so a completed or canceled send never blocks a later re-schedule. The
-- send state machine only ever transitions a row in place (scheduled → sending → sent),
-- so it never creates a second active row and the index holds across a send's life.
CREATE UNIQUE INDEX idx_sends_one_active_per_post
  ON sends (post_id)
  WHERE status IN ('scheduled', 'sending');
