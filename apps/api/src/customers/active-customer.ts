import { UnauthorizedException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service.js";

/**
 * 401 UNAUTHORIZED when the customer is missing, soft-deleted or in another
 * organization (a customer token outlives `DELETE /me` until it expires).
 * With a transaction client and `lock`, takes `FOR SHARE` (`FOR UPDATE` for
 * "update") on the row, so a concurrent delete waits for the caller's
 * transaction (or the caller waits for it, then sees `deleted_at`).
 */
export async function assertActiveCustomer(
  db: PrismaService | Prisma.TransactionClient,
  orgId: string,
  customerId: string,
  lock?: "share" | "update",
): Promise<void> {
  let found: boolean;
  if (lock) {
    const mode = lock === "update" ? Prisma.sql`FOR UPDATE` : Prisma.sql`FOR SHARE`;
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM customer
      WHERE id = ${customerId}::uuid AND organization_id = ${orgId}::uuid AND deleted_at IS NULL
      ${mode}`;
    found = rows.length > 0;
  } else {
    const row = await db.customer.findFirst({ where: { id: customerId, organizationId: orgId, deletedAt: null }, select: { id: true } });
    found = row !== null;
  }
  if (!found) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
}
