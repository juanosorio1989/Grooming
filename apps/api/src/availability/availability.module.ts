import { Module } from "@nestjs/common";
import { AvailabilityContextLoader } from "./context-loader.js";

@Module({ providers: [AvailabilityContextLoader], exports: [AvailabilityContextLoader] })
export class AvailabilityModule {}
