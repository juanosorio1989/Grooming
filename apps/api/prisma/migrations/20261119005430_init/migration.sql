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
CREATE TYPE "appointment_status" AS ENUM ('HELD', 'BOOKED', 'IN_SHOP', 'COMPLETED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('ONLINE', 'RECEPTION', 'WALK_IN');

-- CreateEnum
CREATE TYPE "notification_status" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "actor_type" AS ENUM ('STAFF', 'CUSTOMER', 'SYSTEM');

-- CreateEnum
CREATE TYPE "species" AS ENUM ('DOG', 'CAT');

-- CreateEnum
CREATE TYPE "service_species" AS ENUM ('DOG', 'CAT', 'ANY');

-- CreateEnum
CREATE TYPE "size_class" AS ENUM ('S', 'M', 'L', 'XL');

-- CreateEnum
CREATE TYPE "coat_type" AS ENUM ('SMOOTH', 'DOUBLE', 'CURLY', 'WIRE', 'LONG', 'HAIRLESS');

-- CreateEnum
CREATE TYPE "temperament" AS ENUM ('CALM', 'NERVOUS', 'REACTIVE', 'NEEDS_MUZZLE');

-- CreateEnum
CREATE TYPE "pet_sex" AS ENUM ('MALE', 'FEMALE');

-- CreateEnum
CREATE TYPE "vaccine_type" AS ENUM ('RABIES', 'DHPP', 'BORDETELLA', 'FVRCP', 'OTHER');

-- CreateEnum
CREATE TYPE "media_kind" AS ENUM ('PET_PHOTO', 'VACCINE_CARD', 'BEFORE', 'AFTER', 'STEP');

-- CreateEnum
CREATE TYPE "media_status" AS ENUM ('PENDING', 'READY');

-- CreateEnum
CREATE TYPE "stage" AS ENUM ('BATH', 'DRY', 'GROOM', 'FINISH');

-- CreateEnum
CREATE TYPE "segment_stage" AS ENUM ('BATH', 'DRY', 'GROOM', 'FINISH', 'KENNEL');

-- CreateEnum
CREATE TYPE "step_stage" AS ENUM ('RECEIVED', 'BATH', 'DRY', 'GROOM', 'FINISH', 'READY');

-- CreateEnum
CREATE TYPE "step_status" AS ENUM ('PENDING', 'IN_PROGRESS', 'DONE', 'SKIPPED');

-- CreateEnum
CREATE TYPE "pet_visit_status" AS ENUM ('BOOKED', 'RECEIVED', 'IN_PROGRESS', 'READY', 'PICKED_UP', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "booking_mode" AS ENUM ('WAIT', 'DROP_OFF');

-- CreateEnum
CREATE TYPE "skill" AS ENUM ('BATHER', 'GROOMER');

-- CreateEnum
CREATE TYPE "resource_kind" AS ENUM ('STATION', 'KENNEL');

-- CreateEnum
CREATE TYPE "observation_kind" AS ENUM ('MATTING', 'FLEAS', 'TICKS', 'SKIN_IRRITATION', 'EAR_ISSUE', 'NAIL_ISSUE', 'LUMP', 'OTHER');

-- CreateEnum
CREATE TYPE "severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('CASH', 'CARD_EXTERNAL', 'ZELLE', 'VENMO', 'OTHER');

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
CREATE TABLE "employee_profile" (
    "staff_user_id" UUID NOT NULL,
    "display_name" TEXT NOT NULL,
    "bio" JSONB,
    "photo_url" TEXT,
    "skills" "skill"[] DEFAULT ARRAY[]::"skill"[],
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
    "organization_id" UUID NOT NULL,
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
    "organization_id" UUID NOT NULL,
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
    "emergency_phone_e164" TEXT,
    "name" TEXT,
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
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "notification_channel" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "source" "consent_source" NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "species" "species" NOT NULL,
    "breed" TEXT NOT NULL,
    "breed_code" TEXT,
    "birth_date" DATE,
    "sex" "pet_sex",
    "neutered" BOOLEAN,
    "weight_g" INTEGER,
    "weight_measured_at" TIMESTAMPTZ(3),
    "size_class" "size_class",
    "coat_type" "coat_type",
    "temperament" "temperament"[] DEFAULT ARRAY[]::"temperament"[],
    "allergies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "medical_notes_enc" TEXT,
    "behavior_notes" TEXT,
    "vet_name" TEXT,
    "vet_phone_e164" TEXT,
    "photo_media_id" UUID,
    "deleted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_vaccine" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pet_id" UUID NOT NULL,
    "type" "vaccine_type" NOT NULL,
    "expires_on" DATE NOT NULL,
    "card_media_id" UUID,
    "verified_by_staff_id" UUID,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pet_vaccine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "media" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" "media_kind" NOT NULL,
    "object_key" TEXT NOT NULL,
    "content_type" TEXT NOT NULL,
    "bytes" INTEGER,
    "pet_id" UUID NOT NULL,
    "visit_id" UUID,
    "uploaded_by_type" "actor_type" NOT NULL,
    "uploaded_by_id" UUID,
    "status" "media_status" NOT NULL DEFAULT 'PENDING',
    "client_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
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
    "species" "service_species" NOT NULL,
    "stage" "stage" NOT NULL,
    "is_main" BOOLEAN NOT NULL,
    "resource_type_id" UUID,
    "required_skill" "skill" NOT NULL,
    "booking_mode" "booking_mode",
    "buffer_after_min" INTEGER NOT NULL DEFAULT 0,
    "online_bookable" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_price" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "size_class" "size_class" NOT NULL,
    "coat_type" "coat_type",
    "duration_min" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "service_price_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_type" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" JSONB NOT NULL,
    "kind" "resource_kind" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "resource_type_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
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
    "booking_mode" "booking_mode" NOT NULL,
    "drop_off_at" TIMESTAMPTZ(3),
    "estimated_ready_at" TIMESTAMPTZ(3),
    "checked_in_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
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
    "organization_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "pet_visit_id" UUID NOT NULL,
    "stage" "segment_stage" NOT NULL,
    "service_id" UUID,
    "staff_user_id" UUID,
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
CREATE TABLE "pet_visit" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "pet_id" UUID,
    "status" "pet_visit_status" NOT NULL,
    "size_class_at_booking" "size_class" NOT NULL,
    "size_class_at_checkin" "size_class",
    "weight_g_at_checkin" INTEGER,
    "preferred_groomer_id" UUID,
    "kennel_resource_id" UUID,
    "eta_at" TIMESTAMPTZ(3),
    "eta_notified_at" TIMESTAMPTZ(3),
    "ready_at" TIMESTAMPTZ(3),
    "picked_up_at" TIMESTAMPTZ(3),
    "picked_up_by_name" TEXT,
    "price_cents_quoted" INTEGER NOT NULL,
    "price_cents_final" INTEGER,
    "report_published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pet_visit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pet_visit_service" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pet_visit_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "pet_visit_service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_step" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pet_visit_id" UUID NOT NULL,
    "stage" "step_stage" NOT NULL,
    "sort" INTEGER NOT NULL,
    "status" "step_status" NOT NULL DEFAULT 'PENDING',
    "skip_reason" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),
    "performed_by_staff_id" UUID,
    "recorded_by_staff_id" UUID,
    "client_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visit_step_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_observation" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "pet_visit_id" UUID NOT NULL,
    "kind" "observation_kind" NOT NULL,
    "severity" "severity" NOT NULL,
    "note" TEXT,
    "media_id" UUID,
    "recorded_by_staff_id" UUID NOT NULL,
    "client_ref" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visit_observation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "visit_report" (
    "pet_visit_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "summary_note" TEXT,
    "recommendations" TEXT,
    "next_visit_weeks" INTEGER,
    "published_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "visit_report_pkey" PRIMARY KEY ("pet_visit_id")
);

-- CreateTable
CREATE TABLE "payment_record" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "method" "payment_method" NOT NULL,
    "recorded_by_staff_id" UUID NOT NULL,
    "recorded_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payment_record_pkey" PRIMARY KEY ("id")
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
    "entity_id" TEXT,
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
CREATE INDEX "employee_service_service_id_idx" ON "employee_service"("service_id");

-- CreateIndex
CREATE INDEX "working_hours_staff_user_id_location_id_weekday_idx" ON "working_hours"("staff_user_id", "location_id", "weekday");

-- CreateIndex
CREATE INDEX "working_hours_location_id_idx" ON "working_hours"("location_id");

-- CreateIndex
CREATE INDEX "working_hours_organization_id_idx" ON "working_hours"("organization_id");

-- CreateIndex
CREATE INDEX "time_off_staff_user_id_starts_at_idx" ON "time_off"("staff_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "time_off_location_id_idx" ON "time_off"("location_id");

-- CreateIndex
CREATE INDEX "time_off_organization_id_idx" ON "time_off"("organization_id");

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
CREATE INDEX "notification_consent_organization_id_idx" ON "notification_consent"("organization_id");

-- CreateIndex
CREATE INDEX "pet_organization_id_idx" ON "pet"("organization_id");

-- CreateIndex
CREATE INDEX "pet_customer_id_idx" ON "pet"("customer_id");

-- CreateIndex
CREATE INDEX "pet_photo_media_id_idx" ON "pet"("photo_media_id");

-- CreateIndex
CREATE INDEX "pet_vaccine_organization_id_idx" ON "pet_vaccine"("organization_id");

-- CreateIndex
CREATE INDEX "pet_vaccine_pet_id_idx" ON "pet_vaccine"("pet_id");

-- CreateIndex
CREATE INDEX "pet_vaccine_card_media_id_idx" ON "pet_vaccine"("card_media_id");

-- CreateIndex
CREATE INDEX "pet_vaccine_verified_by_staff_id_idx" ON "pet_vaccine"("verified_by_staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_object_key_key" ON "media"("object_key");

-- CreateIndex
CREATE INDEX "media_pet_id_idx" ON "media"("pet_id");

-- CreateIndex
CREATE INDEX "media_visit_id_idx" ON "media"("visit_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_organization_id_client_ref_key" ON "media"("organization_id", "client_ref");

-- CreateIndex
CREATE INDEX "service_category_organization_id_idx" ON "service_category"("organization_id");

-- CreateIndex
CREATE INDEX "service_organization_id_idx" ON "service"("organization_id");

-- CreateIndex
CREATE INDEX "service_category_id_idx" ON "service"("category_id");

-- CreateIndex
CREATE INDEX "service_resource_type_id_idx" ON "service"("resource_type_id");

-- CreateIndex
CREATE INDEX "service_price_organization_id_idx" ON "service_price"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "service_price_service_id_size_class_coat_type_key" ON "service_price"("service_id", "size_class", "coat_type");

-- CreateIndex
CREATE INDEX "resource_type_organization_id_idx" ON "resource_type"("organization_id");

-- CreateIndex
CREATE INDEX "resource_organization_id_idx" ON "resource"("organization_id");

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
CREATE INDEX "appointment_segment_pet_visit_id_idx" ON "appointment_segment"("pet_visit_id");

-- CreateIndex
CREATE INDEX "appointment_segment_staff_user_id_starts_at_idx" ON "appointment_segment"("staff_user_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_segment_resource_id_starts_at_idx" ON "appointment_segment"("resource_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointment_segment_service_id_idx" ON "appointment_segment"("service_id");

-- CreateIndex
CREATE INDEX "appointment_segment_organization_id_starts_at_idx" ON "appointment_segment"("organization_id", "starts_at");

-- CreateIndex
CREATE INDEX "pet_visit_organization_id_idx" ON "pet_visit"("organization_id");

-- CreateIndex
CREATE INDEX "pet_visit_appointment_id_idx" ON "pet_visit"("appointment_id");

-- CreateIndex
CREATE INDEX "pet_visit_pet_id_idx" ON "pet_visit"("pet_id");

-- CreateIndex
CREATE INDEX "pet_visit_kennel_resource_id_idx" ON "pet_visit"("kennel_resource_id");

-- CreateIndex
CREATE INDEX "pet_visit_preferred_groomer_id_idx" ON "pet_visit"("preferred_groomer_id");

-- CreateIndex
CREATE INDEX "pet_visit_service_organization_id_idx" ON "pet_visit_service"("organization_id");

-- CreateIndex
CREATE INDEX "pet_visit_service_service_id_idx" ON "pet_visit_service"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "pet_visit_service_pet_visit_id_service_id_key" ON "pet_visit_service"("pet_visit_id", "service_id");

-- CreateIndex
CREATE INDEX "visit_step_pet_visit_id_sort_idx" ON "visit_step"("pet_visit_id", "sort");

-- CreateIndex
CREATE INDEX "visit_step_performed_by_staff_id_idx" ON "visit_step"("performed_by_staff_id");

-- CreateIndex
CREATE INDEX "visit_step_recorded_by_staff_id_idx" ON "visit_step"("recorded_by_staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "visit_step_organization_id_client_ref_key" ON "visit_step"("organization_id", "client_ref");

-- CreateIndex
CREATE INDEX "visit_observation_pet_visit_id_idx" ON "visit_observation"("pet_visit_id");

-- CreateIndex
CREATE INDEX "visit_observation_media_id_idx" ON "visit_observation"("media_id");

-- CreateIndex
CREATE INDEX "visit_observation_recorded_by_staff_id_idx" ON "visit_observation"("recorded_by_staff_id");

-- CreateIndex
CREATE UNIQUE INDEX "visit_observation_organization_id_client_ref_key" ON "visit_observation"("organization_id", "client_ref");

-- CreateIndex
CREATE INDEX "visit_report_organization_id_idx" ON "visit_report"("organization_id");

-- CreateIndex
CREATE INDEX "payment_record_organization_id_idx" ON "payment_record"("organization_id");

-- CreateIndex
CREATE INDEX "payment_record_appointment_id_idx" ON "payment_record"("appointment_id");

-- CreateIndex
CREATE INDEX "payment_record_recorded_by_staff_id_idx" ON "payment_record"("recorded_by_staff_id");

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
ALTER TABLE "employee_profile" ADD CONSTRAINT "employee_profile_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_service" ADD CONSTRAINT "employee_service_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "working_hours" ADD CONSTRAINT "working_hours_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "time_off" ADD CONSTRAINT "time_off_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer" ADD CONSTRAINT "customer_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consent" ADD CONSTRAINT "notification_consent_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_consent" ADD CONSTRAINT "notification_consent_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet" ADD CONSTRAINT "pet_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet" ADD CONSTRAINT "pet_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet" ADD CONSTRAINT "pet_photo_media_id_fkey" FOREIGN KEY ("photo_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccine" ADD CONSTRAINT "pet_vaccine_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccine" ADD CONSTRAINT "pet_vaccine_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccine" ADD CONSTRAINT "pet_vaccine_card_media_id_fkey" FOREIGN KEY ("card_media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_vaccine" ADD CONSTRAINT "pet_vaccine_verified_by_staff_id_fkey" FOREIGN KEY ("verified_by_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media" ADD CONSTRAINT "media_visit_id_fkey" FOREIGN KEY ("visit_id") REFERENCES "pet_visit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_category" ADD CONSTRAINT "service_category_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service" ADD CONSTRAINT "service_resource_type_id_fkey" FOREIGN KEY ("resource_type_id") REFERENCES "resource_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_price" ADD CONSTRAINT "service_price_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_price" ADD CONSTRAINT "service_price_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_type" ADD CONSTRAINT "resource_type_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource" ADD CONSTRAINT "resource_resource_type_id_fkey" FOREIGN KEY ("resource_type_id") REFERENCES "resource_type"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment" ADD CONSTRAINT "appointment_created_by_staff_id_fkey" FOREIGN KEY ("created_by_staff_id") REFERENCES "staff_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_pet_visit_id_fkey" FOREIGN KEY ("pet_visit_id") REFERENCES "pet_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_staff_user_id_fkey" FOREIGN KEY ("staff_user_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_segment" ADD CONSTRAINT "appointment_segment_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_pet_id_fkey" FOREIGN KEY ("pet_id") REFERENCES "pet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_preferred_groomer_id_fkey" FOREIGN KEY ("preferred_groomer_id") REFERENCES "staff_user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit" ADD CONSTRAINT "pet_visit_kennel_resource_id_fkey" FOREIGN KEY ("kennel_resource_id") REFERENCES "resource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit_service" ADD CONSTRAINT "pet_visit_service_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit_service" ADD CONSTRAINT "pet_visit_service_pet_visit_id_fkey" FOREIGN KEY ("pet_visit_id") REFERENCES "pet_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pet_visit_service" ADD CONSTRAINT "pet_visit_service_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_step" ADD CONSTRAINT "visit_step_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_step" ADD CONSTRAINT "visit_step_pet_visit_id_fkey" FOREIGN KEY ("pet_visit_id") REFERENCES "pet_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_step" ADD CONSTRAINT "visit_step_performed_by_staff_id_fkey" FOREIGN KEY ("performed_by_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_step" ADD CONSTRAINT "visit_step_recorded_by_staff_id_fkey" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_observation" ADD CONSTRAINT "visit_observation_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_observation" ADD CONSTRAINT "visit_observation_pet_visit_id_fkey" FOREIGN KEY ("pet_visit_id") REFERENCES "pet_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_observation" ADD CONSTRAINT "visit_observation_media_id_fkey" FOREIGN KEY ("media_id") REFERENCES "media"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_observation" ADD CONSTRAINT "visit_observation_recorded_by_staff_id_fkey" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_report" ADD CONSTRAINT "visit_report_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "visit_report" ADD CONSTRAINT "visit_report_pet_visit_id_fkey" FOREIGN KEY ("pet_visit_id") REFERENCES "pet_visit"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_record" ADD CONSTRAINT "payment_record_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_record" ADD CONSTRAINT "payment_record_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_record" ADD CONSTRAINT "payment_record_recorded_by_staff_id_fkey" FOREIGN KEY ("recorded_by_staff_id") REFERENCES "staff_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_log" ADD CONSTRAINT "notification_log_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written constraints (Prisma does not model them).
-- Spec: docs/superpowers/specs/2026-11-18-mvp-design/data-model.md,
-- "Exclusion constraints" and "Catalog".
--
-- Tenancy: every tenant table's organization_id FK above is ON DELETE RESTRICT
-- (declared in schema.prisma), which replaces the source repo's separate
-- tenancy restrict-FK migration.
--
-- Down (Prisma migrations are forward-only; to revert manually):
--   DROP INDEX IF EXISTS service_price_any_coat;
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS no_resource_overlap;
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS no_employee_overlap;
--   ALTER TABLE appointment_segment DROP CONSTRAINT IF EXISTS segment_time_order;
--   (btree_gist is left installed; it is harmless.)
--   Reverting the whole init migration means dropping the schema; on a fresh
--   database there is nothing to preserve.

CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointment_segment
  ADD CONSTRAINT segment_time_order CHECK (starts_at < ends_at AND ends_at <= block_ends_at);

-- Person segments only: kennel segments have no staff_user_id.
ALTER TABLE appointment_segment
  ADD CONSTRAINT no_employee_overlap EXCLUDE USING gist (
    staff_user_id WITH =,
    tstzrange(starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (occupies AND staff_user_id IS NOT NULL);

-- Stations and kennels (kennel segments carry the kennel's resource_id).
ALTER TABLE appointment_segment
  ADD CONSTRAINT no_resource_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (occupies AND resource_id IS NOT NULL);

-- One any-coat (NULL coat_type) price row per (service, size): the Prisma
-- unique on (service_id, size_class, coat_type) treats NULLs as distinct.
CREATE UNIQUE INDEX service_price_any_coat ON service_price (service_id, size_class) WHERE coat_type IS NULL;
