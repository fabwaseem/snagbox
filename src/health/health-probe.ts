/** Cheap liveness path. Traefik and Coolify poll this during rollouts. */
export const LIVENESS_PATH = "/api/health";

let draining = false;

export function isDraining(): boolean {
  return draining;
}

export function beginDraining(): void {
  draining = true;
}

/** Test helper. Production shutdown never clears the flag. */
export function resetDraining(): void {
  draining = false;
}

export function isLivenessRequest(url: string | undefined): boolean {
  if (!url) return false;
  const path = url.split("?")[0] ?? "";
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  return normalized === LIVENESS_PATH;
}

export function healthProbe(): {
  statusCode: 200 | 503;
  body: { status: "ok" | "draining" };
} {
  if (draining) return { statusCode: 503, body: { status: "draining" } };
  return { statusCode: 200, body: { status: "ok" } };
}
