import { Body, Controller, Delete, Get, HttpCode, Patch, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import { MePatchSchema, type AccessClaims, type MeExport, type MeView, type MePatch } from "@grooming/contracts";
import { CustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AccountService } from "./account.service.js";
import { CustomersService } from "./customers.service.js";

const PatchPipe = new ZodValidationPipe(MePatchSchema);

/** The signed-in customer's own profile (never includes private notes), data export and account deletion. */
@Controller("me")
export class MeController {
  constructor(
    private readonly customers: CustomersService,
    private readonly account: AccountService,
  ) {}

  @CustomerAuth()
  @Get()
  get(@Principal() p: AccessClaims): Promise<MeView> {
    return this.customers.getMe(p);
  }

  @CustomerAuth()
  @Patch()
  patch(@Body(PatchPipe) body: MePatch, @Principal() p: AccessClaims, @Req() req: Request): Promise<MeView> {
    return this.customers.patchMe(p, body, requestMeta(req).ip);
  }

  /** Everything the shop holds about the customer. 5 per hour per customer (429 after). */
  @CustomerAuth()
  @Get("export")
  export(@Principal() p: AccessClaims): Promise<MeExport> {
    return this.account.export(p);
  }

  /** Irreversible: anonymizes the customer, their pets and identities and cancels future bookings. */
  @CustomerAuth()
  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse()
  delete(@Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    return this.account.delete(p, requestMeta(req).ip);
  }
}
