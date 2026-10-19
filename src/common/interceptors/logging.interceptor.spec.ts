import { ExecutionContext } from "@nestjs/common";
import { of } from "rxjs";
import { LoggingInterceptor } from "./logging.interceptor";

function context(url: string): ExecutionContext {
  const req = { method: "GET", originalUrl: url, url };
  const res = { statusCode: 200 };
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as ExecutionContext;
}

describe("LoggingInterceptor", () => {
  it("does not record the liveness probe", () => {
    const metrics = { recordHttp: jest.fn() };
    const interceptor = new LoggingInterceptor(metrics as never);
    interceptor.intercept(context("/api/health"), { handle: () => of({ status: "ok" }) }).subscribe();
    expect(metrics.recordHttp).not.toHaveBeenCalled();
  });

  it("records other routes", () => {
    const metrics = { recordHttp: jest.fn() };
    const interceptor = new LoggingInterceptor(metrics as never);
    interceptor.intercept(context("/v2/downloads"), { handle: () => of({ ok: true }) }).subscribe();
    expect(metrics.recordHttp).toHaveBeenCalledWith("GET", "200");
  });
});
