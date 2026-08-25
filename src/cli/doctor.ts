import { detectProject } from "./utils/detect-project.js";
import { readRequiredOptionValue } from "./utils/command-args.js";

interface DoctorOptions {
  target: "routes" | "all";
  rootDir: string;
  json: boolean;
  writeInspect: boolean;
  writeManifest: boolean;
  refresh: boolean;
  manifestOnly: boolean;
  help: boolean;
}

export async function doctorCommand(args: string[] = []): Promise<void> {
  const options = parseDoctorArgs(args);

  if (options.help) {
    printDoctorHelp();
    return;
  }

  const project = detectProject(options.rootDir);
  const { runDoctor } = await import("../tooling/doctor/index.js");
  const result = await runDoctor({
    rootDir: project.rootDir,
    target: options.target,
    writeInspect: options.writeInspect,
    writeManifest: options.writeManifest,
    refresh: options.refresh,
    manifestOnly: options.manifestOnly,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `[vext doctor] target=${result.target} routeFiles=${result.routeFileCount} routes=${result.routeCount} errors=${result.summary.errors} warnings=${result.summary.warnings} infos=${result.summary.infos}`,
    );

    if (result.inspect) {
      console.log(
        `[vext doctor] inspect=${result.inspect.filePath} (${result.inspect.status})`,
      );
    }

    if (result.manifest) {
      console.log(
        `[vext doctor] manifest=${result.manifest.filePath} (${result.manifest.status})`,
      );
    }

    for (const diagnostic of result.diagnostics) {
      const location = diagnostic.filePath
        ? ` (${diagnostic.filePath}${diagnostic.path ? ` -> ${diagnostic.path}` : ""})`
        : "";
      const suggestion = diagnostic.suggestedValue
        ? ` -> suggested: ${diagnostic.suggestedValue}`
        : "";
      const logger =
        diagnostic.level === "error" ? console.error : console.warn;
      logger(
        `[vext doctor] ${diagnostic.level}/${diagnostic.group}: ${diagnostic.message}${location}${suggestion}`,
      );
    }
  }

  if (!result.ok) {
    throw new Error(
      "[vextjs] doctor found blocking issues. Resolve the reported diagnostics and try again.",
    );
  }
}

function parseDoctorArgs(args: string[]): DoctorOptions {
  const options: DoctorOptions = {
    target: "routes",
    rootDir: process.cwd(),
    json: false,
    writeInspect: false,
    writeManifest: false,
    refresh: false,
    manifestOnly: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (!arg) continue;

    if (arg === "routes" || arg === "all") {
      options.target = arg;
    } else if (arg === "--root" || arg === "-C") {
      const parsed = readRequiredOptionValue(args, i, arg, "<path>");
      options.rootDir = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--write-inspect") {
      options.writeInspect = true;
    } else if (arg === "--write-manifest") {
      options.writeManifest = true;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg === "--manifest-only") {
      options.manifestOnly = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`[vextjs] Unknown option: "${arg}"`);
    } else {
      throw new Error(`[vextjs] Unknown doctor target: "${arg}"`);
    }
  }

  if (options.refresh && options.manifestOnly) {
    throw new Error(
      '[vextjs] Options "--refresh" and "--manifest-only" are mutually exclusive.',
    );
  }

  return options;
}

function printDoctorHelp(): void {
  console.log(`
  Usage: vext doctor <target> [options]

  Preview tooling-only diagnostics (experimental).
  Options that take values, such as --root/-C, require a non-option value.

  Targets:
    routes              Analyze static route metadata and duplicate definitions
    all                 Alias of routes for Phase 2 bootstrap

  Options:
    --json              Print machine-readable JSON output
    --write-inspect     Write .vext/inspect/routes.json for downstream tooling
    --write-manifest    Write .vext/manifest/routes.json for stable tooling consumers
    --refresh           Force rebuilding route diagnostics from current route sources
    --manifest-only     Read the stored manifest as an explicit snapshot, even when stale
    --root <path>       Project root directory (default: current working directory)
    -C <path>           Alias of --root
    -h, --help          Show this help message

  Examples:
    $ vext doctor routes
    $ vext doctor routes --write-inspect
    $ vext doctor routes --write-manifest
    $ vext doctor routes --json --root ./examples/hello-world
  `);
}
