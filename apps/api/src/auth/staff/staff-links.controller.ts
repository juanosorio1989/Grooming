import { Body, Controller, HttpCode, Post, Req } from "@nestjs/common";
import { ApiNoContentResponse, ApiOkResponse } from "@nestjs/swagger";
import type { Request } from "express";
import { createZodDto } from "nestjs-zod";
import {
  InviteAcceptRequestSchema,
  MfaStepResponseSchema,
  PasswordForgotRequestSchema,
  PasswordResetRequestSchema,
  type MfaStepResponse,
} from "@grooming/contracts";
import { Public } from "../decorators.js";
import { requestMeta } from "../request-meta.js";
import { StaffLinksService } from "./staff-links.service.js";

class InviteAcceptRequestDto extends createZodDto(InviteAcceptRequestSchema) {}
class PasswordForgotRequestDto extends createZodDto(PasswordForgotRequestSchema) {}
class PasswordResetRequestDto extends createZodDto(PasswordResetRequestSchema) {}
class MfaStepResponseDto extends createZodDto(MfaStepResponseSchema) {}

/** Single-use invite and password reset links. Each route: 10 requests per IP per 15 min (429). */
@Controller("auth/staff")
export class StaffLinksController {
  constructor(private readonly links: StaffLinksService) {}

  /** Invite token + new password → `ENROLL_REQUIRED` (or `MFA_REQUIRED` if already enrolled). 400 `LINK_INVALID`. */
  @Public()
  @Post("invite/accept")
  @HttpCode(200)
  @ApiOkResponse({ type: MfaStepResponseDto })
  acceptInvite(@Body() body: InviteAcceptRequestDto, @Req() req: Request): Promise<MfaStepResponse> {
    return this.links.acceptInvite({ token: body.token, password: body.password }, req);
  }

  /** Always 204, whether or not the email belongs to a staff member. */
  @Public()
  @Post("password/forgot")
  @HttpCode(204)
  @ApiNoContentResponse()
  async forgot(@Body() body: PasswordForgotRequestDto, @Req() req: Request): Promise<void> {
    await this.links.forgot({ email: body.email }, requestMeta(req).ip);
  }

  /** Reset token + new password → 204; every session of that staff member is revoked. 400 `LINK_INVALID`. */
  @Public()
  @Post("password/reset")
  @HttpCode(204)
  @ApiNoContentResponse()
  async reset(@Body() body: PasswordResetRequestDto, @Req() req: Request): Promise<void> {
    await this.links.reset({ token: body.token, password: body.password }, req);
  }
}
