import { Controller, Get, Header, Query } from "@nestjs/common";
import { ZodValidationPipe } from "nestjs-zod";
import {
  BreedQuerySchema,
  type Breed,
  type BreedQuery,
  type PublicEmployee,
  type PublicLocation,
  type PublicServices,
} from "@grooming/contracts";
import { Public } from "../auth/decorators.js";
import { PublicService } from "./public.service.js";

const BreedQueryPipe = new ZodValidationPipe(BreedQuerySchema);

/** Unauthenticated reads for the owner booking web. */
@Controller("public")
export class PublicController {
  constructor(private readonly pub: PublicService) {}

  @Public()
  @Get("locations")
  locations(): Promise<PublicLocation[]> {
    return this.pub.locations();
  }

  @Public()
  @Get("services")
  services(): Promise<PublicServices> {
    return this.pub.services();
  }

  @Public()
  @Get("employees")
  employees(): Promise<PublicEmployee[]> {
    return this.pub.employees();
  }

  @Public()
  @Get("breeds")
  @Header("Cache-Control", "public, max-age=86400")
  breeds(@Query(BreedQueryPipe) q: BreedQuery): Breed[] {
    return this.pub.breeds(q);
  }
}
