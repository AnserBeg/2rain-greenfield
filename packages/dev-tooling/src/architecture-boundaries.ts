import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import { preProcessFile } from 'typescript';

export interface BoundaryViolation {
  file: string;
  line: number;
  ruleId: string;
  message: string;
}

export interface BoundaryCheckResult {
  scannedFiles: number;
  violations: BoundaryViolation[];
}

interface WorkspacePackage {
  directory: string;
  name: string;
  kind: PackageKind;
}

type PackageKind =
  'app' | 'compiler' | 'contracts' | 'domain' | 'runtime' | 'tooling' | 'other';

const sourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const dataExtensions = new Set(['.json', '.yaml', '.yml']);

const ignoredDirectories = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const protectedExternalImports = [
  /^react(?:-dom)?(?:\/|$)/,
  /^next(?:\/|$)/,
  /^@remix-run\//,
  /^openai(?:\/|$)/,
  /^@openai\//,
  /^@anthropic-ai\//,
  /^ai(?:\/|$)/,
  /^@ai-sdk\//,
  /^langchain(?:\/|$)/,
  /^@langchain\//,
  /^pg(?:\/|$)/,
  /^postgres(?:\/|$)/,
  /^drizzle-orm(?:\/|$)/,
  /^@prisma\//,
  /^knex(?:\/|$)/,
  /^kysely(?:\/|$)/,
  /^sequelize(?:\/|$)/,
  /^typeorm(?:\/|$)/,
  /^express(?:\/|$)/,
  /^fastify(?:\/|$)/,
  /^hono(?:\/|$)/,
];

const allowedErpTools = new Set([
  'erp_discover',
  'erp_execute',
  'erp_plan',
  'erp_query',
  'erp_verify',
]);

const ruleDefinitionPath =
  'packages/dev-tooling/src/architecture-boundaries.ts';

export function checkArchitecture(rootDirectory: string): BoundaryCheckResult {
  const root = resolve(rootDirectory);
  const files = productionFiles(root);
  const workspacePackages = workspacePackageIndex(root, files);
  const violations: BoundaryViolation[] = [];

  for (const file of files) {
    const repoPath = normalizePath(relative(root, file));
    const source = readFileSync(file, 'utf8');

    const owner = packageForFile(repoPath, workspacePackages);

    if (repoPath.endsWith('package.json')) {
      scanManifest(repoPath, source, owner, workspacePackages, violations);
    }
    if (
      repoPath === 'pnpm-lock.yaml' &&
      source.includes('@agent-native/core')
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        source.indexOf('@agent-native/core'),
        'AUTH001_AGENT_NATIVE_CORE',
        'lockfile contains the forbidden @agent-native/core dependency',
      );
    }
    if (sourceExtensions.has(extname(repoPath))) {
      scanImports(root, repoPath, source, owner, workspacePackages, violations);
    }

    if (
      repoPath !== ruleDefinitionPath &&
      (repoPath.startsWith('apps/') || repoPath.startsWith('packages/'))
    ) {
      scanAuthoritySignatures(repoPath, source, owner, violations);
    }
  }

  return {
    scannedFiles: files.length,
    violations: deduplicateViolations(violations).sort(compareViolations),
  };
}

export function formatViolations(result: BoundaryCheckResult): string {
  if (result.violations.length === 0) {
    return `architecture-boundaries: PASS (${result.scannedFiles} files scanned)`;
  }

  return [
    `architecture-boundaries: FAIL (${result.violations.length} violations)`,
    ...result.violations.map(
      (violation) =>
        `${violation.file}:${violation.line} [${violation.ruleId}] ${violation.message}`,
    ),
  ].join('\n');
}

function productionFiles(root: string): string[] {
  const files = new Set<string>();
  for (const rootFile of ['package.json', 'pnpm-lock.yaml']) {
    const path = join(root, rootFile);
    if (existsSync(path)) files.add(path);
  }
  for (const rootName of ['apps', 'packages']) {
    const path = join(root, rootName);
    if (existsSync(path)) walk(path, files);
  }
  return [...files].sort();
}

function walk(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) {
        walk(join(directory, entry.name), files);
      }
      continue;
    }

    const extension = extname(entry.name);
    if (sourceExtensions.has(extension) || dataExtensions.has(extension)) {
      files.add(join(directory, entry.name));
    }
  }
}

function workspacePackageIndex(
  root: string,
  files: string[],
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const file of files.filter((path) => path.endsWith('package.json'))) {
    const repoPath = normalizePath(relative(root, file));
    if (repoPath === 'package.json') continue;

    const parsed = parseJson(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed.name !== 'string') continue;
    const directory = normalizePath(dirname(repoPath));
    packages.push({
      directory,
      name: parsed.name,
      kind: packageKind(directory),
    });
  }
  return packages.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}

function packageKind(directory: string): PackageKind {
  if (directory.startsWith('apps/')) return 'app';
  const packageName = directory.split('/').at(-1) ?? '';
  if (packageName === 'canonical-model' || packageName === 'contracts') {
    return 'contracts';
  }
  if (packageName === 'compiler') return 'compiler';
  if (packageName === 'domain' || packageName.startsWith('domain-')) {
    return 'domain';
  }
  if (packageName === 'runtime' || packageName.endsWith('-runtime')) {
    return 'runtime';
  }
  if (packageName === 'dev-tooling' || packageName === 'test-contracts') {
    return 'tooling';
  }
  return 'other';
}

function packageForFile(
  repoPath: string,
  packages: WorkspacePackage[],
): WorkspacePackage | undefined {
  return packages.find(
    (workspacePackage) =>
      repoPath === workspacePackage.directory ||
      repoPath.startsWith(`${workspacePackage.directory}/`),
  );
}

function scanManifest(
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  packages: WorkspacePackage[],
  violations: BoundaryViolation[],
): void {
  const manifest = parseJson(source);
  if (!manifest) {
    addViolation(
      violations,
      repoPath,
      source,
      0,
      'CFG001_MANIFEST_JSON',
      'package manifest is not valid JSON',
    );
    return;
  }

  for (const dependencyGroup of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = manifest[dependencyGroup];
    if (!isRecord(dependencies)) continue;

    for (const dependencyName of Object.keys(dependencies)) {
      if (dependencyName === '@agent-native/core') {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf('@agent-native/core'),
          'AUTH001_AGENT_NATIVE_CORE',
          `${dependencyGroup} contains forbidden @agent-native/core`,
        );
      }

      const target = packages.find(
        (workspacePackage) => workspacePackage.name === dependencyName,
      );
      if (
        owner &&
        target &&
        owner.directory !== target.directory &&
        !workspaceDependencyAllowed(owner, target)
      ) {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'BND001_WORKSPACE_DIRECTION',
          `${owner.name} may not depend on ${target.name}; protected packages depend only on canonical contracts`,
        );
      }
    }
  }
}

function scanImports(
  root: string,
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  packages: WorkspacePackage[],
  violations: BoundaryViolation[],
): void {
  const imports = preProcessFile(source, true, true).importedFiles;
  for (const importedFile of imports) {
    const specifier = importedFile.fileName;
    const index = importedFile.pos;

    if (specifier === '@agent-native/core') {
      addViolation(
        violations,
        repoPath,
        source,
        index,
        'AUTH001_AGENT_NATIVE_CORE',
        'source imports forbidden @agent-native/core',
      );
    }

    const target = importedWorkspacePackage(
      root,
      repoPath,
      specifier,
      packages,
    );
    if (owner && target && owner.directory !== target.directory) {
      if (!workspaceDependencyAllowed(owner, target)) {
        addViolation(
          violations,
          repoPath,
          source,
          index,
          'BND001_WORKSPACE_DIRECTION',
          `${owner.name} may not import ${target.name}; protected packages depend only on canonical contracts`,
        );
      }
    }

    if (owner && isProtectedLayer(owner.kind)) {
      if (
        protectedExternalImports.some((pattern) => pattern.test(specifier)) ||
        /(?:^|\/)(?:apps|routes?|actions?)(?:\/|$)/i.test(specifier)
      ) {
        addViolation(
          violations,
          repoPath,
          source,
          index,
          'BND002_PROTECTED_IMPORT',
          `${owner.name} imports forbidden adapter/framework path ${specifier}`,
        );
      }
    }

    if (
      owner?.directory === 'apps/web' &&
      (protectedExternalImports.some((pattern) => pattern.test(specifier)) ||
        /(?:^|\/)(?:db|database|schema)(?:\/|$)/i.test(specifier))
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        index,
        'AUTH003_GATEWAY_BYPASS',
        `web surface imports direct provider/storage path ${specifier}`,
      );
    }
  }
}

function importedWorkspacePackage(
  root: string,
  repoPath: string,
  specifier: string,
  packages: WorkspacePackage[],
): WorkspacePackage | undefined {
  const named = packages.find(
    (workspacePackage) =>
      specifier === workspacePackage.name ||
      specifier.startsWith(`${workspacePackage.name}/`),
  );
  if (named) return named;
  if (!specifier.startsWith('.')) return undefined;

  const resolvedPath = normalizePath(
    relative(root, resolve(root, dirname(repoPath), specifier)),
  );
  return packageForFile(resolvedPath, packages);
}

function scanAuthoritySignatures(
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  violations: BoundaryViolation[],
): void {
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH001_AGENT_NATIVE_CORE',
    'source declares an @agent-native/core compatibility authority',
    /\b(?:agentNativeCompatibility|AgentNativeIdentityAdapter|AgentNativeActionRegistry)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH002_RELEASE_AUTHORITY',
    'source declares a forbidden alternate release/overlay authority',
    /\b(?:globalActiveRelease|defaultActiveRelease|ambientActiveRelease|deploymentGlobalActivation|activeOverlay|compiledOverlayId|runtimeCustomizationVersionId)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH003_GATEWAY_BYPASS',
    'source declares a private physical-action registry or gateway bypass',
    /\b(?:loadActionsFromStaticRegistry|physicalActionRegistry|privateActionRegistry|frameworkActionIds)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH004_INVENTORY_PEER',
    'source declares writable inventory state or a peer balance authority',
    /\b(?:currentQuantity|writableInventoryBalance|setInventoryBalance|patchInventoryBalance)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH006_HARD_DELETE',
    'source declares an ordinary hard-delete/purge path for business data',
    /\b(?:hardDeleteBusinessRecord|physicalDeleteBusinessRecord|purgeBusinessData)\b|\bDELETE\s+FROM\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH007_DUPLICATE_TRUST',
    'source declares a duplicate universal audit or actor-context authority',
    /\b(?:universalAuditJournal|parallelAuditJournal|secondaryActorContext|alternateActorContext|parallelChangeDocument)\b/g,
  );

  if (owner?.directory === 'apps/web') {
    addPatternViolations(
      violations,
      repoPath,
      source,
      'AUTH003_GATEWAY_BYPASS',
      'web surface calls storage directly instead of a semantic gateway',
      /\bgetDb\s*\(|\bdb\s*\.\s*(?:select|insert|update|delete|execute)\s*\(/g,
    );
  }

  for (const match of source.matchAll(/\berp_[a-z0-9_]+\b/g)) {
    const toolName = match[0];
    if (allowedErpTools.has(toolName)) continue;
    addViolation(
      violations,
      repoPath,
      source,
      match.index,
      'AUTH005_AGENT_TOOL',
      `model-facing surface exposes non-protocol ERP tool ${toolName}`,
    );
  }

  if (/(?:agent|tool|catalog|model-facing)/i.test(repoPath)) {
    addPatternViolations(
      violations,
      repoPath,
      source,
      'AUTH005_AGENT_TOOL',
      'model-facing source exposes a prohibited raw or administrative tool',
      /\b(?:rawDatabaseTool|sqlTool|shellTool|sourceEditingTool|filesystemTool|arbitraryHttpTool|activateReleaseTool|purgeTool|freeFormWriteTool)\b/g,
    );
  }
}

function isProtectedLayer(kind: PackageKind): boolean {
  return kind === 'compiler' || kind === 'contracts' || kind === 'domain';
}

function workspaceDependencyAllowed(
  owner: WorkspacePackage,
  target: WorkspacePackage,
): boolean {
  return (
    owner.kind === 'app' ||
    owner.kind === 'tooling' ||
    target.kind === 'contracts'
  );
}

function addPatternViolations(
  violations: BoundaryViolation[],
  repoPath: string,
  source: string,
  ruleId: string,
  message: string,
  pattern: RegExp,
): void {
  for (const match of source.matchAll(pattern)) {
    addViolation(
      violations,
      repoPath,
      source,
      match.index,
      ruleId,
      `${message}: ${match[0]}`,
    );
  }
}

function addViolation(
  violations: BoundaryViolation[],
  file: string,
  source: string,
  index: number,
  ruleId: string,
  message: string,
): void {
  violations.push({
    file,
    line: lineNumber(source, Math.max(0, index)),
    ruleId,
    message,
  });
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function parseJson(source: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(source);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/');
}

function deduplicateViolations(
  violations: BoundaryViolation[],
): BoundaryViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.file}:${violation.line}:${violation.ruleId}:${violation.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function compareViolations(
  left: BoundaryViolation,
  right: BoundaryViolation,
): number {
  return (
    left.file.localeCompare(right.file) ||
    left.line - right.line ||
    left.ruleId.localeCompare(right.ruleId) ||
    left.message.localeCompare(right.message)
  );
}
