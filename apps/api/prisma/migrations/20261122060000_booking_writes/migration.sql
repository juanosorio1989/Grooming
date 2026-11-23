-- Booking writes: visit order, coat snapshot, pending (not yet saved) pet.
-- Reversible by hand: DROP the index, the CHECK and the three columns (see docs/data/README.md).

-- AlterTable: add nullable first so existing rows can be backfilled.
ALTER TABLE "pet_visit" ADD COLUMN     "coat_type_at_booking" "coat_type",
ADD COLUMN     "pending_pet" JSONB,
ADD COLUMN     "position" SMALLINT;

-- Backfill: order pets within each appointment by id (UUID v7 = creation order).
UPDATE "pet_visit" pv
SET "position" = ranked.pos
FROM (
  SELECT "id", (row_number() OVER (PARTITION BY "appointment_id" ORDER BY "id") - 1)::smallint AS pos
  FROM "pet_visit"
) ranked
WHERE pv."id" = ranked."id";

-- Backfill: coat from the pet, else SMOOTH.
UPDATE "pet_visit" pv
SET "coat_type_at_booking" = COALESCE(p."coat_type", 'SMOOTH')
FROM "pet_visit" v
LEFT JOIN "pet" p ON p."id" = v."pet_id"
WHERE pv."id" = v."id";

ALTER TABLE "pet_visit" ALTER COLUMN "position" SET NOT NULL,
ALTER COLUMN "coat_type_at_booking" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "pet_visit_appointment_id_position_key" ON "pet_visit"("appointment_id", "position");

-- Raw SQL (not modelled by Prisma): a visit names a saved pet or carries a pending one.
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_pet_or_pending" CHECK ("pet_id" IS NOT NULL OR "pending_pet" IS NOT NULL);
