import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import type { Request, Response } from "express";
import type { Locale, OtpStartResponse, OtpVerifyResponse } from "@grooming/contracts";
import { AuditService } from "../../audit/audit.service.js";
import { PrismaService } from "../../prisma/prisma.service.js";
import { RateLimitService } from "../../rate-limit/rate-limit.service.js";
import { TenancyService } from "../../tenancy/tenancy.service.js";
import { requestMeta } from "../request-meta.js";
import { SessionService } from "../session.service.js";
import {
  OTP_PROVIDER,
  OtpInvalidRecipientError,
  OtpProviderRateLimitedError,
  type OtpChannel,
  type OtpProvider,
} from "./otp-provider.js";

/** Rate limits: [limit, window seconds]. */
const START_PER_PHONE = [3, 600] as const;
const START_PER_IP = [10, 3600] as const;
const VERIFY_PER_PHONE = [5, 600] as const;

const US_ONLY = "Only US phone numbers are supported";
const INVALID_US = "Enter a valid US phone number";
/** NANP: +1, area code and exchange each start with 2-9. Non-US NANP ranges are left to Twilio Geo Permissions and Fraud Guard. */
const NANP = /^\+1[2-9]\d{2}[2-9]\d{6}$/;
const CHANNELS: readonly OtpChannel[] = ["whatsapp", "sms"];

/**
 * Customer login by phone: `start` sends a code (WhatsApp first, SMS fallback),
 * `verify` checks it, finds or creates the customer and starts a session.
 * Phones appear in Redis keys only as `hashKeyPart(phone)`. Verifying a phone
 * is not consent to messages: no `notification_consent` rows are written here.
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    @Inject(OTP_PROVIDER) private readonly provider: OtpProvider,
    private readonly rateLimit: RateLimitService,
    private readonly tenancy: TenancyService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
  ) {}

  async start(req: { phone: string; locale: Locale }, ip: string): Promise<OtpStartResponse> {
    assertUsPhone(req.phone);
    await this.rateLimit.enforce(`otp:start:phone:${this.rateLimit.hashKeyPart(req.phone)}`, ...START_PER_PHONE);
    await this.rateLimit.enforce(`otp:start:ip:${this.rateLimit.hashKeyPart(ip)}`, ...START_PER_IP);
    for (const channel of CHANNELS) {
      try {
        await this.provider.start(req.phone, channel, req.locale);
        return { channel };
      } catch (err) {
        // Provider errors carry only a status by contract; never log the phone or the code.
        this.logger.warn(`OTP start over ${channel} failed: ${err instanceof Error ? err.message : "unknown error"}`);
        // A 400 on WhatsApp may be a channel-config error (e.g. Twilio 60223, no sender), not a bad number:
        // it falls back like an unavailable channel. Only a 400 from SMS is a bad-number answer.
        if (err instanceof OtpInvalidRecipientError && channel === "sms") throw phoneError(INVALID_US);
        if (err instanceof OtpProviderRateLimitedError) throw rateLimited();
      }
    }
    throw new ServiceUnavailableException();
  }

  async verify(
    req: { phone: string; code: string; locale?: Locale },
    httpReq: Request,
    res: Response,
  ): Promise<OtpVerifyResponse> {
    assertUsPhone(req.phone);
    await this.rateLimit.enforce(`otp:verify:phone:${this.rateLimit.hashKeyPart(req.phone)}`, ...VERIFY_PER_PHONE);
    if (!(await this.checkCode(req.phone, req.code))) throw new BadRequestException({ code: "OTP_INVALID" });

    const orgId = await this.tenancy.getOrgId();
    const key = { organizationId_phoneE164: { organizationId: orgId, phoneE164: req.phone } };
    const existing = await this.prisma.customer.findUnique({ where: key, select: { deletedAt: true } });
    // A soft-deleted customer keeps the phone until plan 04 anonymization frees it.
    if (existing?.deletedAt) throw new UnauthorizedException({ code: "UNAUTHORIZED" });

    const now = new Date();
    const locale = req.locale ?? (await this.defaultLocale(orgId));
    const customer = await this.prisma.customer.upsert({
      where: key,
      create: {
        organizationId: orgId,
        phoneE164: req.phone,
        locale,
        createdVia: "ONLINE",
        phoneVerifiedAt: now,
      },
      update: { phoneVerifiedAt: now },
      select: { id: true, name: true },
    });
    const isNew = customer.name === null;

    await this.audit.record({
      orgId,
      actorType: "CUSTOMER",
      actorId: customer.id,
      action: "auth.customer.login",
      entity: "customer",
      entityId: customer.id,
      after: { isNew },
      ip: requestMeta(httpReq).ip,
    });
    const tokens = await this.sessions.start({ type: "CUSTOMER", id: customer.id }, httpReq, res);
    return { ...tokens, isNew };
  }

  /** Provider rate limit → 429; any other provider failure → 503. */
  private async checkCode(phone: string, code: string): Promise<boolean> {
    try {
      return await this.provider.check(phone, code);
    } catch (err) {
      this.logger.warn(`OTP check failed: ${err instanceof Error ? err.message : "unknown error"}`);
      if (err instanceof OtpProviderRateLimitedError) throw rateLimited();
      throw new ServiceUnavailableException();
    }
  }

  private async defaultLocale(orgId: string): Promise<string> {
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { defaultLocale: true } });
    return org.defaultLocale;
  }
}

function assertUsPhone(phone: string): void {
  if (!phone.startsWith("+1")) throw phoneError(US_ONLY);
  if (!NANP.test(phone)) throw phoneError(INVALID_US);
}

function phoneError(message: string): BadRequestException {
  return new BadRequestException({ code: "VALIDATION_FAILED", message, errors: [{ path: "phone", message }] });
}

function rateLimited(): HttpException {
  return new HttpException(
    { code: "RATE_LIMITED", message: "Too many attempts, try again later" },
    HttpStatus.TOO_MANY_REQUESTS,
  );
}
