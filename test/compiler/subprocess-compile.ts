import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  compileApplication,
} from '../../packages/compiler/src/index.js';

const encoded = process.argv[2];
if (!encoded) throw new Error('missing normalized fixture bytes');
const normalizedDefinitionBytes = Uint8Array.from(
  Buffer.from(encoded, 'base64'),
);
// Version-from-artifact: this subprocess must compile the fixture it is handed
// at the version that fixture declares, not at whatever the default profile
// currently adopts. Pinning the default made a determinism control fail the
// moment adoption moved, which measures the constant rather than determinism.
const declared = JSON.parse(
  new TextDecoder().decode(normalizedDefinitionBytes),
) as {
  languageVersion?: string;
  normalizationProfileVersion?: string;
};
const result = compileApplication({
  dependencies: [],
  expectedActiveRelease: null,
  kind: 'compilerInput',
  limits: { ...DEFAULT_COMPILER_LIMITS },
  normalizedDefinitionBytes,
  profile: {
    ...DEFAULT_COMPILER_PROFILE,
    ...(declared.languageVersion === undefined
      ? {}
      : {
          languageVersion:
            declared.languageVersion as (typeof DEFAULT_COMPILER_PROFILE)['languageVersion'],
        }),
    ...(declared.normalizationProfileVersion === undefined
      ? {}
      : {
          normalizationProfileVersion:
            declared.normalizationProfileVersion as (typeof DEFAULT_COMPILER_PROFILE)['normalizationProfileVersion'],
        }),
  },
});
if (result.status !== 'compiled') {
  process.stdout.write(JSON.stringify(result));
  process.exitCode = 1;
} else {
  process.stdout.write(
    JSON.stringify({
      artifactHashes: result.bundle.artifacts.map((entry) => entry.contentHash),
      releaseManifest: new TextDecoder().decode(
        result.bundle.releaseManifestBytes,
      ),
      releaseRoot: result.releaseRoot,
    }),
  );
}
