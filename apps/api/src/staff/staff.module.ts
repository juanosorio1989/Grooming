import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesService } from "./employees.service.js";
import { TimeOffController } from "./time-off.controller.js";
import { TimeOffService } from "./time-off.service.js";

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [EmployeesController, TimeOffController],
  providers: [EmployeesService, TimeOffService],
})
export class StaffModule {}
