import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { createZodDto } from "nestjs-zod";
import {
  OtpStartRequestSchema,
  OtpStartResponseSchema,
  OtpVerifyRequestSchema,
  OtpVerifyResponseSchema,
  type OtpStartResponse,
  type OtpVerifyResponse,
} from "@grooming/contracts";
import { Public } from "../decorators.js";
import { requestMeta } from "../request-meta.js";
import { OtpService } from "./otp.service.js";

class OtpStartRequestDto extends createZodDto(OtpStartRequestSchema) {}
class OtpStartResponseDto extends createZodDto(OtpStartResponseSchema) {}
class OtpVerifyRequestDto extends createZodDto(OtpVerifyRequestSchema) {}
class OtpVerifyResponseDto extends createZodDto(OtpVerifyResponseSchema) {}

@Controller("auth/otp")
export class OtpController {
  constructor(private readonly otp: OtpService) {}

  /** Sends a login code to a US phone over the channels in `OTP_CHANNELS`, in order. */
  @Public()
  @Post("start")
  @HttpCode(200)
  @ApiOkResponse({ type: OtpStartResponseDto })
  start(@Body() body: OtpStartRequestDto, @Req() req: Request): Promise<OtpStartResponse> {
    return this.otp.start({ phone: body.phone, locale: body.locale }, requestMeta(req).ip ?? "unknown");
  }

  /**
   * Checks the code, finds or creates the customer and starts a session (same transports as `/auth/refresh`).
   * With a Google `linkTicket` (feature on), also links that Google account; see `identityLinked`.
   */
  @Public()
  @Post("verify")
  @HttpCode(200)
  @ApiOkResponse({ type: OtpVerifyResponseDto })
  verify(
    @Body() body: OtpVerifyRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OtpVerifyResponse> {
    return this.otp.verify(
      { phone: body.phone, code: body.code, locale: body.locale, linkTicket: body.linkTicket },
      req,
      res,
    );
  }
}
