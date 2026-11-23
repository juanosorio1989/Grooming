import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module.js";
import { AvailabilityModule } from "../availability/availability.module.js";
import { PetsModule } from "../pets/pets.module.js";
import { AppointmentsController } from "./appointments.controller.js";
import { AppointmentsService } from "./appointments.service.js";
import { BookingModule } from "./booking.module.js";
import { HoldSweeper } from "./hold-sweeper.js";
import { HoldsController } from "./holds.controller.js";
import { HoldsService } from "./holds.service.js";
import { MeAppointmentsController } from "./me-appointments.controller.js";
import { StaffAppointmentsController, StaffWalkInController } from "./staff-appointments.controller.js";
import { StaffAppointmentsService } from "./staff-appointments.service.js";

/**
 * Booking routes (holds, confirm, owner appointments, staff bookings and walk-in). Kept apart
 * from `BookingModule` (the core), which `AvailabilityModule` imports, so this
 * module can use the availability context loader without an import cycle.
 */
@Module({
  imports: [BookingModule, AvailabilityModule, PetsModule, AuditModule],
  controllers: [HoldsController, AppointmentsController, MeAppointmentsController, StaffAppointmentsController, StaffWalkInController],
  providers: [HoldsService, HoldSweeper, AppointmentsService, StaffAppointmentsService],
  exports: [HoldsService, AppointmentsService],
})
export class BookingApiModule {}
