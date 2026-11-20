-- 0027_subscribers_confirm_browser: which browser asked for a subscriber's confirmation link (SPEC §7).
--
-- Opening a confirmation link is consent only in the browser that asked for it. Submitting the
-- subscribe form gives that browser a random value in a cookie, and the confirmation it sends is
-- armed with a SHA-256 of that value, in the same statement as its token. A request inside the
-- cooldown sends nothing and rebinds the link already sent to its own browser, so the browser
-- that asked most recently matches. Null when no browser asked (the publisher added the address,
-- or the link was sent before this), and then the link always shows its button. Confirming,
-- erasure, and import clear it with the other confirm columns.
--
-- Adding a nullable column rewrites no rows.

ALTER TABLE subscribers ADD COLUMN confirm_browser_hash TEXT;
