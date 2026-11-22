-- A HELD appointment always has a hold expiry, so the sweeper and every write can release it.
-- Reversible by hand: ALTER TABLE "appointment" DROP CONSTRAINT "appointment_held_has_expiry";
-- (the backfill below only sets an expiry on rows that had none; dropping the CHECK does not need to undo it).

-- Backfill: a HELD row without an expiry (none are expected) expires now and is released by the next sweep or write.
UPDATE "appointment" SET "hold_expires_at" = now() WHERE "status" = 'HELD' AND "hold_expires_at" IS NULL;

-- Raw SQL (not modelled by Prisma).
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_held_has_expiry" CHECK ("status" <> 'HELD' OR "hold_expires_at" IS NOT NULL);
