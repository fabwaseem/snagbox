import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";
import { LivenessController } from "./liveness.controller";

@Module({
  controllers: [HealthController, LivenessController],
})
export class HealthModule {}
