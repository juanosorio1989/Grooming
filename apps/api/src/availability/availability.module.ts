import { Module } from "@nestjs/common";
import { BookingModule } from "../booking/booking.module.js";
import { AvailabilityController } from "./availability.controller.js";
import { AvailabilityService } from "./availability.service.js";
import { AvailabilityContextLoader } from "./context-loader.js";

@Module({
  imports: [BookingModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityContextLoader, AvailabilityService],
  exports: [AvailabilityContextLoader],
})
export class AvailabilityModule {}
