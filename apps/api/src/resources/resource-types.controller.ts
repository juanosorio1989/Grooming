import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  ResourceTypePatchSchema,
  ResourceTypeSchema,
  type AccessClaims,
  type ResourceTypeBody,
  type ResourceTypeItem,
  type ResourceTypePatch,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { ResourcesService } from "./resources.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(ResourceTypeSchema);
const PatchPipe = new ZodValidationPipe(ResourceTypePatchSchema);

/** Resource types (tub, kennel, ...). */
@Controller("staff/resource-types")
export class ResourceTypesController {
  constructor(private readonly resources: ResourcesService) {}

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(): Promise<ResourceTypeItem[]> {
    return this.resources.listTypes();
  }

  @StaffAuth("OWNER")
  @Post()
  create(@Body(CreatePipe) body: ResourceTypeBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<ResourceTypeItem> {
    return this.resources.createType(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Patch(":id")
  patch(
    @Param("id", IdPipe) id: string,
    @Body(PatchPipe) body: ResourceTypePatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<ResourceTypeItem> {
    return this.resources.patchType(p, id, body, requestMeta(req).ip);
  }

  /** 409 IN_USE when a resource or service references the type. */
  @StaffAuth("OWNER")
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.resources.deleteType(p, id, requestMeta(req).ip);
  }
}
