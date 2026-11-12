// Copyright (c) 2026 Naotsun

/**
 * Builds the Verse project (.vproject) that the language server reads.
 *
 * UnrealBuildTool writes Engine/Intermediate/Build/Win64/verse/VNI.vproject while it builds verse.exe. That file
 * already lists every package verse.exe compiles against: the /Verse.org standard library and verse.exe's own
 * input/output functions. The workspace project is that list plus one package per folder of user code.
 */

/**
 * Engine packages left out of the workspace project. The language server bundled with UEFN is built from a different
 * Verse version than ue6-main and rejects their `<predicts>` struct members (V3604). User code does not need them.
 */
export const EXCLUDED_ENGINE_PACKAGES: readonly string[] = [
  'VerseSpatialMath/VerseSpatialMath',
  'EpicGamesEngineRestricted/EpicGamesEngineRestricted',
  'VerseSimulationMetadata/VerseSimulationMetadata',
] as const;

/** Verse path that verse.exe gives the script it runs, so the language server resolves names the same way. */
export const USER_VERSE_PATH = '/user@localhost';

/** Prefix of the package names generated for user folders. */
const USER_PACKAGE_PREFIX = 'VersePlayground';

/** Settings of one package, as the Verse compiler reads them from a .vproject file. */
export interface VersePackageSettings {
  /** Verse path that the package's modules live under, such as /Verse.org. */
  versePath?: string;

  /** Who may see the package's definitions, such as PublicAPI or PublicUser. */
  verseScope?: string;

  /** Source for code that is compiled, External for digests. Omitted for engine packages. */
  role?: string;

  /** Names of the packages this package can use. */
  dependencyPackages?: string[];

  /** Whether native attributes are allowed. Engine packages need it to declare natively implemented functions. */
  enableVNI?: boolean;

  /** Folder that VNI glue code would be generated into. */
  vniDestDir?: string;

  /** Whether experimental language features are allowed. verse.exe allows them for scripts. */
  allowExperimental?: boolean;

  /** Settings this module does not touch are kept as they are. */
  [otherSetting: string]: unknown;
}

/** One package entry of a .vproject file. */
export interface VersePackageEntry {
  /** Where the package is and how to compile it. */
  desc: {
    /** Unique name that other packages refer to in dependencyPackages. */
    name: string;

    /** Unused by this project, kept because the compiler expects the field. */
    publicName?: string;

    /** Folder whose .verse files belong to the package. */
    dirPath: string;

    /** Compiler settings of the package. */
    settings: VersePackageSettings;
  };

  /** Whether the language server should treat the files as not editable. */
  readOnly?: boolean;

  /** Fields this module does not touch are kept as they are. */
  [otherField: string]: unknown;
}

/** Contents of a .vproject file. */
export interface VerseProject {
  /** Every package of the project. */
  packages: VersePackageEntry[];

  /** Fields this module does not touch are kept as they are. */
  [otherField: string]: unknown;
}

/**
 * Builds the workspace project from the text of VNI.vproject.
 *
 * Engine packages become read-only, lose the packages in {@link EXCLUDED_ENGINE_PACKAGES}, and point their VNI
 * output at `vniOutputDir` so the language server never writes into the engine checkout. Each folder in
 * `userFolders` becomes its own package, because the language server treats a folder as one package and two Main
 * functions in one package are ambiguous (V3532).
 *
 * @throws Error when the text is not a Verse project.
 */
export function buildWorkspaceProject(
  vniProjectText: string,
  userFolders: readonly string[],
  vniOutputDir: string,
): VerseProject {
  const vniProject = parseVerseProject(vniProjectText);
  const excludedNames = new Set<string>(EXCLUDED_ENGINE_PACKAGES);

  const enginePackages = vniProject.packages
    .filter((packageEntry) => !excludedNames.has(packageEntry.desc.name))
    .map((packageEntry): VersePackageEntry => ({
      ...packageEntry,
      desc: {
        ...packageEntry.desc,
        settings: {
          ...packageEntry.desc.settings,
          dependencyPackages: (packageEntry.desc.settings.dependencyPackages ?? [])
            .filter((dependencyName) => !excludedNames.has(dependencyName)),
          // Without VNI the engine's .native.verse files are rejected with "Native attributes are not allowed".
          enableVNI: true,
          vniDestDir: vniOutputDir,
        },
      },
      readOnly: true,
    }));

  const enginePackageNames = enginePackages.map((packageEntry) => packageEntry.desc.name);
  const userPackages = userFolders.map((userFolder, folderIndex): VersePackageEntry => ({
    desc: {
      name: `${USER_PACKAGE_PREFIX}/${folderIndex}`,
      publicName: '',
      dirPath: userFolder,
      settings: {
        versePath: USER_VERSE_PATH,
        verseScope: 'PublicUser',
        role: 'Source',
        dependencyPackages: [...enginePackageNames],
        allowExperimental: true,
      },
    },
    readOnly: false,
  }));

  return { ...vniProject, packages: [...userPackages, ...enginePackages] };
}

/**
 * Returns the distinct folders that contain the given files, sorted so the generated project is stable and the
 * package numbers do not change when files are listed in a different order.
 */
export function toSourceFolders(verseFilePaths: readonly string[], dirname: (filePath: string) => string): string[] {
  const folderByKey = new Map<string, string>();
  for (const verseFilePath of verseFilePaths) {
    const folder = dirname(verseFilePath);
    folderByKey.set(folder.toLowerCase(), folder);
  }
  return [...folderByKey.entries()]
    .sort(([firstKey], [secondKey]) => firstKey.localeCompare(secondKey))
    .map(([, folder]) => folder);
}

/** Parses a .vproject file and checks the fields this module relies on. */
function parseVerseProject(projectText: string): VerseProject {
  const parsedProject: unknown = JSON.parse(projectText);
  if (
    typeof parsedProject !== 'object' ||
    parsedProject === null ||
    !('packages' in parsedProject) ||
    !Array.isArray(parsedProject.packages)
  ) {
    throw new Error('The Verse project has no "packages" array.');
  }

  for (const packageEntry of parsedProject.packages as unknown[]) {
    if (!isPackageEntry(packageEntry)) {
      throw new Error('A package in the Verse project has no "desc" with "name", "dirPath" and "settings".');
    }
  }
  return parsedProject as VerseProject;
}

/** Returns true when the value has the fields of a package entry that this module reads. */
function isPackageEntry(value: unknown): value is VersePackageEntry {
  if (typeof value !== 'object' || value === null || !('desc' in value)) {
    return false;
  }

  const packageDesc: unknown = value.desc;
  return (
    typeof packageDesc === 'object' &&
    packageDesc !== null &&
    'name' in packageDesc &&
    typeof packageDesc.name === 'string' &&
    'dirPath' in packageDesc &&
    typeof packageDesc.dirPath === 'string' &&
    'settings' in packageDesc &&
    typeof packageDesc.settings === 'object' &&
    packageDesc.settings !== null
  );
}
