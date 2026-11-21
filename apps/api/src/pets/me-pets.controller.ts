import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  PetInputSchema,
  PetPatchSchema,
  VaccineInputSchema,
  VaccinePatchSchema,
  type AccessClaims,
  type PetInput,
  type PetPatch,
  type PetView,
  type VaccineInput,
  type VaccinePatch,
  type VaccineView,
} from "@grooming/contracts";
import { CustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { PetsService, type PetActor } from "./pets.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(PetInputSchema);
const PatchPipe = new ZodValidationPipe(PetPatchSchema);
const VaccineCreatePipe = new ZodValidationPipe(VaccineInputSchema);
const VaccinePatchPipe = new ZodValidationPipe(VaccinePatchSchema);

const actor = (claims: AccessClaims): PetActor => ({ type: "CUSTOMER", claims });

/** The signed-in customer's own pets and vaccines; anything else is 404. */
@Controller("me/pets")
export class MePetsController {
  constructor(private readonly pets: PetsService) {}

  @CustomerAuth()
  @Get()
  list(@Principal() p: AccessClaims): Promise<PetView[]> {
    return this.pets.list(actor(p), {});
  }

  @CustomerAuth()
  @Post()
  create(@Body(CreatePipe) body: PetInput, @Principal() p: AccessClaims, @Req() req: Request): Promise<PetView> {
    return this.pets.create(actor(p), p.sub, body, requestMeta(req).ip);
  }

  @CustomerAuth()
  @Get(":id")
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<PetView> {
    return this.pets.get(actor(p), id);
  }

  @CustomerAuth()
  @Patch(":id")
  patch(@Param("id", IdPipe) id: string, @Body(PatchPipe) body: PetPatch, @Principal() p: AccessClaims, @Req() req: Request): Promise<PetView> {
    return this.pets.patch(actor(p), id, body, requestMeta(req).ip);
  }

  /** Soft delete. */
  @CustomerAuth()
  @Delete(":id")
  @HttpCode(204)
  async remove(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.pets.remove(actor(p), id, requestMeta(req).ip);
  }

  @CustomerAuth()
  @Get(":id/vaccines")
  listVaccines(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<VaccineView[]> {
    return this.pets.listVaccines(actor(p), id);
  }

  @CustomerAuth()
  @Post(":id/vaccines")
  createVaccine(@Param("id", IdPipe) id: string, @Body(VaccineCreatePipe) body: VaccineInput, @Principal() p: AccessClaims, @Req() req: Request): Promise<VaccineView> {
    return this.pets.createVaccine(actor(p), id, body, requestMeta(req).ip);
  }

  /** Clears the staff verification of the vaccine. */
  @CustomerAuth()
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

  @CustomerAuth()
  @Delete(":id/vaccines/:vid")
  @HttpCode(204)
  async removeVaccine(@Param("id", IdPipe) id: string, @Param("vid", IdPipe) vid: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    await this.pets.removeVaccine(actor(p), id, vid, requestMeta(req).ip);
  }
}
