import { ChannelGateDeniedError } from "#channel/gate-errors.js";
import { logError, type Logger } from "#internal/logging.js";

/**
 * Logs webhook delivery failures while treating authored denials as expected
 * policy drops rather than transport or infrastructure errors.
 */
export function logChannelOperationFailure(
  logger: Logger,
  message: string,
  error: unknown,
  fields?: Readonly<Record<string, unknown>>,
): void {
  if (error instanceof ChannelGateDeniedError) {
    logger.info(`${message} — denied`, {
      ...fields,
      gate: error.gate,
      reason: error.reason,
    });
    return;
  }
  logError(logger, message, error, fields);
}
