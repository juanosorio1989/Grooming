import { Body, Controller, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiCreatedResponse } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import { AppointmentCreateSchema, AppointmentViewSchema, type AccessClaims, type AppointmentCreate, type AppointmentView } from "@grooming/contracts";
import { CustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AppointmentsService } from "./appointments.service.js";

const CreatePipe = new ZodValidationPipe(AppointmentCreateSchema);

class AppointmentViewDto extends createZodDto(AppointmentViewSchema) {}

/** Owner bookings (customer tokens only). */
@Controller("appointments")
export class AppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  /** Confirms a hold into a booking. */
  @CustomerAuth()
  @Post()
  @ApiCreatedResponse({ type: AppointmentViewDto })
  confirm(@Body(CreatePipe) body: AppointmentCreate, @Principal() p: AccessClaims, @Req() req: Request): Promise<AppointmentView> {
    return this.appointments.confirm(p, body, requestMeta(req).ip);
  }
}
