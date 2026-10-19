import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { Observable } from "rxjs";
import { tap } from "rxjs/operators";
import { isLivenessRequest } from "../../health/health-probe";
import { MetricsService } from "../../metrics/metrics.service";

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger("HTTP");

  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    if (isLivenessRequest(req.originalUrl || req.url)) return next.handle();
    const started = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.metrics.recordHttp(req.method, String(res.statusCode));
          this.logger.log(
            `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - started}ms`,
          );
        },
        error: () => {
          this.metrics.recordHttp(req.method, String(res.statusCode || 500));
        },
      }),
    );
  }
}
