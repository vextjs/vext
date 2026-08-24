import { detectProject } from "./utils/detect-project.js";
import { readRequiredOptionValue } from "./utils/command-args.js";

interface TypegenOptions {
  rootDir: string;
  services: boolean;
  appExtensions: boolean;
  checkOnly: boolean;
  json: boolean;
  verbose: boolean;
  writeManifest: boolean;
  help: boolean;
}

export async function typegenCommand(args: string[] = []): Promise<void> {
  const options = parseTypegenArgs(args);

  if (options.help) {
    printTypegenHelp();
    return;
  }

  const project = detectProject(options.rootDir);
  const { runTypegen } = await import("../tooling/typegen/index.js");

  const generateServices =
    options.services || (!options.services && !options.appExtensions);
  const generateAppExtensions =
    options.appExtensions || (!options.services && !options.appExtensions);

  const result = await runTypegen({
    rootDir: project.rootDir,
    generateServices,
    generateAppExtensions,
    generateShim: project.language === "ts",
    checkOnly: options.checkOnly,
    writeManifest: options.writeManifest,
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const file of result.files) {
      console.log(`[vext typegen] ${file.status}: ${file.filePath}`);
    }

    if (result.manifest) {
      console.log(
        `[vext typegen] ${result.manifest.status}: ${result.manifest.filePath}`,
      );
    }

    for (const warning of result.warnings) {
      console.warn(`[vext typegen] warning: ${warning}`);
    }

    for (const diagnostic of result.diagnostics) {
      const logger = diagnostic.level === "error" ? console.error : console.log;
      logger(`[vext typegen] ${diagnostic.level}: ${diagnostic.message}`);
    }
  }

  if (!result.ok) {
    throw new Error(
      "[vextjs] typegen found blocking issues. Resolve the reported diagnostics and try again.",
    );
  }
}

function parseTypegenArgs(args: string[]): TypegenOptions {
  const options: TypegenOptions = {
    rootDir: process.cwd(),
    services: false,
    appExtensions: false,
    checkOnly: false,
    json: false,
    verbose: false,
    writeManifest: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--services") {
      options.services = true;
    } else if (arg === "--app-extensions") {
      options.appExtensions = true;
    } else if (arg === "--check") {
      options.checkOnly = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "--write-manifest") {
      options.writeManifest = true;
    } else if (arg === "--root" || arg === "-C") {
      const parsed = readRequiredOptionValue(args, i, arg, "<path>");
      options.rootDir = parsed.value;
      i = parsed.nextIndex;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg?.startsWith("--")) {
      throw new Error(`[vextjs] Unknown option: "${arg}"`);
    } else {
      throw new Error(`[vextjs] Unknown argument: "${arg}"`);
    }
  }

  return options;
}

function printTypegenHelp(): void {
  console.log(`
  Usage: vext typegen [options]

  Generate type declarations and run tooling-only diagnostics (experimental).
  Positional arguments are not supported.
  Options that take values, such as --root/-C, require a non-option value.

  Options:
    --services          Only generate services declarations
    --app-extensions    Only generate app.extend declarations
    --check             Validate generated output without writing files
    --json              Print machine-readable JSON output
    --write-manifest    Write .vext/manifest/services.json
    --root <path>       Project root directory (default: current working directory)
    -C <path>           Alias of --root
    --verbose           Reserved for future verbose logging
    -h, --help          Show this help message

  Generated files:
    .vext/types/services.generated.d.ts
    .vext/types/app-extensions.generated.d.ts
    src/types/generated/index.d.ts  (TypeScript projects only)
    .vext/manifest/services.json  (optional)

  Examples:
    $ vext typegen
    $ vext typegen --check
    $ vext typegen --write-manifest
    $ vext typegen --services --root ./examples/hello-world
`);
}
