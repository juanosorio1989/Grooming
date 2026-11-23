import { Controller, Get, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiOkResponse, ApiQuery } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import { AvailabilityQuerySchema, AvailabilityResponseSchema, type AccessClaims, type AvailabilityQuery, type AvailabilityResponse } from "@grooming/contracts";
import { OptionalCustomerOrStaffAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AvailabilityService } from "./availability.service.js";

const QueryPipe = new ZodValidationPipe(AvailabilityQuerySchema);

class AvailabilityResponseDto extends createZodDto(AvailabilityResponseSchema) {}

/** Slots for anonymous visitors (inline pets), signed-in owners (saved pets too, and reschedule slots) and OWNER/RECEPTION staff (staff mode). */
@Controller("availability")
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @OptionalCustomerOrStaffAuth("OWNER", "RECEPTION")
  @Get()
  @ApiOkResponse({ type: AvailabilityResponseDto })
  @ApiQuery({ name: "from", required: false, description: "First date (YYYY-MM-DD)" })
  @ApiQuery({ name: "to", required: false, description: "Last date (YYYY-MM-DD)" })
  @ApiQuery({ name: "pets", required: false, description: "URL-encoded JSON array of pets (petId or inline species, sizeClass, coatType; services; preferredGroomerId). Required unless excludeAppointmentId is sent" })
  @ApiQuery({ name: "excludeAppointmentId", required: false, description: "Reschedule: a BOOKED appointment of the signed-in customer (staff: of the organization); its pets are used and its own segments are not busy" })
  @ApiQuery({ name: "customerId", required: false, description: "Staff only (else 403): the customer whose saved pets (petId) are used; required with a petId, 400 with excludeAppointmentId" })
  @ApiQuery({ name: "override", required: false, enum: ["true", "false"], description: "Staff only (else 403): ignore working hours, location hours and drop-off windows" })
  find(
    @Query(QueryPipe) q: AvailabilityQuery,
    @Principal() principal: AccessClaims | undefined,
    @Req() req: Request,
  ): Promise<AvailabilityResponse> {
    return this.availability.find(q, principal, requestMeta(req).ip ?? "unknown");
  }
}
