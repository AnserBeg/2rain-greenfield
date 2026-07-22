import {
  DEFAULT_COMPILER_LIMITS,
  DEFAULT_COMPILER_PROFILE,
  compileApplication,
} from '../../packages/compiler/src/index.js';

const encoded = process.argv[2];
if (!encoded) throw new Error('missing normalized fixture bytes');
const result = compileApplication({
  dependencies: [],
  expectedActiveRelease: null,
  kind: 'compilerInput',
  limits: { ...DEFAULT_COMPILER_LIMITS },
  normalizedDefinitionBytes: Uint8Array.from(Buffer.from(encoded, 'base64')),
  profile: { ...DEFAULT_COMPILER_PROFILE },
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
