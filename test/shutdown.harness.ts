import "reflect-metadata";
import {
  Controller,
  Get,
  Injectable,
  Module,
  OnApplicationShutdown,
  VERSION_NEUTRAL,
  VersioningType,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { LivenessController } from "../src/health/liveness.controller";
import { installGracefulShutdown } from "../src/lifecycle/graceful-shutdown";
import { createLogger, PinoNestLogger } from "../src/logging/pino-logger";

@Controller({ version: VERSION_NEUTRAL })
class SlowController {
  @Get("slow")
  slow(): Promise<string> {
    const ms = Number(process.env.SLOW_MS ?? 1500);
    return new Promise((resolve) => {
      setTimeout(() => {
        process.stdout.write("SLOW_DONE\n");
        resolve("done");
      }, ms);
    });
  }
}

@Injectable()
class MarkClosed implements OnApplicationShutdown {
  onApplicationShutdown(): void {
    process.stdout.write("RESOURCES_CLOSED\n");
  }
}

@Module({
  controllers: [LivenessController, SlowController],
  providers: [MarkClosed],
})
class HarnessModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(HarnessModule, { bufferLogs: true });
  app.useLogger(new PinoNestLogger(createLogger("info")));
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: "2" });
  installGracefulShutdown(app);
  await app.listen(0, "127.0.0.1");
  process.stdout.write(`READY ${await app.getUrl()}\n`);
}

void bootstrap().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
