import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AccessClaims } from "@grooming/contracts";
import { TenancyService } from "../tenancy/tenancy.service.js";
import { AUTH_POLICY, type AuthPolicy, type AuthedRequest } from "./decorators.js";
import { TokenService } from "./token.service.js";

const BEARER = /^Bearer ([A-Za-z0-9_.-]+)$/;

/**
 * Global guard (APP_GUARD), fail closed: a handler or controller without an
 * auth decorator answers 403 to everyone. Token problems (missing, invalid,
 * expired, other organization) are 401; a valid token of the wrong kind or
 * role is 403. `optional-customer` lets a request without an `Authorization`
 * header through anonymously and checks a sent header like `customer`.
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly tenancy: TenancyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const policy = this.reflector.getAllAndOverride<AuthPolicy | undefined>(AUTH_POLICY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!policy) throw new ForbiddenException({ code: "FORBIDDEN" });
    if (policy.kind === "public") return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.get("authorization");
    if (policy.kind === "optional-customer" && !header) return true;
    const match = BEARER.exec(header ?? "");
    if (!match) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    const claims = await this.tokens.verifyAccess(match[1]!);
    if (claims.org !== (await this.tenancy.getOrgId())) throw new UnauthorizedException({ code: "UNAUTHORIZED" });
    if (!allows(policy, claims)) throw new ForbiddenException({ code: "FORBIDDEN" });

    req.principal = claims;
    return true;
  }
}

function allows(policy: Exclude<AuthPolicy, { kind: "public" }>, claims: AccessClaims): boolean {
  if (policy.kind === "customer" || policy.kind === "optional-customer") return claims.typ === "customer" && claims.role === "CUSTOMER";
  if (claims.typ !== "staff" || claims.role === "CUSTOMER") return false;
  return policy.roles.length === 0 || policy.roles.includes(claims.role);
}
