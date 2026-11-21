import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  EmployeeCreateSchema,
  EmployeePatchSchema,
  EmployeeQuerySchema,
  EmployeeServicesSchema,
  IdSchema,
  WorkingHoursSchema,
  type AccessClaims,
  type EmployeeCreate,
  type EmployeePatch,
  type EmployeeQuery,
  type EmployeeServicesBody,
  type EmployeeView,
  type WorkingHoursBody,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { EmployeesService } from "./employees.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(EmployeeCreateSchema);
const PatchPipe = new ZodValidationPipe(EmployeePatchSchema);
const QueryPipe = new ZodValidationPipe(EmployeeQuerySchema);
const ServicesPipe = new ZodValidationPipe(EmployeeServicesSchema);
const HoursPipe = new ZodValidationPipe(WorkingHoursSchema);

/** Staff members with their employee profile. `:id/invite` and `:id/reset-2fa` live in `StaffAdminController`. */
@Controller("staff/employees")
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  /** EMPLOYEE callers see only active people, without `email`. */
  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  list(@Query(QueryPipe) q: EmployeeQuery, @Principal() p: AccessClaims): Promise<EmployeeView[]> {
    return this.employees.list(p, q);
  }

  @StaffAuth("OWNER")
  @Post()
  create(@Body(CreatePipe) body: EmployeeCreate, @Principal() p: AccessClaims, @Req() req: Request): Promise<EmployeeView> {
    return this.employees.create(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id")
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<EmployeeView> {
    return this.employees.get(p, id);
  }

  /** A role change or `active: false` revokes the person's sessions; 409 for the last active OWNER. */
  @StaffAuth("OWNER")
  @Patch(":id")
  patch(
    @Param("id", IdPipe) id: string,
    @Body(PatchPipe) body: EmployeePatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<EmployeeView> {
    return this.employees.patch(p, id, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER")
  @Put(":id/services")
  replaceServices(
    @Param("id", IdPipe) id: string,
    @Body(ServicesPipe) body: EmployeeServicesBody,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<EmployeeView> {
    return this.employees.replaceServices(p, id, body, requestMeta(req).ip);
  }

  /** EMPLOYEE may read only their own hours (403 otherwise). */
  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id/working-hours")
  hours(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<WorkingHoursBody> {
    return this.employees.getHours(p, id);
  }

  @StaffAuth("OWNER")
  @Put(":id/working-hours")
  replaceHours(
    @Param("id", IdPipe) id: string,
    @Body(HoursPipe) body: WorkingHoursBody,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<WorkingHoursBody> {
    return this.employees.replaceHours(p, id, body, requestMeta(req).ip);
  }
}
