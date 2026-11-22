-- CreateEnum
CREATE TYPE "identity_provider" AS ENUM ('GOOGLE');

-- CreateTable
CREATE TABLE "customer_identity" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "provider" "identity_provider" NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_identity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_event" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ(3),

    CONSTRAINT "outbox_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_identity_organization_id_provider_subject_key" ON "customer_identity"("organization_id", "provider", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "customer_identity_organization_id_customer_id_provider_key" ON "customer_identity"("organization_id", "customer_id", "provider");

-- CreateIndex
CREATE INDEX "outbox_event_processed_at_created_at_idx" ON "outbox_event"("processed_at", "created_at");

-- CreateIndex
CREATE INDEX "outbox_event_organization_id_idx" ON "outbox_event"("organization_id");

-- AddForeignKey
ALTER TABLE "customer_identity" ADD CONSTRAINT "customer_identity_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_identity" ADD CONSTRAINT "customer_identity_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_event" ADD CONSTRAINT "outbox_event_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
