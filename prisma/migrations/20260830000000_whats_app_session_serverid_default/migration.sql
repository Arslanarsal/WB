-- whats_app_session."serverId" is NOT NULL with no default, but schema.prisma does not
-- declare the field, so Prisma Client omits it from every insert. That made saving a new
-- session fail with a null constraint violation, creds never persisted, and the QR code
-- regenerated forever instead of completing the pairing.
--
-- Defaulting to 1 matches SERVER_ID=1 in the deployment env. Nothing in src/ reads the
-- column; it exists only for multi-server isolation.
ALTER TABLE "public"."whats_app_session" ALTER COLUMN "serverId" SET DEFAULT 1;
