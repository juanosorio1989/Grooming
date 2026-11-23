import { SetMetadata, createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";
import type { AccessClaims, StaffRole } from "@grooming/contracts";

/** Metadata key read by `AccessGuard`. A route without it is denied (403). */
export const AUTH_POLICY = "auth:policy";

export type AuthPolicy =
  | { kind: "public" }
  | { kind: "customer" }
  | { kind: "optional-customer" }
  | { kind: "optional-customer-or-staff"; staffRoles: readonly StaffRole[] }
  | { kind: "staff"; roles: readonly StaffRole[] };

/** A request that passed `AccessGuard` with a token. */
export type AuthedRequest = Request & { principal?: AccessClaims };

/** No token required. */
export const Public = () => SetMetadata(AUTH_POLICY, { kind: "public" } satisfies AuthPolicy);

/** A customer access token for this organization. */
export const CustomerAuth = () => SetMetadata(AUTH_POLICY, { kind: "customer" } satisfies AuthPolicy);

/**
 * No token required; when an `Authorization` header is sent it must be a valid
 * customer token for this organization (bad token 401, staff token 403), and
 * `Principal` is then set.
 */
export const OptionalCustomerAuth = () =>
  SetMetadata(AUTH_POLICY, { kind: "optional-customer" } satisfies AuthPolicy);

/**
 * Like `OptionalCustomerAuth`, but a staff token whose role is in `staffRoles`
 * is also accepted (another staff role is 403; an empty list accepts no staff
 * role). `Principal` is the customer or staff claims, or undefined when anonymous.
 */
export const OptionalCustomerOrStaffAuth = (...staffRoles: StaffRole[]) =>
  SetMetadata(AUTH_POLICY, { kind: "optional-customer-or-staff", staffRoles } satisfies AuthPolicy);

/** A staff access token for this organization; with `roles`, one of them (none = any staff role). */
export const StaffAuth = (...roles: StaffRole[]) =>
  SetMetadata(AUTH_POLICY, { kind: "staff", roles } satisfies AuthPolicy);

/** The verified access claims set by `AccessGuard` (undefined on `@Public()` routes and on anonymous `@OptionalCustomerAuth()` / `@OptionalCustomerOrStaffAuth()` requests). */
export const Principal = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AccessClaims | undefined =>
    ctx.switchToHttp().getRequest<AuthedRequest>().principal,
);
