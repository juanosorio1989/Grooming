import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  TimeOffPatchSchema,
  TimeOffQuerySchema,
  TimeOffSchema,
  type AccessClaims,
  type TimeOffBody,
  type TimeOffItem,
  type TimeOffPatch,
  type TimeOffQuery,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { TimeOffService } from "./time-off.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(TimeOffSchema);
const PatchPipe = new ZodValidationPipe(TimeOffPatchSchema);
const QueryPipe = new ZodValidationPipe(TimeOffQuerySchema);

/** Vacations and blocks. */
@Controller("staff/time-off")
export class TimeOffController {
  constructor(private readonly timeOff: TimeOffService) {}

  /** EMPLOYEE sees only their own rows (another `staffUserId` is 403). */
  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(@Query(QueryPipe) q: TimeOffQuery, @Principal() p: AccessClaims): Promise<TimeOffItem[]> {
    return this.timeOff.list(p, q);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Post()
  create(@Body(CreatePipe) body: TimeOffBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<TimeOffItem> {
    return this.timeOff.create(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Patch(":id")
  patch(
    @Param("id", IdPipe) id: string,
    @Body(PatchPipe) body: TimeOffPatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<TimeOffItem> {
    return this.timeOff.patch(p, id, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.timeOff.remove(p, id, requestMeta(req).ip);
  }
}
