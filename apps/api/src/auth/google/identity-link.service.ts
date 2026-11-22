import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AuditService } from "../../audit/audit.service.js";

export type LinkOutcome = "LINKED" | "ALREADY_LINKED" | "TAKEN";

export interface LinkArgs {
  orgId: string;
  customerId: string;
  /** Google `sub`. Never logged or audited. */
  sub: string;
  email: string;
  name: string | null;
  /** True when the customer existed before this request: write the `customer.identity_linked` outbox row. */
  notify: boolean;
  actorIp: string | null;
}

export const IDENTITY_LINKED_EVENT = "customer.identity_linked";

/**
 * Links a Google account to a customer. One Google account per customer and
 * one customer per Google account in each organization; both rules are also
 * unique indexes on `customer_identity`.
 */
@Injectable()
export class IdentityLinkService {
  constructor(private readonly audit: AuditService) {}

  /**
   * Runs inside the caller's transaction. Links (orgId, GOOGLE, sub) to customerId unless the sub belongs to another
   * customer or the customer has another Google account (TAKEN). LINKED: sets customer.email from Google only when it is
   * null, sets customer.name only when it is null, writes audit auth.customer.identity_linked {provider:"GOOGLE"} and,
   * when notify is true, the outbox row. ALREADY_LINKED: refreshes identity.email only.
   */
  async linkInTx(tx: Prisma.TransactionClient, args: LinkArgs): Promise<LinkOutcome> {
    const { orgId, customerId, sub, email, name } = args;

    const bySub = await tx.customerIdentity.findUnique({
      where: { organizationId_provider_subject: { organizationId: orgId, provider: "GOOGLE", subject: sub } },
      select: { id: true, customerId: true },
    });
    if (bySub) {
      if (bySub.customerId !== customerId) return "TAKEN";
      await tx.customerIdentity.update({ where: { id: bySub.id }, data: { email } });
      return "ALREADY_LINKED";
    }
    const other = await tx.customerIdentity.findUnique({
      where: { organizationId_customerId_provider: { organizationId: orgId, customerId, provider: "GOOGLE" } },
      select: { id: true },
    });
    if (other) return "TAKEN";

    // Read before the link sets it: the notice must never go to the address of whoever linked.
    const customer = await tx.customer.findFirst({
      where: { id: customerId, organizationId: orgId },
      select: { email: true },
    });
    if (!customer) return "TAKEN";

    // ON CONFLICT DO NOTHING (any unique index): a lost race gives count 0 instead of a P2002,
    // which would abort the whole Postgres transaction.
    const { count } = await tx.customerIdentity.createMany({
      data: [{ organizationId: orgId, customerId, provider: "GOOGLE", subject: sub, email }],
      skipDuplicates: true,
    });
    if (count === 0) return "TAKEN";

    await tx.customer.updateMany({ where: { id: customerId, organizationId: orgId, email: null }, data: { email } });
    if (name) {
      await tx.customer.updateMany({ where: { id: customerId, organizationId: orgId, name: null }, data: { name } });
    }
    await this.audit.record(
      {
        orgId,
        actorType: "CUSTOMER",
        actorId: customerId,
        action: "auth.customer.identity_linked",
        entity: "customer",
        entityId: customerId,
        after: { provider: "GOOGLE" },
        ip: args.actorIp,
      },
      tx,
    );
    if (args.notify) {
      await tx.outboxEvent.create({
        data: {
          organizationId: orgId,
          type: IDENTITY_LINKED_EVENT,
          payload: { customerId, googleEmail: email, notifyEmail: customer.email },
        },
      });
    }
    return "LINKED";
  }
}
