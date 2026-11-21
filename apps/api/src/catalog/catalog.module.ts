import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { CatalogService } from "./catalog.service.js";
import { CategoriesController } from "./categories.controller.js";
import { ServicesController } from "./services.controller.js";

@Module({ imports: [AuditModule], controllers: [CategoriesController, ServicesController], providers: [CatalogService] })
export class CatalogModule {}
