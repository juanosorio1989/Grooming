import { Body, Controller, Delete, Get, HttpCode, Param, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiCreatedResponse, ApiNoContentResponse, ApiOkResponse } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import {
  HoldRequestSchema,
  HoldResponseSchema,
  HoldViewSchema,
  IdSchema,
  type AccessClaims,
  type HoldRequest,
  type HoldResponse,
  type HoldView,
} from "@grooming/contracts";
import { OptionalCustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { HoldsService } from "./holds.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const BodyPipe = new ZodValidationPipe(HoldRequestSchema);

class HoldResponseDto extends createZodDto(HoldResponseSchema) {}
class HoldViewDto extends createZodDto(HoldViewSchema) {}

/** Slot holds for anonymous visitors and signed-in owners (staff tokens are 403). */
@Controller("holds")
export class HoldsController {
  constructor(private readonly holds: HoldsService) {}

  @OptionalCustomerAuth()
  @Post()
  @ApiCreatedResponse({ type: HoldResponseDto })
  create(@Body(BodyPipe) body: HoldRequest, @Principal() principal: AccessClaims | undefined, @Req() req: Request): Promise<HoldResponse> {
    return this.holds.create(body, principal, requestMeta(req).ip ?? "unknown");
  }

  @OptionalCustomerAuth()
  @Get(":id")
  @ApiOkResponse({ type: HoldViewDto })
  view(@Param("id", IdPipe) id: string, @Principal() principal: AccessClaims | undefined): Promise<HoldView> {
    return this.holds.view(id, principal);
  }

  @OptionalCustomerAuth()
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async cancel(@Param("id", IdPipe) id: string, @Principal() principal: AccessClaims | undefined): Promise<void> {
    await this.holds.cancel(id, principal);
  }
}
