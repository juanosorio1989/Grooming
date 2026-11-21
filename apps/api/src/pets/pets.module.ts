import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { MePetsController } from "./me-pets.controller.js";
import { PetMergeService } from "./pet-merge.service.js";
import { PetAccessService } from "./pet-access.service.js";
import { PetsService } from "./pets.service.js";
import { StaffPetsController } from "./staff-pets.controller.js";

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [StaffPetsController, MePetsController],
  providers: [PetsService, PetAccessService, PetMergeService],
  exports: [PetsService, PetAccessService],
})
export class PetsModule {}
