import { Module } from "@nestjs/common";
import { AvailabilityController } from "./availability.controller.js";
import { AvailabilityService } from "./availability.service.js";
import { AvailabilityContextLoader } from "./context-loader.js";

@Module({
  controllers: [AvailabilityController],
  providers: [AvailabilityContextLoader, AvailabilityService],
  exports: [AvailabilityContextLoader],
})
export class AvailabilityModule {}
