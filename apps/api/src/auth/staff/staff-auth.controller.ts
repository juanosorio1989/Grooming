import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { createZodDto } from "nestjs-zod";
import {
  MfaCodeRequestSchema,
  MfaEnrollConfirmResponseSchema,
  MfaEnrollStartResponseSchema,
  MfaRecoverRequestSchema,
  MfaStepResponseSchema,
  MfaTokenRequestSchema,
  StaffLoginRequestSchema,
  TokenResponseSchema,
  type MfaEnrollConfirmResponse,
  type MfaEnrollStartResponse,
  type MfaStepResponse,
  type TokenResponse,
} from "@grooming/contracts";
import { Public } from "../decorators.js";
import { MfaService } from "./mfa.service.js";
import { StaffAuthService } from "./staff-auth.service.js";

class StaffLoginRequestDto extends createZodDto(StaffLoginRequestSchema) {}
class MfaStepResponseDto extends createZodDto(MfaStepResponseSchema) {}
class MfaTokenRequestDto extends createZodDto(MfaTokenRequestSchema) {}
class MfaEnrollStartResponseDto extends createZodDto(MfaEnrollStartResponseSchema) {}
class MfaCodeRequestDto extends createZodDto(MfaCodeRequestSchema) {}
class MfaEnrollConfirmResponseDto extends createZodDto(MfaEnrollConfirmResponseSchema) {}
class MfaRecoverRequestDto extends createZodDto(MfaRecoverRequestSchema) {}
class TokenResponseDto extends createZodDto(TokenResponseSchema) {}

@Controller("auth/staff")
export class StaffAuthController {
  constructor(
    private readonly staffAuth: StaffAuthService,
    private readonly mfa: MfaService,
  ) {}

  /** Email + password → an MFA step (`MFA_REQUIRED` or `ENROLL_REQUIRED`), never a session. */
  @Public()
  @Post("login")
  @HttpCode(200)
  @ApiOkResponse({ type: MfaStepResponseDto })
  login(@Body() body: StaffLoginRequestDto, @Req() req: Request): Promise<MfaStepResponse> {
    return this.staffAuth.login({ email: body.email, password: body.password }, req);
  }

  /** Enroll token → a new pending TOTP secret and its otpauth URL. */
  @Public()
  @Post("mfa/enroll")
  @HttpCode(200)
  @ApiOkResponse({ type: MfaEnrollStartResponseDto })
  enrollStart(@Body() body: MfaTokenRequestDto): Promise<MfaEnrollStartResponse> {
    return this.mfa.enrollStart({ mfaToken: body.mfaToken });
  }

  /** Enroll token + first code → session tokens and 10 recovery codes (shown once). */
  @Public()
  @Post("mfa/enroll/confirm")
  @HttpCode(200)
  @ApiOkResponse({ type: MfaEnrollConfirmResponseDto })
  enrollConfirm(
    @Body() body: MfaCodeRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<MfaEnrollConfirmResponse> {
    return this.mfa.enrollConfirm({ mfaToken: body.mfaToken, code: body.code }, req, res);
  }

  /** Verify token + TOTP code → session tokens (same transports as `/auth/refresh`). */
  @Public()
  @Post("mfa/verify")
  @HttpCode(200)
  @ApiOkResponse({ type: TokenResponseDto })
  verify(
    @Body() body: MfaCodeRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    return this.mfa.verify({ mfaToken: body.mfaToken, code: body.code }, req, res);
  }

  /** Verify token + recovery code → TOTP cleared, sessions revoked, `ENROLL_REQUIRED` (no session). */
  @Public()
  @Post("mfa/recover")
  @HttpCode(200)
  @ApiOkResponse({ type: MfaStepResponseDto })
  recover(@Body() body: MfaRecoverRequestDto, @Req() req: Request): Promise<MfaStepResponse> {
    return this.mfa.recover({ mfaToken: body.mfaToken, recoveryCode: body.recoveryCode }, req);
  }
}
