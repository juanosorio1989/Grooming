import { Body, Controller, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiBody, ApiNoContentResponse, ApiOkResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { createZodDto } from "nestjs-zod";
import { LogoutRequestSchema, RefreshRequestSchema, TokenResponseSchema, type TokenResponse } from "@grooming/contracts";
import { Public } from "./decorators.js";
import { SessionService } from "./session.service.js";

// `.default({})`: a cookie-only request has no JSON body at all.
class RefreshRequestDto extends createZodDto(RefreshRequestSchema.default({})) {}
class LogoutRequestDto extends createZodDto(LogoutRequestSchema.default({})) {}
class TokenResponseDto extends createZodDto(TokenResponseSchema) {}

@Controller("auth")
export class SessionController {
  constructor(private readonly sessions: SessionService) {}

  /** Rotates the refresh token (cookie + `x-grooming-csrf: 1`, or body `refreshToken`). */
  @Public()
  @Post("refresh")
  @HttpCode(200)
  @ApiBody({ type: RefreshRequestDto, required: false })
  @ApiOkResponse({ type: TokenResponseDto })
  refresh(
    @Body() _body: RefreshRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<TokenResponse> {
    return this.sessions.refresh(req, res);
  }

  /** Revokes the refresh token family and clears the cookie; 204 even for unknown tokens. */
  @Public()
  @Post("logout")
  @HttpCode(204)
  @ApiBody({ type: LogoutRequestDto, required: false })
  @ApiNoContentResponse()
  logout(
    @Body() _body: LogoutRequestDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.sessions.logout(req, res);
  }
}
