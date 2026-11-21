import { Body, Controller, Get, Param, Patch, Post, Query, Req } from "@nestjs/common";
import type { Request } from "express";
import { ZodValidationPipe } from "nestjs-zod";
import {
  CustomerCreateSchema,
  CustomerPatchSchema,
  CustomerQuerySchema,
  IdSchema,
  type AccessClaims,
  type CustomerCreate,
  type CustomerPatch,
  type CustomerQuery,
  type StaffCustomerView,
} from "@grooming/contracts";
import { Principal, StaffAuth } from "../auth/decorators.js";
import { requestMeta } from "../auth/request-meta.js";
import { CustomersService } from "./customers.service.js";

const IdPipe = new ZodValidationPipe(IdSchema);
const CreatePipe = new ZodValidationPipe(CustomerCreateSchema);
const PatchPipe = new ZodValidationPipe(CustomerPatchSchema);
const QueryPipe = new ZodValidationPipe(CustomerQuerySchema);

/** Customers as managed by staff. `privateNotes` is returned to OWNER/RECEPTION only. */
@Controller("staff/customers")
export class StaffCustomersController {
  constructor(private readonly customers: CustomersService) {}

  /** EMPLOYEE callers see only customers with a segment assigned to them within +-30 days. */
  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get()
  search(@Query(QueryPipe) q: CustomerQuery, @Principal() p: AccessClaims): Promise<StaffCustomerView[]> {
    return this.customers.search(p, q);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Post()
  create(@Body(CreatePipe) body: CustomerCreate, @Principal() p: AccessClaims, @Req() req: Request): Promise<StaffCustomerView> {
    return this.customers.create(p, body, requestMeta(req).ip);
  }

  @StaffAuth("OWNER", "RECEPTION", "EMPLOYEE")
  @Get(":id")
  get(@Param("id", IdPipe) id: string, @Principal() p: AccessClaims): Promise<StaffCustomerView> {
    return this.customers.get(p, id);
  }

  @StaffAuth("OWNER", "RECEPTION")
  @Patch(":id")
  patch(
    @Param("id", IdPipe) id: string,
    @Body(PatchPipe) body: CustomerPatch,
    @Principal() p: AccessClaims,
    @Req() req: Request,
  ): Promise<StaffCustomerView> {
    return this.customers.patch(p, id, body, requestMeta(req).ip);
  }
}
