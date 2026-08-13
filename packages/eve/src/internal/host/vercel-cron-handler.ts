import { randomBytes, timingSafeEqual } from "node:crypto";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  createScheduleRuntime,
  type ScheduleRuntimeOptions,
} from "#internal/host/schedule-runtime.js";

export type VercelCronHandler = (request: Request) => Promise<Response>;

export interface VercelCronHandlerOptions extends ScheduleRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export function createVercelCronHandlerRoute(): string {
  return `${EVE_ROUTE_PREFIX}/cron/${randomBytes(32).toString("base64url")}`;
}

export function createVercelCronHandler(input: VercelCronHandlerOptions): VercelCronHandler {
  const runtime = createScheduleRuntime(input);

  return async (request) => {
    const cronSecret = (input.environment ?? process.env).CRON_SECRET;
    if (cronSecret && !hasValidCronAuthorization(request.headers, cronSecret)) {
      return createErrorResponse(401, "Unauthorized");
    }

    const cron = request.headers.get("x-vercel-cron-schedule");
    if (!cron) {
      return createErrorResponse(400, "Missing x-vercel-cron-schedule header");
    }

    await runtime.runCron(cron);
    return Response.json({ success: true });
  };
}

function hasValidCronAuthorization(headers: Headers, cronSecret: string): boolean {
  const actual = Buffer.from(headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function createErrorResponse(status: number, message: string): Response {
  return Response.json(
    {
      error: true,
      message,
      status,
      statusText: "",
    },
    { status },
  );
}
