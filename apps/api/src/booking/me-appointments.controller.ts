import { Body, Controller, Get, HttpCode, Param, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiOkResponse } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import {
  AppointmentViewSchema,
  IdSchema,
  MeAppointmentsQuerySchema,
  RescheduleSchema,
  type AccessClaims,
  type AppointmentView,
  type MeAppointmentsQuery,
  type Reschedule,
} from "@grooming/contracts";
import { CustomerAuth, Principal } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { AppointmentsService } from "./appointments.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const QueryPipe = new ZodValidationPipe(MeAppointmentsQuerySchema);
const ReschedulePipe = new ZodValidationPipe(RescheduleSchema);

class AppointmentViewDto extends createZodDto(AppointmentViewSchema) {}

/** The signed-in owner's bookings: list, detail, cancel and reschedule (customer tokens only). */
@Controller("me/appointments")
export class MeAppointmentsController {
  constructor(private readonly appointments: AppointmentsService) {}

  @CustomerAuth()
  @Get()
  @ApiOkResponse({ type: [AppointmentViewDto] })
  list(@Query(QueryPipe) q: MeAppointmentsQuery, @Principal() p: AccessClaims): Promise<AppointmentView[]> {
    return this.appointments.listMine(p, q);
  }

  @CustomerAuth()
  @Get(":id")
  @ApiOkResponse({ type: AppointmentViewDto })
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<AppointmentView> {
    return this.appointments.getMine(p, id);
  }

  @CustomerAuth()
  @Post(":id/cancel")
  @HttpCode(200)
  @ApiOkResponse({ type: AppointmentViewDto })
  cancel(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims, @Req() req: Request): Promise<AppointmentView> {
    return this.appointments.cancelMine(p, id, requestMeta(req).ip);
  }

  @CustomerAuth()
  @Post(":id/reschedule")
  @HttpCode(200)
  @ApiOkResponse({ type: AppointmentViewDto })
  reschedule(
    @Param("id", IdPipe) id: string,
    @Body(ReschedulePipe) body: Reschedule,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<AppointmentView> {
    return this.appointments.rescheduleMine(p, id, body, requestMeta(req).ip);
  }
}
