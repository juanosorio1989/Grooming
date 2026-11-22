import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import { AvailabilityQuerySchema, type AccessClaims, type AvailabilityQuery, type AvailabilityResponse } from "@grooming/contracts";
import { OptionalCustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AvailabilityService } from "./availability.service.js";

const QueryPipe = new ZodValidationPipe(AvailabilityQuerySchema);

/** Online slots for anonymous visitors (inline pets) and signed-in owners (saved pets too). */
@Controller("availability")
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @OptionalCustomerAuth()
  @Get()
  find(
    @Query(QueryPipe) q: AvailabilityQuery,
    @Principal() principal: AccessClaims | undefined,
    @Req() req: Request,
  ): Promise<AvailabilityResponse> {
    return this.availability.find(q, principal, requestMeta(req).ip ?? "unknown");
  }
}
