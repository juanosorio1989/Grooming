import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  ResourcePatchSchema,
  ResourceQuerySchema,
  ResourceSchema,
  type AccessClaims,
  type ResourceBody,
  type ResourceItem,
  type ResourcePatch,
  type ResourceQuery,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { ResourcesService } from "./resources.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(ResourceSchema);
const PatchPipe = new ZodValidationPipe(ResourcePatchSchema);
const QueryPipe = new ZodValidationPipe(ResourceQuerySchema);

/** Stations and kennels of the default location. */
@Controller("staff/resources")
export class ResourcesController {
  constructor(private readonly resources: ResourcesService) {}

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(@Query(QueryPipe) q: ResourceQuery): Promise<ResourceItem[]> {
    return this.resources.list(q);
  }

  @StaffAuth("OWNER")
  @Post()
  create(@Body(CreatePipe) body: ResourceBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<ResourceItem> {
    return this.resources.create(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Patch(":id")
  patch(
    @Param("id", IdPipe) id: string,
    @Body(PatchPipe) body: ResourcePatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<ResourceItem> {
    return this.resources.patch(p, id, body, requestMeta(req).ip);
  }

  /** Deactivates (`active = false`); never hard-deletes. */
  @StaffAuth("OWNER")
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.resources.deactivate(p, id, requestMeta(req).ip);
  }
}
