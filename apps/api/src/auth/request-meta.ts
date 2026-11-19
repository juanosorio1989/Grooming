import type { Request } from "express";

export type Subject = { type: "CUSTOMER" | "STAFF"; id: string };
export type RequestMeta = { ip: string | null; userAgent: string | null };

const MAX_USER_AGENT = 255;

/** Client IP (honours `trust proxy`) and user agent (truncated to 255 chars) for session rows and audit. */
export function requestMeta(req: Request): RequestMeta {
  const ua = req.get("user-agent");
  return { ip: req.ip ?? null, userAgent: ua ? ua.slice(0, MAX_USER_AGENT) : null };
}
