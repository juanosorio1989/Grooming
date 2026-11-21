import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  ClosureQuerySchema,
  ClosureSchema,
  IdSchema,
  LocationHoursListSchema,
  SettingsPatchBodySchema,
  type AccessClaims,
  type Closure,
  type ClosureItem,
  type ClosureQuery,
  type LocationHours,
  type SettingsPatchBody,
  type SettingsView,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { SettingsService } from "./settings.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const PatchPipe = new ZodValidationPipe(SettingsPatchBodySchema);
const HoursPipe = new ZodValidationPipe(LocationHoursListSchema);
const ClosurePipe = new ZodValidationPipe(ClosureSchema);
const ClosureQueryPipe = new ZodValidationPipe(ClosureQuerySchema);

/** Location settings, weekly hours and closures. */
@Controller("staff")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @StaffAuth("OWNER", "RECEPTION")
  @Get("settings")
  get(): Promise<SettingsView> {
    return this.settings.view();
  }

  @StaffAuth("OWNER")
  @Patch("settings")
  patch(@Body(PatchPipe) body: SettingsPatchBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<SettingsView> {
    return this.settings.patch(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Put("settings/hours")
  putHours(@Body(HoursPipe) body: LocationHours[], @Principal() p: AccessClaims, @Req() req: Request): Promise<LocationHours[]> {
    return this.settings.replaceHours(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Get("closures")
  listClosures(@Query(ClosureQueryPipe) q: ClosureQuery): Promise<ClosureItem[]> {
    return this.settings.listClosures(q);
  }

  @StaffAuth("OWNER")
  @Post("closures")
  createClosure(@Body(ClosurePipe) body: Closure, @Principal() p: AccessClaims, @Req() req: Request): Promise<ClosureItem> {
    return this.settings.createClosure(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Delete("closures/:id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async deleteClosure(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.settings.deleteClosure(p, id, requestMeta(req).ip);
  }
}
