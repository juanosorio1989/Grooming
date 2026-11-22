import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiOkResponse, ApiQuery } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import { AvailabilityQuerySchema, AvailabilityResponseSchema, type AccessClaims, type AvailabilityQuery, type AvailabilityResponse } from "@grooming/contracts";
import { OptionalCustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AvailabilityService } from "./availability.service.js";

const QueryPipe = new ZodValidationPipe(AvailabilityQuerySchema);

class AvailabilityResponseDto extends createZodDto(AvailabilityResponseSchema) {}

/** Online slots for anonymous visitors (inline pets) and signed-in owners (saved pets too). */
@Controller("availability")
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @OptionalCustomerAuth()
  @Get()
  @ApiOkResponse({ type: AvailabilityResponseDto })
  @ApiQuery({ name: "from", required: false, description: "First date (YYYY-MM-DD)" })
  @ApiQuery({ name: "to", required: false, description: "Last date (YYYY-MM-DD)" })
  @ApiQuery({ name: "pets", required: true, description: "URL-encoded JSON array of pets (petId or inline species, sizeClass, coatType; services; preferredGroomerId)" })
  find(
    @Query(QueryPipe) q: AvailabilityQuery,
    @Principal() principal: AccessClaims | undefined,
    @Req() req: Request,
  ): Promise<AvailabilityResponse> {
    return this.availability.find(q, principal, requestMeta(req).ip ?? "unknown");
  }
}
