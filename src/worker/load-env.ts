/**
 * Must be the first import of the worker process. ESM evaluates static
 * imports before any statements in takehome-server.ts, so dotenv cannot
 * live "between" those imports.
 */
import { config as loadEnv } from "dotenv";

loadEnv({ path: process.env.WORKER_ENV_FILE || ".env.worker" });
loadEnv();
