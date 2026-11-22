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

/**
 * Booking routes (holds and confirm now; owner and staff writes later). Kept apart
 * from `BookingModule` (the core), which `AvailabilityModule` imports, so this
 * module can use the availability context loader without an import cycle.
 */
@Module({
  imports: [BookingModule, AvailabilityModule, PetsModule, AuditModule],
  controllers: [HoldsController, AppointmentsController],
  providers: [HoldsService, HoldSweeper, AppointmentsService],
  exports: [HoldsService, AppointmentsService],
})
export class BookingApiModule {}
