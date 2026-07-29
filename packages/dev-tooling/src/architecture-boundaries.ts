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
  kind: PackageKind;
  name: string;
}

interface AuthorityDeclaration {
  file: string;
  index: number;
  name: string;
  ruleId: string;
  source: string;
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

const scannedExtensions = new Set([...sourceExtensions, '.json', '.sql']);

const ignoredDirectories = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const forbiddenProtectedImports = [
  /^react(?:-dom)?(?:\/|$)/,
  /^next(?:\/|$)/,
  /^@remix-run\//,
  /^openai(?:\/|$)/,
  /^@openai\//,
  /^@anthropic-ai\//,
  /^@ai-sdk\//,
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

const canonicalAuthorities = [
  ['ActiveReleasePointer', 'AUTH002_RELEASE_AUTHORITY'],
  ['AppPackageRevision', 'AUTH002_RELEASE_AUTHORITY'],
  ['TenantRelease', 'AUTH002_RELEASE_AUTHORITY'],
  ['InventoryMovement', 'AUTH004_INVENTORY_PEER'],
  ['Reservation', 'AUTH004_INVENTORY_PEER'],
  ['SemanticQueryGateway', 'AUTH003_GATEWAY_BYPASS'],
  ['SemanticOperationGateway', 'AUTH003_GATEWAY_BYPASS'],
  ['OperationsAgentToolProfile', 'AUTH005_AGENT_TOOL'],
  ['BusinessChangeDocument', 'AUTH007_DUPLICATE_TRUST'],
  ['RequestRuntimeView', 'AUTH007_DUPLICATE_TRUST'],
] as const;

const ruleDefinitionPath =
  'packages/dev-tooling/src/architecture-boundaries.ts';

export function checkArchitecture(rootDirectory: string): BoundaryCheckResult {
  const root = resolve(rootDirectory);
  const files = productionFiles(root);
  const workspacePackages = workspacePackageIndex(root, files);
  const violations: BoundaryViolation[] = [];
  const declarations: AuthorityDeclaration[] = [];

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
        'lockfile contains forbidden @agent-native/core',
      );
    }
    if (sourceExtensions.has(extname(repoPath))) {
      scanImports(root, repoPath, source, owner, workspacePackages, violations);
    }
    if (repoPath !== ruleDefinitionPath && isProductionPath(repoPath)) {
      scanPlainAuthorityViolations(repoPath, source, owner, violations);
      scanToolCatalog(repoPath, source, violations);
      if (sourceExtensions.has(extname(repoPath))) {
        collectPlainAuthorityDeclarations(repoPath, source, declarations);
      }
    }
  }

  rejectDuplicateAuthorities(declarations, violations);

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
  for (const rootName of ['apps', 'db', 'packages']) {
    const path = join(root, rootName);
    if (existsSync(path)) walk(path, files);
  }
  return [...files].sort();
}

function walk(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) walk(path, files);
      continue;
    }
    if (scannedExtensions.has(extname(entry.name))) files.add(path);
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
    const manifest = parseJson(readFileSync(file, 'utf8'));
    if (!manifest || typeof manifest.name !== 'string') continue;
    const directory = normalizePath(dirname(repoPath));
    packages.push({
      directory,
      kind: packageKind(directory),
      name: manifest.name,
    });
  }
  return packages.sort(
    (left, right) => right.directory.length - left.directory.length,
  );
}

function packageKind(directory: string): PackageKind {
  if (directory.startsWith('apps/')) return 'app';
  const name = directory.split('/').at(-1) ?? '';
  if (name === 'canonical-model' || name === 'contracts') return 'contracts';
  if (name === 'compiler') return 'compiler';
  if (name === 'domain' || name.startsWith('domain-')) return 'domain';
  if (name === 'runtime' || name.endsWith('-runtime')) return 'runtime';
  if (['dev-tooling', 'test-contracts', 'testing'].includes(name)) {
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

  for (const group of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = manifest[group];
    if (!isRecord(dependencies)) continue;
    for (const dependencyName of Object.keys(dependencies)) {
      if (dependencyName === '@agent-native/core') {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'AUTH001_AGENT_NATIVE_CORE',
          `${group} contains forbidden @agent-native/core`,
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
          `${owner.name} may not depend on ${target.name}`,
        );
      }
      if (
        owner &&
        isProtectedLayer(owner.kind) &&
        forbiddenProtectedImports.some((pattern) =>
          pattern.test(dependencyName),
        )
      ) {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'BND002_PROTECTED_IMPORT',
          `${owner.name} declares forbidden provider/framework dependency ${dependencyName}`,
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
  for (const importedFile of preProcessFile(source, true, true).importedFiles) {
    const specifier = importedFile.fileName;
    if (
      specifier === '@agent-native/core' ||
      specifier.startsWith('@agent-native/core/')
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        importedFile.pos,
        'AUTH001_AGENT_NATIVE_CORE',
        `source imports forbidden ${specifier}`,
      );
    }

    const target = importedWorkspacePackage(
      root,
      repoPath,
      specifier,
      packages,
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
        importedFile.pos,
        'BND001_WORKSPACE_DIRECTION',
        `${owner.name} may not import ${target.name}`,
      );
    }
    if (
      owner &&
      isProtectedLayer(owner.kind) &&
      forbiddenProtectedImports.some((pattern) => pattern.test(specifier))
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        importedFile.pos,
        'BND002_PROTECTED_IMPORT',
        `${owner.name} imports forbidden provider/framework path ${specifier}`,
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

function scanPlainAuthorityViolations(
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
    'source declares an agent-native compatibility authority',
    /\b(?:agentNativeCompatibility|AgentNativeCoreFacade|AgentNativeActionRegistry)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH002_RELEASE_AUTHORITY',
    'source declares an alternate release/overlay authority',
    /\b(?:globalActiveRelease|deploymentGlobalActivation|activeOverlay|tenantPackageOverlay)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH003_GATEWAY_BYPASS',
    'source declares a private physical-action registry',
    /\b(?:actionRegistry|physicalActionRegistry|loadActionsFromStaticRegistry)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH004_INVENTORY_PEER',
    'source declares writable inventory balance state',
    /\b(?:currentQuantity|writableInventoryBalance|setInventoryBalance|patchInventoryBalance)\b/g,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH006_HARD_DELETE',
    'source declares an ordinary hard-delete path',
    /\b(?:hardDeleteBusinessRecord|physicalDeleteBusinessRecord|purgeBusinessData)\b|\bDELETE\s+FROM\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH007_DUPLICATE_TRUST',
    'source declares a duplicate audit or actor-context authority',
    /\b(?:universalAuditJournal|secondaryActorContext|parallelChangeDocument)\b/g,
  );

  if (owner?.kind === 'app') {
    addPatternViolations(
      violations,
      repoPath,
      source,
      'AUTH003_GATEWAY_BYPASS',
      'application calls storage directly instead of a semantic gateway',
      /\b(?:db|database|repository)\s*\.\s*(?:delete|insert|query|select|update)\s*\(/g,
    );
  }

  scanPlainCrossDomainWrites(repoPath, source, violations);
}

function scanPlainCrossDomainWrites(
  repoPath: string,
  source: string,
  violations: BoundaryViolation[],
): void {
  const writes = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+([a-z][a-z0-9_]*)/gi;
  for (const match of source.matchAll(writes)) {
    const table = (match[2] ?? '').toLowerCase();
    if (!/(?:inventory|movement|reservation|stock)/.test(table)) continue;
    const inventoryOwner = repoPath.startsWith(
      'packages/domain/src/inventory/',
    );
    const appendOnlyMutation =
      /(?:movement|reservation)/.test(table) &&
      (match[1] ?? '').toUpperCase() !== 'INSERT INTO';
    const writableBalance = /(?:balance|quantity|stock)/.test(table);

    if (!inventoryOwner && !repoPath.startsWith('db/')) {
      addViolation(
        violations,
        repoPath,
        source,
        match.index,
        'AUTH003_GATEWAY_BYPASS',
        `cross-domain direct write targets ${table}`,
      );
    }
    if (appendOnlyMutation || writableBalance) {
      addViolation(
        violations,
        repoPath,
        source,
        match.index,
        'AUTH004_INVENTORY_PEER',
        `forbidden inventory mutation targets ${table}`,
      );
    }
  }
}

function scanToolCatalog(
  repoPath: string,
  source: string,
  violations: BoundaryViolation[],
): void {
  for (const match of source.matchAll(/\berp_[a-z0-9_]+\b/g)) {
    if (allowedErpTools.has(match[0])) continue;
    addViolation(
      violations,
      repoPath,
      source,
      match.index,
      'AUTH005_AGENT_TOOL',
      `source exposes sixth ERP tool ${match[0]}`,
    );
  }

  if (/(?:agent|tool|model-facing)/i.test(repoPath)) {
    addPatternViolations(
      violations,
      repoPath,
      source,
      'AUTH005_AGENT_TOOL',
      'model-facing source exposes a prohibited raw or administrative tool',
      /\b(?:rawDatabaseTool|sqlTool|shellTool|sourceEditingTool|filesystemTool|arbitraryHttpTool|activateReleaseTool|purgeTool|freeFormWriteTool)\b/g,
    );
  }

  if (extname(repoPath) !== '.json') return;
  const parsed = parseJson(source);
  if (!parsed || !Array.isArray(parsed.tools)) return;
  const tools = parsed.tools.filter(
    (tool): tool is string => typeof tool === 'string',
  );
  for (const tool of tools) {
    if (allowedErpTools.has(tool)) continue;
    addViolation(
      violations,
      repoPath,
      source,
      Math.max(0, source.indexOf(tool)),
      'AUTH005_AGENT_TOOL',
      `tool catalog exposes non-protocol tool ${tool}`,
    );
  }

  if (
    parsed.profile === 'operations-agent' ||
    /operations-agent-tool-profile/i.test(repoPath)
  ) {
    const distinct = new Set(tools);
    if (
      tools.length !== allowedErpTools.size ||
      distinct.size !== allowedErpTools.size ||
      [...allowedErpTools].some((tool) => !distinct.has(tool))
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        0,
        'AUTH005_AGENT_TOOL',
        'OperationsAgentToolProfile must contain exactly the five distinct protocol tools',
      );
    }
  }
}

function collectPlainAuthorityDeclarations(
  repoPath: string,
  source: string,
  declarations: AuthorityDeclaration[],
): void {
  for (const [name, ruleId] of canonicalAuthorities) {
    const pattern = new RegExp(
      `\\b(?:class|const|interface|let|type|var)\\s+${name}\\b`,
      'g',
    );
    for (const match of source.matchAll(pattern)) {
      declarations.push({
        file: repoPath,
        index: match.index,
        name,
        ruleId,
        source,
      });
    }
  }
}

function rejectDuplicateAuthorities(
  declarations: AuthorityDeclaration[],
  violations: BoundaryViolation[],
): void {
  for (const [name, ruleId] of canonicalAuthorities) {
    const matches = declarations.filter((item) => item.name === name);
    for (const duplicate of matches.slice(1)) {
      addViolation(
        violations,
        duplicate.file,
        duplicate.source,
        duplicate.index,
        ruleId,
        `duplicate canonical authority declaration ${name}`,
      );
    }
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
    owner.kind === 'other' ||
    target.kind === 'contracts'
  );
}

function isProductionPath(repoPath: string): boolean {
  return /^(?:apps|db|packages)\//.test(repoPath);
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
