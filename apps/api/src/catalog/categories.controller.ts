import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import { CategoryPatchSchema, CategorySchema, IdSchema, type AccessClaims, type CategoryBody, type CategoryItem, type CategoryPatch } from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { CatalogService } from "./catalog.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(CategorySchema);
const PatchPipe = new ZodValidationPipe(CategoryPatchSchema);

/** Service categories. */
@Controller("staff/categories")
export class CategoriesController {
  constructor(private readonly catalog: CatalogService) {}

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(): Promise<CategoryItem[]> {
    return this.catalog.listCategories();
  }

  @StaffAuth("OWNER")
  @Post()
  create(@Body(CreatePipe) body: CategoryBody, @Principal() p: AccessClaims, @Req() req: Request): Promise<CategoryItem> {
    return this.catalog.createCategory(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Patch(":id")
  patch(@Param("id", IdPipe) id: string, @Body(PatchPipe) body: CategoryPatch, @Principal() p: AccessClaims, @Req() req: Request): Promise<CategoryItem> {
    return this.catalog.patchCategory(p, id, body, requestMeta(req).ip);
  }

  /** Hard delete; services keep `categoryId = null`. */
  @StaffAuth("OWNER")
  @Delete(":id")
  @HttpCode(204)
  @ApiNoContentResponse()
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.catalog.deleteCategory(p, id, requestMeta(req).ip);
  }
}
