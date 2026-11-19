import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { AccessClaims, StaffRole } from "@grooming/contracts";

/** Metadata key read by `AccessGuard`. A route without it is denied (403). */
export const AUTH_POLICY = "auth:policy";

export type AuthPolicy =
  | { kind: "public" }
  | { kind: "customer" }
  | { kind: "staff"; roles: readonly StaffRole[] };

/** A request that passed `AccessGuard` with a token. */
export type AuthedRequest = Request & { principal?: AccessClaims };

/** No token required. */
export const Public = () => SetMetadata(AUTH_POLICY, { kind: "public" } satisfies AuthPolicy);

/** A customer access token for this organization. */
export const CustomerAuth = () => SetMetadata(AUTH_POLICY, { kind: "customer" } satisfies AuthPolicy);

/** A staff access token for this organization; with `roles`, one of them (none = any staff role). */
export const StaffAuth = (...roles: StaffRole[]) =>
  SetMetadata(AUTH_POLICY, { kind: "staff", roles } satisfies AuthPolicy);

/** The verified access claims set by `AccessGuard` (undefined on `@Public()` routes). */
export const Principal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().principal,
);
