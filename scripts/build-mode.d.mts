export declare const BUILD_MODE_FILE: 'build-mode.json';
export type BuildModeSwitchName =
  | 'migrationListByGlob'
  | 'recordChecksReportOnly'
  | 'languageCoverageDigestRegeneration'
  | 'nameGuardReportOnly'
  | 'trainCapLifted';
export declare const BUILD_MODE_SWITCHES: readonly BuildModeSwitchName[];
export declare function buildModeSwitch(
  name: BuildModeSwitchName,
  options?: {
    root?: string;
    env?: Record<string, string | undefined>;
  },
): boolean;
