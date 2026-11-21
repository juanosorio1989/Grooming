import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  PriceMatrixSchema,
  ServicePatchSchema,
  ServiceQuerySchema,
  ServiceSchema,
  type AccessClaims,
  type PriceMatrix,
  type ServiceBody,
  type ServicePatch,
  type ServicePriceRow,
  type ServiceQuery,
  type ServiceView,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { CatalogService } from "./catalog.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(ServiceSchema);
const PatchPipe = new ZodValidationPipe(ServicePatchSchema);
const QueryPipe = new ZodValidationPipe(ServiceQuerySchema);
const MatrixPipe = new ZodValidationPipe(PriceMatrixSchema);

/** Services and their size x coat price matrix. */
@Controller("staff/services")
export class ServicesController {
  constructor(private readonly catalog: CatalogService) {}

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(@Query(QueryPipe) q: ServiceQuery): Promise<ServiceView[]> {
    return this.catalog.listServices(q);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id")
  get(@Param("id", IdPipe) id: string): Promise<ServiceView> {
    return this.catalog.getService(id);
  }

  @StaffAuth("OWNER")
  @Post()
  create(@Body(CreatePipe) body: ServiceBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<ServiceView> {
    return this.catalog.createService(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Patch(":id")
  patch(@Param("id", IdPipe) id: string, @Body(PatchPipe) body: ServicePatch, @Principal() p: AccessClaims, @Req() req: Request): Promise<ServiceView> {
    return this.catalog.patchService(p, id, body, requestMeta(req).ip);
  }

  /** Deactivates (`active = false`); never hard-deletes. */
  @StaffAuth("OWNER")
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.catalog.deactivateService(p, id, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id/prices")
  prices(@Param("id", IdPipe) id: string): Promise<ServicePriceRow[]> {
    return this.catalog.getPrices(id);
  }

  /** Replaces all rows in one transaction. */
  @StaffAuth("OWNER")
  @Put(":id/prices")
  replacePrices(@Param("id", IdPipe) id: string, @Body(MatrixPipe) body: PriceMatrix, @Principal() p: AccessClaims, @Req() req: Request): Promise<ServicePriceRow[]> {
    return this.catalog.replacePrices(p, id, body, requestMeta(req).ip);
  }
}
