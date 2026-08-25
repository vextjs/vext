import type { VextCorsConfig } from "../types/app.js";

/** Shared fail-fast assertion for global, route, and runtime CORS consumers. */
export function assertCorsCredentialPolicy(
  config: Pick<VextCorsConfig, "origins" | "credentials">,
  pathName = "CORS config",
): void {
  const origins = config.origins ?? ["*"];
  if (config.credentials === true && origins.includes("*")) {
    throw new Error(
      `[vextjs] ${pathName} cannot combine credentials: true with wildcard origin "*". Declare explicit origins instead.`,
    );
  }
}
