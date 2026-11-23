import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

/** Most expired holds released per call; the sweeper and the next write pick up the rest. */
const BATCH = 500;

/**
 * Ends holds: the appointment becomes CANCELLED (with time, reason and actor),
 * its segments stop occupying (`occupies = false`), its visits become
 * CANCELLED and their pending pets keep only `ref` and `species`, all in the
 * caller's transaction.
 */
@Injectable()
export class HoldReleaseService {
  /**
   * HELD appointments with holdExpiresAt <= now (optionally one org): status
   * CANCELLED, cancelledAt now, cancelReason "HOLD_EXPIRED", cancelledBy
   * SYSTEM; their segments occupies=false; their visits CANCELLED, pending pets
   * cut to `{ ref, species }`. Picks rows
   * with FOR UPDATE SKIP LOCKED (a hold being confirmed or released elsewhere
   * is skipped), at most 500 per call. Returns the count.
   */
  async releaseExpired(tx: Prisma.TransactionClient, now: Date, orgId?: string): Promise<number> {
    const org = orgId === undefined ? Prisma.empty : Prisma.sql`AND organization_id = ${orgId}::uuid`;
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM appointment
      WHERE status = 'HELD' AND hold_expires_at <= ${now} ${org}
      ORDER BY hold_expires_at
      LIMIT ${BATCH}
      FOR UPDATE SKIP LOCKED`;
    if (rows.length === 0) return 0;
    const ids = rows.map((r) => r.id);
    const { count } = await tx.appointment.updateMany({
      where: { id: { in: ids }, status: "HELD" },
      data: { status: "CANCELLED", cancelledAt: now, cancelReason: "HOLD_EXPIRED", cancelledBy: "SYSTEM" },
    });
    await this.freeRows(tx, ids);
    return count;
  }

  /** Same changes for one HELD appointment, with the given reason and actor. False when it was not HELD. */
  async release(
    tx: Prisma.TransactionClient,
    appointmentId: string,
    reason: "HOLD_EXPIRED" | "HOLD_RELEASED",
    by: "SYSTEM" | "CUSTOMER",
  ): Promise<boolean> {
    // The conditional update locks the row and re-checks HELD, so two releases cannot both win.
    const { count } = await tx.appointment.updateMany({
      where: { id: appointmentId, status: "HELD" },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason, cancelledBy: by },
    });
    if (count === 0) return false;
    await this.freeRows(tx, [appointmentId]);
    return true;
  }

  /**
   * Segments stop occupying, visits become CANCELLED, and each `pending_pet` is
   * cut down to `{ ref, species }`: a released hold is never read again (only
   * HELD holds are viewed or confirmed), so the name, breed and weight a visitor
   * typed are not kept. The column stays non-null, so the visit CHECK still holds.
   */
  private async freeRows(tx: Prisma.TransactionClient, appointmentIds: string[]): Promise<void> {
    await tx.appointmentSegment.updateMany({ where: { appointmentId: { in: appointmentIds } }, data: { occupies: false } });
    await tx.petVisit.updateMany({ where: { appointmentId: { in: appointmentIds } }, data: { status: "CANCELLED" } });
    await tx.$executeRaw`
      UPDATE pet_visit SET pending_pet = jsonb_build_object('ref', pending_pet->'ref', 'species', pending_pet->'species')
      WHERE appointment_id IN (${Prisma.join(appointmentIds.map((id) => Prisma.sql`${id}::uuid`))})
        AND jsonb_typeof(pending_pet) = 'object'`;
  }
}
