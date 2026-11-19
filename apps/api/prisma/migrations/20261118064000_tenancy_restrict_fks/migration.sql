-- Tenancy columns on hot child tables, restrictive history FKs, nullable
-- customer name, text audit entity_id.
--
-- organization_id is added nullable, backfilled from the parent row, then set
-- NOT NULL, so the migration is safe on non-empty tables.
--
-- Down (Prisma migrations are forward-only; to revert manually):
--   - drop the five *_organization_id_fkey constraints, their indexes and the
--     organization_id columns on resource, appointment_segment, working_hours,
--     time_off, notification_consent;
--   - restore FK actions: appointment.customer_id and
--     appointment_segment.resource_id and service.resource_type_id ON DELETE
--     SET NULL, notification_consent.customer_id ON DELETE CASCADE;
--   - customer.name SET NOT NULL (fails while any name is null) and
--     audit_log.entity_id TYPE uuid USING entity_id::uuid (fails on non-UUID rows).

BEGIN;

-- Restrictive FKs: history must survive deletes of customers, resources and resource types.
ALTER TABLE "appointment" DROP CONSTRAINT "appointment_customer_id_fkey";
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointment_segment" DROP CONSTRAINT "appointment_segment_resource_id_fkey";
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "notification_consent" DROP CONSTRAINT "notification_consent_customer_id_fkey";
ALTER TABLE "notification_consent" ADD CONSTRAINT "notification_consent_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "service" DROP CONSTRAINT "service_resource_type_id_fkey";
ALTER TABLE "service" ADD CONSTRAINT "service_resource_type_id_fkey" FOREIGN KEY ("resource_type_id") REFERENCES "resource_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Flexible columns.
ALTER TABLE "customer" ALTER COLUMN "name" DROP NOT NULL;
ALTER TABLE "audit_log" ALTER COLUMN "entity_id" SET DATA TYPE TEXT;

-- organization_id: add nullable, backfill from parent, then NOT NULL.
ALTER TABLE "resource" ADD COLUMN "organization_id" UUID;
UPDATE "resource" r SET "organization_id" = l."organization_id" FROM "location" l WHERE l."id" = r."location_id";
ALTER TABLE "resource" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "appointment_segment" ADD COLUMN "organization_id" UUID;
UPDATE "appointment_segment" s SET "organization_id" = a."organization_id" FROM "appointment" a WHERE a."id" = s."appointment_id";
ALTER TABLE "appointment_segment" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "working_hours" ADD COLUMN "organization_id" UUID;
UPDATE "working_hours" w SET "organization_id" = u."organization_id" FROM "staff_user" u WHERE u."id" = w."staff_user_id";
ALTER TABLE "working_hours" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "time_off" ADD COLUMN "organization_id" UUID;
UPDATE "time_off" t SET "organization_id" = u."organization_id" FROM "staff_user" u WHERE u."id" = t."staff_user_id";
ALTER TABLE "time_off" ALTER COLUMN "organization_id" SET NOT NULL;

ALTER TABLE "notification_consent" ADD COLUMN "organization_id" UUID;
UPDATE "notification_consent" n SET "organization_id" = c."organization_id" FROM "customer" c WHERE c."id" = n."customer_id";
ALTER TABLE "notification_consent" ALTER COLUMN "organization_id" SET NOT NULL;

CREATE INDEX "resource_organization_id_idx" ON "resource"("organization_id");
CREATE INDEX "appointment_segment_organization_id_starts_at_idx" ON "appointment_segment"("organization_id", "starts_at");
CREATE INDEX "working_hours_organization_id_idx" ON "working_hours"("organization_id");
CREATE INDEX "time_off_organization_id_idx" ON "time_off"("organization_id");
CREATE INDEX "notification_consent_organization_id_idx" ON "notification_consent"("organization_id");

ALTER TABLE "resource" ADD CONSTRAINT "resource_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "notification_consent" ADD CONSTRAINT "notification_consent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

COMMIT;
