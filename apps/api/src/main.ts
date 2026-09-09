import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { ErrorEnvelopeFilter } from "./common/error.filter";
import { readEnvironment } from "./config/environment";
import { DATABASE_POOL } from "./database/database.module";
import { probeKey, seedDevelopmentProbes } from "./pipeline/probe-auth";

async function bootstrap(): Promise<void> {
  const environment = readEnvironment();
  probeKey();
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableCors({ origin: environment.corsOrigin, credentials: true });
  app.useGlobalFilters(new ErrorEnvelopeFilter());
  app.enableShutdownHooks();
  await seedDevelopmentProbes(app.get(DATABASE_POOL));
  await app.listen(environment.port, "0.0.0.0");
  console.log(JSON.stringify({ level: "info", service: "argus-api", environment: environment.nodeEnv, event: "started", port: environment.port }));
}

bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
