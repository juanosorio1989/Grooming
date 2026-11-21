import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { ResourceTypesController } from "./resource-types.controller.js";
import { ResourcesController } from "./resources.controller.js";
import { ResourcesService } from "./resources.service.js";

@Module({ imports: [AuditModule], controllers: [ResourceTypesController, ResourcesController], providers: [ResourcesService] })
export class ResourcesModule {}
