import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { createZodDto } from "nestjs-zod";
import {
  GoogleNonceResponseSchema,
  GooglePhoneRequiredSchema,
  GoogleSignedInSchema,
  GoogleSignInRequestSchema,
  type GoogleNonceResponse,
  type GoogleSignInResponse,
} from "@grooming/contracts";
import { Public } from "../decorators.js";
import { GoogleAuthService } from "./google-auth.service.js";

class GoogleNonceResponseDto extends createZodDto(GoogleNonceResponseSchema) {}
class GoogleSignInRequestDto extends createZodDto(GoogleSignInRequestSchema) {}
// The response is a union (discriminated on `status`), so OpenAPI documents it as `oneOf` its two members.
class GoogleSignedInDto extends createZodDto(GoogleSignedInSchema) {}
class GooglePhoneRequiredDto extends createZodDto(GooglePhoneRequiredSchema) {}

/** Owner sign-in with Google. Both routes are 404 while `GOOGLE_OAUTH_CLIENT_IDS` is empty. */
@ApiExtraModels(GoogleSignedInDto, GooglePhoneRequiredDto)
@Controller("auth/google")
export class GoogleAuthController {
  constructor(private readonly google: GoogleAuthService) {}

  /** Issues a single-use nonce for the Google button and binds it to this browser (`gr_gnonce` cookie). */
  @Public()
  @Post("nonce")
  @HttpCode(200)
  @ApiOkResponse({ type: GoogleNonceResponseDto })
  nonce(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<GoogleNonceResponse> {
    return this.google.nonce(req, res);
  }

  /** Verifies a Google ID token: `SIGNED_IN` for a linked account, else `PHONE_REQUIRED` with a link ticket. */
  @Public()
  @Post()
  @HttpCode(200)
  @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(GoogleSignedInDto) }, { $ref: getSchemaPath(GooglePhoneRequiredDto) }] } })
  signIn(
    @Body() body: GoogleSignInRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<GoogleSignInResponse> {
    return this.google.signIn(body.idToken, req, res);
  }
}
