-- Preserve explicit provider-independent endpoint identities on relationships.
-- Existing relationships remain source-scoped until a provider supplies a hint.

ALTER TABLE "reamon_observations"
  ADD COLUMN "from_canonical_key" TEXT,
  ADD COLUMN "to_canonical_key" TEXT;
