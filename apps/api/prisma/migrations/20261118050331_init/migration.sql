-- CreateEnum
CREATE TYPE "staff_role" AS ENUM ('OWNER', 'RECEPTION', 'EMPLOYEE');

-- CreateEnum
CREATE TYPE "staff_token_purpose" AS ENUM ('INVITE', 'PASSWORD_RESET');

-- CreateEnum
CREATE TYPE "time_off_kind" AS ENUM ('VACATION', 'BLOCK');

-- CreateEnum
CREATE TYPE "subject_type" AS ENUM ('customer', 'staff');

-- CreateEnum
CREATE TYPE "created_via" AS ENUM ('ONLINE', 'RECEPTION');

-- CreateEnum
CREATE TYPE "notification_channel" AS ENUM ('WHATSAPP', 'SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "consent_source" AS ENUM ('BOOKING_FORM', 'PROFILE', 'RECEPTION', 'INBOUND_STOP');

-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('HELD', 'BOOKED', 'CHECKED_IN', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('ONLINE', 'RECEPTION', 'WALK_IN');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('STAFF', 'CUSTOMER', 'SYSTEM');

-- CreateTable
CREATE TABLE "organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "default_locale" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "phone" TEXT,
    "timezone" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_hours" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "opens" TIME(0) NOT NULL,
    "closes" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "location_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_closure" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "location_closure_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_user" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "email" TEXT,
    "can_login" BOOLEAN NOT NULL DEFAULT false,
    "password_hash" TEXT,
    "totp_secret_enc" TEXT,
    "totp_enrolled_at" TIMESTAMPTZ(3),
    "role" "staff_role" NOT NULL,
    "locale" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_recovery_code" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "code_hash" TEXT NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_auth_token" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "purpose" "staff_token_purpose" NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_auth_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_location" (
    "staff_user_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "staff_location_pkey" PRIMARY KEY ("staff_user_id","location_id")
);

-- CreateTable
CREATE TABLE "level" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "rank" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "level_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_profile" (
    "staff_user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" JSONB,
    "photo_url" TEXT,
    "level_id" UUID,
    "bookable_online" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_profile_pkey" PRIMARY KEY ("staff_user_id")
);

-- CreateTable
CREATE TABLE "employee_service" (
    "staff_user_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "employee_service_pkey" PRIMARY KEY ("staff_user_id","service_id")
);

-- CreateTable
CREATE TABLE "working_hours" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "weekday" SMALLINT NOT NULL,
    "start_time" TIME(0) NOT NULL,
    "end_time" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "working_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "time_off" (
    "id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "location_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "kind" "time_off_kind" NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "time_off_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "subject_type" "subject_type" NOT NULL,
    "subject_id" UUID NOT NULL,
    "family_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "user_agent" TEXT,
    "ip" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "phone_e164" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "locale" TEXT NOT NULL,
    "phone_verified_at" TIMESTAMPTZ(3),
    "created_via" "created_via" NOT NULL,
    "private_notes_enc" TEXT,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_consent" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" "consent_source" NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_category" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "category_id" UUID,
    "name" JSONB NOT NULL,
    "description" JSONB,
    "duration_min" INTEGER NOT NULL,
    "buffer_after_min" INTEGER NOT NULL DEFAULT 0,
    "price_cents" INTEGER NOT NULL,
    "parallelizable" BOOLEAN NOT NULL DEFAULT false,
    "resource_type_id" UUID,
    "online_bookable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_level_price" (
    "id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "level_id" UUID NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_level_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_type" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource" (
    "id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "resource_type_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "customer_id" UUID,
    "status" "appointment_status" NOT NULL,
    "source" "appointment_source" NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "confirmed_by_customer_at" TIMESTAMPTZ(3),
    "manage_version" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "created_by_staff_id" UUID,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancel_reason" TEXT,
    "cancelled_by" "actor_type",
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_segment" (
    "id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "staff_user_id" UUID NOT NULL,
    "resource_id" UUID,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "ends_at" TIMESTAMPTZ(3) NOT NULL,
    "block_ends_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "occupies" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "appointment_segment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_log" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "appointment_id" UUID,
    "customer_id" UUID,
    "template_key" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_message_id" TEXT,
    "status" "notification_status" NOT NULL,
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "notification_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_type" "actor_type" NOT NULL,
    "actor_id" UUID,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" UUID,
    "before" JSONB,
    "after" JSONB,
    "ip" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "location_organization_id_idx" ON "location"("organization_id");

-- CreateIndex
CREATE INDEX "location_hours_location_id_weekday_idx" ON "location_hours"("location_id", "weekday");

-- CreateIndex
CREATE INDEX "location_closure_location_id_starts_at_idx" ON "location_closure"("location_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "staff_user_organization_id_email_key" ON "staff_user"("organization_id", "email");

-- CreateIndex
CREATE INDEX "staff_recovery_code_staff_user_id_idx" ON "staff_recovery_code"("staff_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_auth_token_token_hash_key" ON "staff_auth_token"("token_hash");

-- CreateIndex
CREATE INDEX "staff_auth_token_staff_user_id_idx" ON "staff_auth_token"("staff_user_id");

-- CreateIndex
CREATE INDEX "staff_location_location_id_idx" ON "staff_location"("location_id");

-- CreateIndex
CREATE INDEX "level_organization_id_idx" ON "level"("organization_id");

-- CreateIndex
CREATE INDEX "employee_profile_level_id_idx" ON "employee_profile"("level_id");

-- CreateIndex
CREATE INDEX "employee_service_service_id_idx" ON "employee_service"("service_id");

-- CreateIndex
CREATE INDEX "working_hours_staff_user_id_location_id_weekday_idx" ON "working_hours"("staff_user_id", "location_id", "weekday");

-- CreateIndex
CREATE INDEX "working_hours_location_id_idx" ON "working_hours"("location_id");

-- CreateIndex
CREATE INDEX "time_off_staff_user_id_starts_at_idx" ON "time_off"("staff_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_off_location_id_idx" ON "time_off"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_token_hash_key" ON "refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "refresh_token_family_id_idx" ON "refresh_token"("family_id");

-- CreateIndex
CREATE INDEX "refresh_token_subject_type_subject_id_idx" ON "refresh_token"("subject_type", "subject_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_organization_id_phone_e164_key" ON "customer"("organization_id", "phone_e164");

-- CreateIndex
CREATE INDEX "notification_consent_customer_id_channel_changed_at_idx" ON "notification_consent"("customer_id", "channel", "changed_at");

-- CreateIndex
CREATE INDEX "service_category_organization_id_idx" ON "service_category"("organization_id");

-- CreateIndex
CREATE INDEX "service_organization_id_idx" ON "service"("organization_id");

-- CreateIndex
CREATE INDEX "service_category_id_idx" ON "service"("category_id");

-- CreateIndex
CREATE INDEX "service_resource_type_id_idx" ON "service"("resource_type_id");

-- CreateIndex
CREATE INDEX "service_level_price_level_id_idx" ON "service_level_price"("level_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_level_price_service_id_level_id_key" ON "service_level_price"("service_id", "level_id");

-- CreateIndex
CREATE INDEX "resource_type_organization_id_idx" ON "resource_type"("organization_id");

-- CreateIndex
CREATE INDEX "resource_location_id_idx" ON "resource"("location_id");

-- CreateIndex
CREATE INDEX "resource_resource_type_id_idx" ON "resource"("resource_type_id");

-- CreateIndex
CREATE INDEX "appointment_location_id_status_idx" ON "appointment"("location_id", "status");

-- CreateIndex
CREATE INDEX "appointment_hold_expires_at_idx" ON "appointment"("hold_expires_at");

-- CreateIndex
CREATE INDEX "appointment_customer_id_idx" ON "appointment"("customer_id");

-- CreateIndex
CREATE INDEX "appointment_organization_id_idx" ON "appointment"("organization_id");

-- CreateIndex
CREATE INDEX "appointment_segment_appointment_id_idx" ON "appointment_segment"("appointment_id");

-- CreateIndex
CREATE INDEX "appointment_segment_staff_user_id_starts_at_idx" ON "appointment_segment"("staff_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_segment_resource_id_starts_at_idx" ON "appointment_segment"("resource_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_segment_service_id_idx" ON "appointment_segment"("service_id");

-- CreateIndex
CREATE INDEX "notification_log_provider_message_id_idx" ON "notification_log"("provider_message_id");

-- CreateIndex
CREATE INDEX "notification_log_appointment_id_idx" ON "notification_log"("appointment_id");

-- CreateIndex
CREATE INDEX "notification_log_customer_id_idx" ON "notification_log"("customer_id");

-- CreateIndex
CREATE INDEX "notification_log_organization_id_idx" ON "notification_log"("organization_id");

-- CreateIndex
CREATE INDEX "audit_log_organization_id_at_idx" ON "audit_log"("organization_id", "at");

-- CreateIndex
CREATE INDEX "audit_log_entity_entity_id_idx" ON "audit_log"("entity", "entity_id");

-- AddForeignKey
ALTER TABLE "location" ADD CONSTRAINT "location_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_hours" ADD CONSTRAINT "location_hours_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_closure" ADD CONSTRAINT "location_closure_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_user" ADD CONSTRAINT "staff_user_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_recovery_code" ADD CONSTRAINT "staff_recovery_code_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_auth_token" ADD CONSTRAINT "staff_auth_token_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_location" ADD CONSTRAINT "staff_location_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_location" ADD CONSTRAINT "staff_location_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "level" ADD CONSTRAINT "level_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profile" ADD CONSTRAINT "employee_profile_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_profile" ADD CONSTRAINT "employee_profile_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "level"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consent" ADD CONSTRAINT "notification_consent_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_resource_type_id_fkey" FOREIGN KEY ("resource_type_id") REFERENCES "resource_type"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_level_price" ADD CONSTRAINT "service_level_price_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_level_price" ADD CONSTRAINT "service_level_price_level_id_fkey" FOREIGN KEY ("level_id") REFERENCES "level"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_type" ADD CONSTRAINT "resource_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_resource_type_id_fkey" FOREIGN KEY ("resource_type_id") REFERENCES "resource_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
