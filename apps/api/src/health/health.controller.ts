import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse } from "@nestjs/swagger";
import { createZodDto } from "nestjs-zod";
import { HealthResponseSchema } from "@grooming/contracts";
import { Public } from "../auth/decorators.js";

class HealthResponseDto extends createZodDto(HealthResponseSchema) {}

@Controller("health")
export class HealthController {
  @Public()
  @Get()
  @ApiOkResponse({ type: HealthResponseDto })
  check(): { status: "ok" } {
    return { status: "ok" };
  }
}
