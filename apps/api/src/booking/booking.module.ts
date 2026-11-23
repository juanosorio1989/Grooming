import { Module } from "@nestjs/common";
import { HoldReleaseService } from "./hold-release.service.js";
import { PetRequestResolver } from "./pet-requests.js";
import { PlanWriter } from "./plan-writer.js";

/** Booking write path. The shared core (pet resolver, plan writer, hold release) is exported for `/availability`. */
@Module({
  providers: [PetRequestResolver, PlanWriter, HoldReleaseService],
  exports: [PetRequestResolver, PlanWriter, HoldReleaseService],
})
export class BookingModule {}
