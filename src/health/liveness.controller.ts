import { Controller, Get, Res, VERSION_NEUTRAL } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";
import type { Response } from "express";
import { Public } from "../common/decorators/public.decorator";
import { healthProbe } from "./health-probe";

/**
 * Unauthenticated liveness probe. No database, cache, or queue calls.
 * Returns 503 once shutdown has started so the proxy can detach.
 * The response is written directly so Nest's default 200 cannot overwrite a 503.
 */
@ApiTags("Health")
@Public()
@SkipThrottle()
@Controller({ path: "api/health", version: VERSION_NEUTRAL })
export class LivenessController {
  @Get()
  @ApiOperation({ summary: "Liveness probe (503 while draining)" })
  probe(@Res() res: Response): void {
    const probe = healthProbe();
    res.setHeader("Cache-Control", "no-store");
    res.status(probe.statusCode).json(probe.body);
  }
}
