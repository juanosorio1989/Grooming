import { Controller, HttpCode, Param, Post, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import { IdSchema, type AccessClaims } from "@grooming/contracts";
import { Principal, StaffAuth } from "../decorators.js";
import { requestMeta } from "../request-meta.js";
import { StaffLinksService } from "./staff-links.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);

/** OWNER-only actions on other staff members' credentials. `:id` must be a UUID (400 otherwise). */
@Controller("staff/employees")
export class StaffAdminController {
  constructor(private readonly links: StaffLinksService) {}

  /** Emails a 72 h invite link. 404 outside the org; 409 without email or with a password already set. */
  @StaffAuth("OWNER")
  @Post(":id/invite")
  @HttpCode(204)
  @ApiNoContentResponse()
  async invite(
    @Param("id", IdPipe) id: string,
    @Principal() owner: AccessClaims,
    @Req() req: Request,
  ): Promise<void> {
    await this.links.inviteByOwner(owner, id, requestMeta(req).ip);
  }

  /** Clears TOTP and recovery codes and revokes sessions. 403 on yourself; 404 outside the org. */
  @StaffAuth("OWNER")
  @Post(":id/reset-2fa")
  @HttpCode(204)
  @ApiNoContentResponse()
  async reset2fa(
    @Param("id", IdPipe) id: string,
    @Principal() owner: AccessClaims,
    @Req() req: Request,
  ): Promise<void> {
    await this.links.reset2faByOwner(owner, id, requestMeta(req).ip);
  }
}
