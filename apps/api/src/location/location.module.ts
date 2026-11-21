import { Global, Module } from "@nestjs/common";
import { LocationService } from "./location.service.js";

@Global()
@Module({ providers: [LocationService], exports: [LocationService] })
export class LocationModule {}
