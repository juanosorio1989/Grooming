import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  PetPatchSchema,
  StaffPetCreateSchema,
  StaffPetQuerySchema,
  VaccineInputSchema,
  VaccinePatchSchema,
  type AccessClaims,
  type PetPatch,
  type PetView,
  type StaffPetCreate,
  type StaffPetQuery,
  type VaccineInput,
  type VaccinePatch,
  type VaccineView,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { PetsService, type PetActor } from "./pets.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const QueryPipe = new ZodValidationPipe(StaffPetQuerySchema);
const CreatePipe = new ZodValidationPipe(StaffPetCreateSchema);
const PatchPipe = new ZodValidationPipe(PetPatchSchema);
const VaccineCreatePipe = new ZodValidationPipe(VaccineInputSchema);
const VaccinePatchPipe = new ZodValidationPipe(VaccinePatchSchema);

const actor = (claims: AccessClaims): PetActor => ({ type: "STAFF", claims });

/** Pets as managed by staff. EMPLOYEE callers see only pets with a segment assigned to them today (else 404). */
@Controller("staff/pets")
export class StaffPetsController {
  constructor(private readonly pets: PetsService) {}

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(@Query(QueryPipe) q: StaffPetQuery, @Principal() p: AccessClaims): Promise<PetView[]> {
    return this.pets.list(actor(p), q);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Post()
  create(@Body(CreatePipe) body: StaffPetCreate, @Principal() p: AccessClaims, @Req() req: Request): Promise<PetView> {
    return this.pets.createStaff(actor(p), body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id")
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<PetView> {
    return this.pets.get(actor(p), id);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Patch(":id")
  patch(@Param("id", IdPipe) id: string, @Body(PatchPipe) body: PetPatch, @Principal() p: AccessClaims, @Req() req: Request): Promise<PetView> {
    return this.pets.patch(actor(p), id, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id/vaccines")
  listVaccines(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<VaccineView[]> {
    return this.pets.listVaccines(actor(p), id);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Post(":id/vaccines")
  createVaccine(@Param("id", IdPipe) id: string, @Body(VaccineCreatePipe) body: VaccineInput, @Principal() p: AccessClaims, @Req() req: Request): Promise<VaccineView> {
    return this.pets.createVaccine(actor(p), id, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Patch(":id/vaccines/:vid")
  patchVaccine(
    @Param("id", IdPipe) id: string,
    @Param("vid", IdPipe) vid: string,
    @Body(VaccinePatchPipe) body: VaccinePatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<VaccineView> {
    return this.pets.patchVaccine(actor(p), id, vid, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Delete(":id/vaccines/:vid")
  @HttpCode(204)
  async removeVaccine(@Param("id", IdPipe) id: string, @Param("vid", IdPipe) vid: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.pets.removeVaccine(actor(p), id, vid, requestMeta(req).ip);
  }

  /** Sets `verifiedAt = now` and `verifiedByStaffId`. */
  @StaffAuth("OWNER", "RECEPTION")
  @Post(":id/vaccines/:vid/verify")
  @HttpCode(200)
  verify(@Param("id", IdPipe) id: string, @Param("vid", IdPipe) vid: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<VaccineView> {
    return this.pets.verifyVaccine(actor(p), id, vid, requestMeta(req).ip);
  }
}
