type AssetsBinding = (request: Request) => Promise<Response>;

/**
 * Builds a Pages `ASSETS` binding function from a static assets directory.
 */
export async function buildPagesASSETSBinding(assetsPath: string): Promise<AssetsBinding> {
  if (typeof assetsPath !== "string") {
    throw new TypeError(
      "Failed to execute 'buildPagesASSETSBinding': parameter 1 is not of type 'string'."
    );
  }

  const { unstable_generateASSETSBinding } = await import("wrangler");
  const log = {
    ...console,
    debugWithSanitization: console.debug,
    loggerLevel: "info",
    columns: process.stdout.columns
  };

  return unstable_generateASSETSBinding({
    log: log as unknown as Parameters<typeof unstable_generateASSETSBinding>[0]["log"],
    directory: assetsPath
  }) as unknown as AssetsBinding;
}
