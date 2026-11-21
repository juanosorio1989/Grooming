import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { CustomersService } from "./customers.service.js";
import { MeController } from "./me.controller.js";
import { StaffCustomersController } from "./staff-customers.controller.js";

@Module({
  imports: [AuditModule, AuthModule],
  controllers: [StaffCustomersController, MeController],
  providers: [CustomersService],
  exports: [CustomersService],
})
export class CustomersModule {}
