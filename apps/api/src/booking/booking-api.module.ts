import { Module } from "@nestjs/common";
import { AvailabilityModule } from "../availability/availability.module.js";
import { BookingModule } from "./booking.module.js";
import { HoldSweeper } from "./hold-sweeper.js";
import { HoldsController } from "./holds.controller.js";
import { HoldsService } from "./holds.service.js";

/**
 * Booking routes (holds now; confirm, owner and staff writes later). Kept apart
 * from `BookingModule` (the core), which `AvailabilityModule` imports, so this
 * module can use the availability context loader without an import cycle.
 */
@Module({
  imports: [BookingModule, AvailabilityModule],
  controllers: [HoldsController],
  providers: [HoldsService, HoldSweeper],
  exports: [HoldsService],
})
export class BookingApiModule {}
