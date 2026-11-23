import { Body, Controller, Get, HttpCode, Param, Patch, Post, Req } from "@nestjs/common";
import type { Request } from "express";
import { ApiCreatedResponse, ApiOkResponse } from "@nestjs/swagger";
import { createZodDto, ZodValidationPipe } from "nestjs-zod";
import {
  IdSchema,
  StaffAppointmentViewSchema,
  StaffBookingSchema,
  StaffMoveSchema,
  StaffStatusSchema,
  WalkInSchema,
  type AccessClaims,
  type StaffAppointmentView,
  type StaffBooking,
  type StaffMove,
  type StaffStatus,
  type WalkIn,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { StaffAppointmentsService } from "./staff-appointments.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const BookingPipe = new ZodValidationPipe(StaffBookingSchema);
const MovePipe = new ZodValidationPipe(StaffMoveSchema);
const StatusPipe = new ZodValidationPipe(StaffStatusSchema);
const WalkInPipe = new ZodValidationPipe(WalkInSchema);

class StaffAppointmentViewDto extends createZodDto(StaffAppointmentViewSchema) {}

/** Staff bookings: book, read, move, cancel / no-show. EMPLOYEE may only read appointments with a segment of theirs. */
@Controller("staff/appointments")
export class StaffAppointmentsController {
  constructor(private readonly appointments: StaffAppointmentsService) {}

  @StaffAuth("OWNER", "RECEPTION")
  @Post()
  @ApiCreatedResponse({ type: StaffAppointmentViewDto })
  create(@Body(BookingPipe) body: StaffBooking, @Principal() p: AccessClaims, @Req() req: Request): Promise<StaffAppointmentView> {
    return this.appointments.create(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id")
  @ApiOkResponse({ type: StaffAppointmentViewDto })
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<StaffAppointmentView> {
    return this.appointments.get(p, id);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Patch(":id")
  @ApiOkResponse({ type: StaffAppointmentViewDto })
  move(
    @Param("id", IdPipe) id: string,
    @Body(MovePipe) body: StaffMove,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<StaffAppointmentView> {
    return this.appointments.move(p, id, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Post(":id/status")
  @HttpCode(200)
  @ApiOkResponse({ type: StaffAppointmentViewDto })
  status(
    @Param("id", IdPipe) id: string,
    @Body(StatusPipe) body: StaffStatus,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<StaffAppointmentView> {
    return this.appointments.setStatus(p, id, body, requestMeta(req).ip);
  }
}

/** Walk-in: books the customer's pets on the first staff slot starting now. */
@Controller("staff/walk-in")
export class StaffWalkInController {
  constructor(private readonly appointments: StaffAppointmentsService) {}

  @StaffAuth("OWNER", "RECEPTION")
  @Post()
  @ApiCreatedResponse({ type: StaffAppointmentViewDto })
  walkIn(@Body(WalkInPipe) body: WalkIn, @Principal() p: AccessClaims, @Req() req: Request): Promise<StaffAppointmentView> {
    return this.appointments.walkIn(p, body, requestMeta(req).ip);
  }
}
