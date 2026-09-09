import { Global, Inject, Module, OnApplicationShutdown } from "@nestjs/common";
import { Pool } from "pg";
import { readEnvironment } from "../config/environment";

export const DATABASE_POOL = Symbol("DATABASE_POOL");

@Global()
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: () => {
        const pool = new Pool({ connectionString: readEnvironment().databaseUrl, max: 10 });
        pool.on("error", (error) => {
          console.error(JSON.stringify({ level: "error", service: "argus-api", event: "postgres_pool_error", error: error.message }));
        });
        return pool;
      },
    },
  ],
  exports: [DATABASE_POOL],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
