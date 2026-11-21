import type { INestApplication } from "@nestjs/common";
import type { StaffRole } from "@grooming/contracts";
import { TokenService } from "../../src/auth/token.service.js";

/** Access token for a staff member, minted through `TokenService.issueAccess`. */
export async function staffToken(app: INestApplication, opts: { sub: string; org: string; role: StaffRole }): Promise<string> {
  const { token } = await app.get(TokenService).issueAccess({ sub: opts.sub, typ: "staff", org: opts.org, role: opts.role });
  return token;
}

/** Access token for a customer. */
export async function customerToken(app: INestApplication, opts: { sub: string; org: string }): Promise<string> {
  const { token } = await app.get(TokenService).issueAccess({ sub: opts.sub, typ: "customer", org: opts.org, role: "CUSTOMER" });
  return token;
}
