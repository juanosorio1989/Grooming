import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { BookingApiModule } from "../booking/booking-api.module.js";
import { BookingModule } from "../booking/booking.module.js";
import { PetsModule } from "../pets/pets.module.js";
import { AccountService } from "./account.service.js";
import { CustomersService } from "./customers.service.js";
import { MeController } from "./me.controller.js";
import { StaffCustomersController } from "./staff-customers.controller.js";

/**
 * Customer profiles, the owner's `/me` routes, export and account deletion.
 * Imports the booking modules for `AccountService` (cancel bookings, release holds);
 * neither booking module imports this one, so there is no cycle.
 */
@Module({
  imports: [AuditModule, AuthModule, PetsModule, BookingModule, BookingApiModule],
  controllers: [StaffCustomersController, MeController],
  providers: [CustomersService, AccountService],
  exports: [CustomersService],
})
export class CustomersModule {}
