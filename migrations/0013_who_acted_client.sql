-- 0013_who_acted_client: the client a change came through (SPEC §11, Who acted).
--
-- Who acted is a person or a service token, plus the client the request came through, which
-- names itself on each request in one short lowercase word (`editor`, `claude-code`). A
-- revision already records its author (a person's email, or `service`) and an import its
-- principal; each now records the client beside it. It is null when the request named none,
-- and always on a service token's row, since the token already names the program.
--
-- What can't be recovered: no client was recorded before this, and nothing tells a person's
-- change in the editor from one through another program, so every row a person made is read
-- as the editor's, the one client they were offered. Those rows are rewritten once; a service
-- token's are left as they are.

ALTER TABLE post_revisions ADD COLUMN client TEXT
  CHECK (client = lower(client) AND length(client) BETWEEN 1 AND 32);
ALTER TABLE imports ADD COLUMN client TEXT
  CHECK (client = lower(client) AND length(client) BETWEEN 1 AND 32);

UPDATE post_revisions SET client = 'editor' WHERE author IS NOT NULL AND author <> 'service';
UPDATE imports SET client = 'editor' WHERE principal_kind = 'human';
