-- 0027_subscribers_confirm_browser: which browser asked for a subscriber's confirmation link (SPEC §7).
--
-- Opening a confirmation link is consent only in the browser that asked for it. Submitting the
-- subscribe form gives that browser a random value in a cookie, and the confirmation it sends is
-- armed with a SHA-256 of that value, in the same statement as its token, so only the browser
-- that asked for the link that went out matches it. Null when no browser asked (the publisher
-- added the address, or the link was sent before this), and then the link always shows its
-- Confirm button. Erasure and import clear it with the other confirm columns.
--
-- Adding a nullable column rewrites no rows.

ALTER TABLE subscribers ADD COLUMN confirm_browser_hash TEXT;
