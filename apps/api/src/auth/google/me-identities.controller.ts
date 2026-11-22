import { Body, Controller, Delete, HttpCode, Post, Req, Res } from "@nestjs/common";
import { ApiNoContentResponse } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { createZodDto } from "nestjs-zod";
import { LinkGoogleRequestSchema, type AccessClaims } from "@grooming/contracts";
import { CustomerAuth, Principal } from "../decorators.js";
import { GoogleAuthService } from "./google-auth.service.js";

class LinkGoogleRequestDto extends createZodDto(LinkGoogleRequestSchema) {}

/**
 * Link or unlink a Google account from the owner's profile. Both routes are 404 while
 * `GOOGLE_OAUTH_CLIENT_IDS` is empty. The link needs the `gr_gnonce` cookie of the browser that asked for the nonce.
 */
@Controller("me/identities/google")
export class MeIdentitiesController {
  constructor(private readonly google: GoogleAuthService) {}

  /** 204 linked (or already linked to this customer); 409 IDENTITY_TAKEN otherwise. */
  @CustomerAuth()
  @Post()
  @HttpCode(204)
  @ApiNoContentResponse()
  link(
    @Body() body: LinkGoogleRequestDto,
    @Principal() p: AccessClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    return this.google.link(p, body.idToken, req, res);
  }

  /** 204, also when nothing is linked. */
  @CustomerAuth()
  @Delete()
  @HttpCode(204)
  @ApiNoContentResponse()
  unlink(@Principal() p: AccessClaims, @Req() req: Request): Promise<void> {
    return this.google.unlink(p, req);
  }
}
