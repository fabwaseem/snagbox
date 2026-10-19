import { LoggerService } from "@nestjs/common";
import pino, { type Logger } from "pino";

/**
 * Buffered destination so the last lines can be flushed synchronously.
 * Pino's default stream (minLength 0) hands each line to an async write;
 * `flush()` is a no-op there, and `process.exit` drops whatever is still in
 * that write. A 4KB buffer plus a short periodic flush keeps normal logs
 * moving, and `flushLogsSync` dumps the rest before we leave.
 */
const destination = pino.destination({
  dest: 1,
  sync: false,
  minLength: 4096,
  periodicFlush: 100,
});

export function createLogger(level: string): Logger {
  return pino(
    {
      level,
      base: { service: "snagbox" },
      redact: {
        paths: [
          "req.headers.authorization",
          "req.headers['x-api-key']",
          "req.headers.cookie",
          "req.headers['x-frontend-key']",
        ],
        remove: true,
      },
    },
    destination,
  );
}

/** Write every buffered log line before the process is allowed to end. */
export function flushLogsSync(): void {
  try {
    destination.flushSync();
  } catch {
    // The stream can already be closed when a second signal arrives.
  }
}

export const rootLogger = createLogger(process.env.LOG_LEVEL || "info");

function messageText(message: unknown): string {
  if (typeof message === "string") return message;
  if (message instanceof Error) return message.message;
  try {
    return JSON.stringify(message);
  } catch {
    return String(message);
  }
}

/** Nest logger that writes one JSON object per line through pino. */
export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger = rootLogger) {}

  log(message: unknown, ...optional: unknown[]): void {
    const { context } = this.contextOf(optional);
    this.logger.info({ context }, messageText(message));
  }

  error(message: unknown, ...optional: unknown[]): void {
    const { context, trace } = this.contextOf(optional);
    this.logger.error({ context, trace }, messageText(message));
  }

  warn(message: unknown, ...optional: unknown[]): void {
    const { context } = this.contextOf(optional);
    this.logger.warn({ context }, messageText(message));
  }

  debug(message: unknown, ...optional: unknown[]): void {
    const { context } = this.contextOf(optional);
    this.logger.debug({ context }, messageText(message));
  }

  verbose(message: unknown, ...optional: unknown[]): void {
    const { context } = this.contextOf(optional);
    this.logger.trace({ context }, messageText(message));
  }

  fatal(message: unknown, ...optional: unknown[]): void {
    const { context } = this.contextOf(optional);
    this.logger.fatal({ context }, messageText(message));
  }

  private contextOf(optional: unknown[]): { context?: string; trace?: string } {
    const strings = optional.filter((value): value is string => typeof value === "string");
    const trace = strings.find((value) => value.includes("\n"));
    const context = strings.filter((value) => value !== trace).at(-1);
    return { context, trace };
  }
}
