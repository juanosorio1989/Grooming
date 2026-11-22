import { Body, Controller, Get, Patch, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import { MePatchSchema, type AccessClaims, type MeView, type MePatch } from "@grooming/contracts";
import { CustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { CustomersService } from "./customers.service.js";

const PatchPipe = new ZodValidationPipe(MePatchSchema);

/** The signed-in customer's own profile (never includes private notes). */
@Controller("me")
export class MeController {
  constructor(private readonly customers: CustomersService) {}

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
}
