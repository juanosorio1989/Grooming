import { Controller, Get, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import { AuditQuerySchema, type AuditPage, type AuditQuery } from "@grooming/contracts";
import { StaffAuth } from "../auth/decorators.js";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AuditService } from "./audit.service.js";

const QueryPipe = new ZodValidationPipe(AuditQuerySchema);

/** OWNER-only reader for `audit_log`. */
@Controller("staff/audit")
export class AuditController {
  constructor(
    private readonly audit: AuditService,
    private readonly tenancy: TenancyService,
  ) {}

  @StaffAuth("OWNER")
  @Get()
  async list(@Query(QueryPipe) query: AuditQuery): Promise<AuditPage> {
    return this.audit.list(await this.tenancy.getOrgId(), query);
  }
}
