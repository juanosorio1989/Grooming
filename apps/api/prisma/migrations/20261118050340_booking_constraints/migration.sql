-- Booking constraints (hand-written; Prisma does not model them).
-- Spec: docs/superpowers/specs/2026-11-17-mvp-design/data-model.md, "No double booking".
--
-- Down (Prisma migrations are forward-only; to revert manually):
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS no_resource_overlap;
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS no_employee_overlap;
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS segment_time_order;
--   (btree_gist is left installed; it is harmless.)

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointment_segment
  ADD CONSTRAINT segment_time_order CHECK (starts_at < ends_at AND ends_at <= block_ends_at);

ALTER TABLE appointment_segment
  ADD CONSTRAINT no_employee_overlap EXCLUDE USING gist (
    staff_user_id WITH =,
    tstzrange(starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (occupies);

ALTER TABLE appointment_segment
  ADD CONSTRAINT no_resource_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (occupies AND resource_id IS NOT NULL);
