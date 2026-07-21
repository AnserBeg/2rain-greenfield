import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';

import {
  createSourceFile,
  forEachChild,
  isClassDeclaration,
  isEnumDeclaration,
  isExportSpecifier,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isModuleDeclaration,
  isTypeAliasDeclaration,
  isVariableDeclaration,
  preProcessFile,
  ScriptTarget,
} from 'typescript';

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

interface AuthorityRule {
  name: string;
  ruleId: string;
  allowedDirectories: string[];
}

interface AuthorityDeclaration {
  rule: AuthorityRule;
  file: string;
  source: string;
  index: number;
}

type PackageKind =
  | 'app'
  | 'compiler'
  | 'contracts'
  | 'domain'
  | 'runtime'
  | 'tooling'
  | 'unclassified';

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

const dataExtensions = new Set(['.json', '.sql', '.yaml', '.yml']);

const ignoredDirectories = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'test-results',
]);

const emittedArtifactDirectories = new Set(['build', 'dist']);

const allowedProtectedExternalImports = [
  /^node:/,
  /^decimal\.js(?:\/|$)/,
  /^typescript(?:\/|$)/,
  /^zod(?:\/|$)/,
  /^@standard-schema\/spec(?:\/|$)/,
];

const allowedErpTools = new Set([
  'erp_discover',
  'erp_execute',
  'erp_plan',
  'erp_query',
  'erp_verify',
]);

const authorityRules: AuthorityRule[] = [
  {
    name: 'ActiveReleasePointer',
    ruleId: 'AUTH002_RELEASE_AUTHORITY',
    allowedDirectories: [
      'packages/canonical-model',
      'packages/contracts',
      'packages/platform-runtime',
    ],
  },
  {
    name: 'AppPackageRevision',
    ruleId: 'AUTH002_RELEASE_AUTHORITY',
    allowedDirectories: ['packages/canonical-model', 'packages/contracts'],
  },
  {
    name: 'TenantRelease',
    ruleId: 'AUTH002_RELEASE_AUTHORITY',
    allowedDirectories: [
      'packages/canonical-model',
      'packages/contracts',
      'packages/platform-runtime',
    ],
  },
  {
    name: 'RequestRuntimeView',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: [
      'packages/canonical-model',
      'packages/contracts',
      'packages/platform-runtime',
    ],
  },
  {
    name: 'ReleaseApproval',
    ruleId: 'AUTH002_RELEASE_AUTHORITY',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'InventoryMovement',
    ruleId: 'AUTH004_INVENTORY_PEER',
    allowedDirectories: [
      'packages/canonical-model',
      'packages/contracts',
      'packages/domain-inventory',
    ],
  },
  {
    name: 'Reservation',
    ruleId: 'AUTH004_INVENTORY_PEER',
    allowedDirectories: [
      'packages/canonical-model',
      'packages/contracts',
      'packages/domain-inventory',
    ],
  },
  {
    name: 'SemanticQueryGateway',
    ruleId: 'AUTH003_GATEWAY_BYPASS',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'SemanticOperationGateway',
    ruleId: 'AUTH003_GATEWAY_BYPASS',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'OperationsAgentToolProfile',
    ruleId: 'AUTH005_AGENT_TOOL',
    allowedDirectories: [
      'packages/contracts',
      'packages/platform-runtime',
      'packages/agent-runtime',
    ],
  },
  {
    name: 'ActionInvocation',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'BusinessChangeDocument',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'LifecycleService',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'CorrectionLink',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
  {
    name: 'RecoveryService',
    ruleId: 'AUTH007_DUPLICATE_TRUST',
    allowedDirectories: ['packages/contracts', 'packages/platform-runtime'],
  },
];

const ruleDefinitionPath =
  'packages/dev-tooling/src/architecture-boundaries.ts';

export function checkArchitecture(rootDirectory: string): BoundaryCheckResult {
  const root = resolve(rootDirectory);
  const violations: BoundaryViolation[] = [];
  const files = productionFiles(root);
  const workspacePackages = workspacePackageIndex(root, violations);
  const authorityDeclarations: AuthorityDeclaration[] = [];

  for (const file of files) {
    const repoPath = normalizePath(relative(root, file));
    const source = readFileSync(file, 'utf8');
    const owner = packageForFile(repoPath, workspacePackages);

    if (repoPath !== ruleDefinitionPath) {
      scanAgentNativeReference(repoPath, source, violations);
    }
    if (repoPath.endsWith('package.json')) {
      scanManifest(repoPath, source, owner, workspacePackages, violations);
    }
    if (sourceExtensions.has(extname(repoPath))) {
      scanImports(root, repoPath, source, owner, workspacePackages, violations);
    }

    if (repoPath !== ruleDefinitionPath && isProductionPath(repoPath)) {
      scanAuthoritySignatures(repoPath, source, owner, violations);
      if (
        sourceExtensions.has(extname(repoPath)) &&
        !repoPath.startsWith('build/') &&
        !repoPath.startsWith('dist/')
      ) {
        collectAuthorityDeclarations(repoPath, source, authorityDeclarations);
      }
    }
  }

  validateAuthorityDeclarations(authorityDeclarations, violations);

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
  for (const artifactRoot of emittedArtifactDirectories) {
    const path = join(root, artifactRoot);
    if (existsSync(path)) walkEmittedArtifacts(path, files);
  }
  return [...files].sort();
}

function walk(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (emittedArtifactDirectories.has(entry.name)) {
        walkEmittedArtifacts(path, files);
      } else if (!ignoredDirectories.has(entry.name)) {
        walk(path, files);
      }
      continue;
    }

    const extension = extname(entry.name);
    if (sourceExtensions.has(extension) || dataExtensions.has(extension)) {
      files.add(path);
    }
  }
}

function walkEmittedArtifacts(directory: string, files: Set<string>): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') walkEmittedArtifacts(path, files);
      continue;
    }

    if (
      (dataExtensions.has(extname(entry.name)) ||
        sourceExtensions.has(extname(entry.name))) &&
      isModelFacingPath(normalizePath(path))
    ) {
      files.add(path);
    }
  }
}

function workspacePackageIndex(
  root: string,
  violations: BoundaryViolation[],
): WorkspacePackage[] {
  const packages: WorkspacePackage[] = [];
  for (const rootName of ['apps', 'packages']) {
    const rootPath = join(root, rootName);
    if (!existsSync(rootPath)) continue;

    for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
      if (!entry.isDirectory() || ignoredDirectories.has(entry.name)) continue;
      const directory = `${rootName}/${entry.name}`;
      const manifestPath = join(rootPath, entry.name, 'package.json');
      let name = `<unnamed:${directory}>`;

      if (!existsSync(manifestPath)) {
        addViolation(
          violations,
          `${directory}/package.json`,
          '',
          0,
          'CFG002_PACKAGE_IDENTITY',
          'production package is missing package.json',
        );
      } else {
        const source = readFileSync(manifestPath, 'utf8');
        const parsed = parseJson(source);
        if (!parsed || typeof parsed.name !== 'string' || parsed.name === '') {
          addViolation(
            violations,
            `${directory}/package.json`,
            source,
            0,
            'CFG002_PACKAGE_IDENTITY',
            'production package must declare a non-empty name',
          );
        } else {
          name = parsed.name;
        }
      }

      const kind = packageKind(directory);
      if (kind === 'unclassified') {
        addViolation(
          violations,
          `${directory}/package.json`,
          '',
          0,
          'CFG003_PACKAGE_CLASSIFICATION',
          'production package is not classified by the dependency policy',
        );
      }
      packages.push({ directory, name, kind });
    }
  }

  const byName = new Map<string, WorkspacePackage[]>();
  for (const workspacePackage of packages) {
    if (workspacePackage.name.startsWith('<unnamed:')) continue;
    const matches = byName.get(workspacePackage.name) ?? [];
    matches.push(workspacePackage);
    byName.set(workspacePackage.name, matches);
  }
  for (const [name, matches] of byName) {
    if (matches.length < 2) continue;
    for (const match of matches) {
      addViolation(
        violations,
        `${match.directory}/package.json`,
        '',
        0,
        'CFG002_PACKAGE_IDENTITY',
        `duplicate workspace package name ${name}`,
      );
    }
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
  if (
    packageName === 'dev-tooling' ||
    packageName === 'test-contracts' ||
    packageName === 'testing'
  ) {
    return 'tooling';
  }
  return 'unclassified';
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

function scanAgentNativeReference(
  repoPath: string,
  source: string,
  violations: BoundaryViolation[],
): void {
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH001_AGENT_NATIVE_CORE',
    'production artifact references forbidden @agent-native/core',
    /@agent-native\/core(?:\b|\/)/g,
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

  if (containsAgentNativeReference(manifest)) {
    addViolation(
      violations,
      repoPath,
      source,
      Math.max(0, source.indexOf('@agent-native/core')),
      'AUTH001_AGENT_NATIVE_CORE',
      'parsed manifest contains a forbidden @agent-native/core key, alias, patch, or override',
    );
  }

  for (const dependencyGroup of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    const dependencies = manifest[dependencyGroup];
    if (!isRecord(dependencies)) continue;

    for (const [dependencyName, dependencyRange] of Object.entries(
      dependencies,
    )) {
      if (typeof dependencyRange !== 'string') {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'CFG004_DEPENDENCY_TARGET',
          `${dependencyGroup}.${dependencyName} must be a string dependency target`,
        );
        continue;
      }

      const effectiveName = normalizedDependencyTarget(
        dependencyName,
        dependencyRange,
      );
      if (
        effectiveName === '@agent-native/core' ||
        effectiveName.startsWith('@agent-native/core/')
      ) {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'AUTH001_AGENT_NATIVE_CORE',
          `${dependencyGroup}.${dependencyName} resolves to forbidden ${effectiveName}`,
        );
      }

      const target = packages.find(
        (workspacePackage) => workspacePackage.name === effectiveName,
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

      if (
        owner &&
        isProtectedLayer(owner.kind) &&
        !target &&
        !externalSpecifierAllowed(effectiveName)
      ) {
        addViolation(
          violations,
          repoPath,
          source,
          source.indexOf(dependencyName),
          'BND002_PROTECTED_IMPORT',
          `${owner.name} declares external dependency ${effectiveName} outside the protected-layer allowlist`,
        );
      }
    }
  }
}

function normalizedDependencyTarget(name: string, range: string): string {
  const alias = range.match(
    /^(?:npm|patch|workspace):((?:@[^/@]+\/[^@/]+)|(?:[a-z0-9][^@/:]*))/i,
  );
  return alias?.[1] ?? name;
}

function containsAgentNativeReference(value: unknown): boolean {
  if (typeof value === 'string') {
    return /@agent-native\/core(?:\b|\/)/.test(value);
  }
  if (Array.isArray(value)) return value.some(containsAgentNativeReference);
  if (!isRecord(value)) return false;
  return Object.entries(value).some(
    ([key, nested]) =>
      /@agent-native\/core(?:\b|\/)/.test(key) ||
      containsAgentNativeReference(nested),
  );
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
        index,
        'BND001_WORKSPACE_DIRECTION',
        `${owner.name} may not import ${target.name}; protected packages depend only on canonical contracts`,
      );
    }

    if (
      owner &&
      isProtectedLayer(owner.kind) &&
      !target &&
      !specifier.startsWith('.') &&
      !externalSpecifierAllowed(specifier)
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        index,
        'BND002_PROTECTED_IMPORT',
        `${owner.name} imports external path ${specifier} outside the protected-layer allowlist`,
      );
    }

    if (
      owner?.kind === 'app' &&
      /(?:^|\/)(?:db|database|repositories?|schema|tables?)(?:\/|$)/i.test(
        specifier,
      )
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        index,
        'AUTH003_GATEWAY_BYPASS',
        `${owner.name} imports direct storage internals ${specifier}`,
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
    'production source declares an agent-native compatibility facade',
    /\b(?:agent[_-]?native\w*(?:adapter|compatibility|facade|registry|shim)|(?:adapter|compatibility|facade|registry|shim)\w*agent[_-]?native)\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH002_RELEASE_AUTHORITY',
    'source declares a forbidden alternate release, manifest, or overlay authority',
    /\b(?:\w*global\w*(?:active|activation|release)\w*|\w*(?:active|compiled|package|tenant)\w*overlay\w*|\w*active\w*manifest\w*|\w*manifest\w*provider\w*|runtimeCustomizationVersion\w*)\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH003_GATEWAY_BYPASS',
    'source declares a private physical-action registry or gateway bypass',
    /\b(?:\w*(?:physical|private|framework)\w*action\w*registry\w*|actionRegistry|loadActionsFromStaticRegistry|frameworkActionIds)\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH004_INVENTORY_PEER',
    'source declares writable inventory state or a peer balance authority',
    /\b(?:currentQuantity|\w*writable\w*(?:inventory|stock)\w*|(?:delete|overwrite|patch|set|update)\w*(?:inventory|stock)\w*(?:balance|quantity)|(?:inventory|stock)\w*(?:balance|onHand)\w*(?:store|table))\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH006_HARD_DELETE',
    'source declares an ordinary hard-delete or purge path',
    /\b(?:hard|physical|permanent)\w*delete\w*|\bpurge\w*(?:business|record|data)\w*|\b(?:DELETE\s+FROM|DROP\s+TABLE|TRUNCATE(?:\s+TABLE)?)\b/gi,
  );
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH007_DUPLICATE_TRUST',
    'source declares a duplicate audit, change-document, or actor-context authority',
    /\b(?:\w*(?:parallel|secondary|alternate|universal)\w*(?:audit|actorContext|changeDocument)\w*|BusinessAuditLedger|ActorContextStore)\b/gi,
  );

  scanStorageCalls(repoPath, source, owner, violations);
  scanDirectTableAccess(repoPath, source, owner, violations);
  scanInventoryWrites(repoPath, source, owner, violations);
  scanAgentTools(repoPath, source, violations);
}

function scanDirectTableAccess(
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  violations: BoundaryViolation[],
): void {
  const tableReference =
    /\b(?:DELETE\s+FROM|FROM|INSERT\s+INTO|JOIN|UPDATE)\s+["`]?([a-z][a-z0-9_.]*)/gi;
  const ownerDomain = owner?.directory.startsWith('packages/domain-')
    ? owner.directory.slice('packages/domain-'.length)
    : undefined;
  const knownDomains = ['catalog', 'inventory', 'party', 'purchasing', 'sales'];

  for (const match of source.matchAll(tableReference)) {
    const qualifiedTable = (match[1] ?? '').toLowerCase();
    const tableParts = qualifiedTable.split('.');
    const table = tableParts.at(-1) ?? '';
    const tableDomain = knownDomains.find(
      (domain) =>
        tableParts[0] === domain ||
        table === domain ||
        table.startsWith(`${domain}_`),
    );
    const isAppSql = owner?.kind === 'app';
    const isCrossDomain =
      ownerDomain !== undefined &&
      tableDomain !== undefined &&
      tableDomain !== ownerDomain;
    if (!isAppSql && !isCrossDomain) continue;

    addViolation(
      violations,
      repoPath,
      source,
      match.index,
      'AUTH003_GATEWAY_BYPASS',
      isAppSql
        ? `application channel contains direct table access ${table}`
        : `${owner?.name ?? 'domain package'} accesses cross-domain table ${table}`,
    );
  }
}

function scanStorageCalls(
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  violations: BoundaryViolation[],
): void {
  const storageMutation =
    /\b(?:(?:db|database|entityManager|orm|repo|repository|store|prisma(?:\s*\.\s*\w+)?)\s*\.\s*(?:aggregate|clear|count|create|createMany|delete|deleteFrom|deleteMany|destroy|execute|findFirst|findMany|findUnique|insert|query|remove|save|select|update|upsert)|(?:client|pool)\s*\.\s*(?:execute|query))\s*\(/gi;
  if (owner?.kind === 'app') {
    addPatternViolations(
      violations,
      repoPath,
      source,
      'AUTH003_GATEWAY_BYPASS',
      'application channel calls storage directly instead of a semantic gateway',
      storageMutation,
    );
  }

  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH006_HARD_DELETE',
    'source invokes an ordinary repository hard-delete method',
    /\b(?:db|database|entityManager|orm|repo|repository|store|prisma(?:\s*\.\s*\w+)?)\s*\.\s*(?:clear|delete|deleteFrom|deleteMany|destroy|remove)\s*\(|\.createQueryBuilder\s*\([^)]*\)\s*\.\s*delete\s*\(|\.delete\s*\(\s*\)\s*\.\s*from\s*\(/gi,
  );
}

function scanInventoryWrites(
  repoPath: string,
  source: string,
  owner: WorkspacePackage | undefined,
  violations: BoundaryViolation[],
): void {
  const writePattern =
    /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?([a-z][a-z0-9_.]*)/gi;
  for (const match of source.matchAll(writePattern)) {
    const operation = (match[1] ?? '').toUpperCase().replaceAll(/\s+/g, ' ');
    const table = (match[2] ?? '').toLowerCase().split('.').at(-1) ?? '';
    if (!/(?:inventory|stock|reservation|movement)/.test(table)) continue;

    const isBalance = /(?:balance|on_hand|onhand|quantity|stock)/.test(table);
    const isAppendOnlyFact = /(?:movement|reservation)/.test(table);
    const isCrossDomain =
      owner !== undefined &&
      owner.directory !== 'packages/domain-inventory' &&
      !repoPath.startsWith('db/');
    if (
      isBalance ||
      isCrossDomain ||
      (isAppendOnlyFact && operation !== 'INSERT INTO')
    ) {
      addViolation(
        violations,
        repoPath,
        source,
        match.index,
        'AUTH004_INVENTORY_PEER',
        `forbidden inventory write ${operation} ${table}`,
      );
    }
  }

  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH004_INVENTORY_PEER',
    'source invokes a direct ORM/repository inventory mutation',
    /\b(?:db|database|orm|prisma|repo|repository)\s*\.\s*(?:inventory|stock|reservation|movement)\w*(?:\s*\.\s*\w+)?\s*\.\s*(?:create|delete|deleteMany|insert|remove|save|update)\s*\(/gi,
  );
}

function scanAgentTools(
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
      `model-facing surface exposes non-protocol ERP tool ${match[0]}`,
    );
  }

  if (!isModelFacingPath(repoPath)) return;
  addPatternViolations(
    violations,
    repoPath,
    source,
    'AUTH005_AGENT_TOOL',
    'model-facing artifact exposes a prohibited raw or administrative tool',
    /\b(?:raw[_ -]?database|sql|shell|source[_ -]?(?:editing|write)|file[_ -]?system|arbitrary[_ -]?http|activate[_ -]?release|purge|free[_ -]?form[_ -]?write)\w*tool\b/gi,
  );

  const toolNames = extractDeclaredToolNames(repoPath, source);
  for (const toolName of toolNames) {
    if (allowedErpTools.has(toolName)) continue;
    addViolation(
      violations,
      repoPath,
      source,
      Math.max(0, source.indexOf(toolName)),
      'AUTH005_AGENT_TOOL',
      `model-facing catalog exposes non-protocol tool ${toolName}`,
    );
  }

  if (isOperationsAgentProfile(repoPath, source)) {
    const uniqueNames = new Set(toolNames);
    const missing = [...allowedErpTools].filter(
      (name) => !uniqueNames.has(name),
    );
    const extras = [...uniqueNames].filter(
      (name) => !allowedErpTools.has(name),
    );
    if (missing.length > 0 || extras.length > 0) {
      addViolation(
        violations,
        repoPath,
        source,
        0,
        'AUTH005_AGENT_TOOL',
        `OperationsAgentToolProfile must contain exactly the five protocol tools; missing=[${missing.join(',')}], extras=[${extras.join(',')}]`,
      );
    }
  }
}

function extractDeclaredToolNames(repoPath: string, source: string): string[] {
  if (extname(repoPath) === '.json') {
    try {
      return extractJsonToolNames(JSON.parse(source) as unknown);
    } catch {
      return [];
    }
  }

  const names = new Set<string>();
  for (const match of source.matchAll(
    /\b(?:tools?|toolNames?)\s*[:=]\s*\[([^\]]*)\]/gis,
  )) {
    for (const quoted of (match[1] ?? '').matchAll(/['"]([^'"]+)['"]/g)) {
      if (quoted[1]) names.add(quoted[1]);
    }
  }
  for (const match of source.matchAll(
    /\b(?:name|tool|toolName|id)\s*:\s*['"]([a-z][a-z0-9_-]+)['"]/gi,
  )) {
    if (match[1]) names.add(match[1]);
  }
  for (const match of source.matchAll(/^\s*-\s*([a-z][a-z0-9_-]+)\s*$/gim)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names];
}

function extractJsonToolNames(value: unknown): string[] {
  const names = new Set<string>();

  function visit(candidate: unknown): void {
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (!isRecord(candidate)) return;

    const directName = ['name', 'tool', 'toolName', 'id']
      .map((key) => candidate[key])
      .find((nested): nested is string => typeof nested === 'string');
    if (directName) names.add(directName);

    for (const [key, nested] of Object.entries(candidate)) {
      if (/^(?:tools?|toolNames?)$/i.test(key)) {
        collectToolCollection(nested, names);
      } else {
        visit(nested);
      }
    }
  }

  visit(value);
  return [...names];
}

function collectToolCollection(value: unknown, names: Set<string>): void {
  if (typeof value === 'string') {
    names.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectToolCollection(item, names);
    return;
  }
  if (!isRecord(value)) return;

  const explicitName = ['name', 'tool', 'toolName', 'id']
    .map((key) => value[key])
    .find((candidate): candidate is string => typeof candidate === 'string');
  if (explicitName) {
    names.add(explicitName);
    return;
  }
  for (const key of Object.keys(value)) names.add(key);
}

function collectAuthorityDeclarations(
  repoPath: string,
  source: string,
  declarations: AuthorityDeclaration[],
): void {
  const sourceFile = createSourceFile(
    repoPath,
    source,
    ScriptTarget.Latest,
    true,
  );

  function visit(node: Parameters<typeof forEachChild>[0]): void {
    if (
      (isClassDeclaration(node) ||
        isEnumDeclaration(node) ||
        isFunctionDeclaration(node) ||
        isInterfaceDeclaration(node) ||
        isModuleDeclaration(node) ||
        isTypeAliasDeclaration(node) ||
        isVariableDeclaration(node) ||
        isExportSpecifier(node)) &&
      node.name &&
      isIdentifier(node.name)
    ) {
      const declarationName = node.name;
      const rule = authorityRules.find(
        (candidate) => candidate.name === declarationName.text,
      );
      if (rule) {
        declarations.push({
          rule,
          file: repoPath,
          source,
          index: declarationName.getStart(sourceFile),
        });
      }
    }
    forEachChild(node, visit);
  }

  visit(sourceFile);
}

function validateAuthorityDeclarations(
  declarations: AuthorityDeclaration[],
  violations: BoundaryViolation[],
): void {
  for (const rule of authorityRules) {
    const matches = declarations.filter(
      (declaration) => declaration.rule.name === rule.name,
    );
    for (const declaration of matches) {
      if (
        !rule.allowedDirectories.some(
          (directory) =>
            declaration.file === directory ||
            declaration.file.startsWith(`${directory}/`),
        )
      ) {
        addViolation(
          violations,
          declaration.file,
          declaration.source,
          declaration.index,
          rule.ruleId,
          `${rule.name} is declared outside its sole authority package`,
        );
      }
    }
    if (matches.length > 1) {
      for (const declaration of matches.slice(1)) {
        addViolation(
          violations,
          declaration.file,
          declaration.source,
          declaration.index,
          rule.ruleId,
          `duplicate canonical authority declaration ${rule.name}`,
        );
      }
    }
  }
}

function isProtectedLayer(kind: PackageKind): boolean {
  return (
    kind === 'compiler' ||
    kind === 'contracts' ||
    kind === 'domain' ||
    kind === 'unclassified'
  );
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

function externalSpecifierAllowed(specifier: string): boolean {
  return allowedProtectedExternalImports.some((pattern) =>
    pattern.test(specifier),
  );
}

function isProductionPath(repoPath: string): boolean {
  return /^(?:apps|build|db|dist|packages)\//.test(repoPath);
}

function isModelFacingPath(repoPath: string): boolean {
  if (/(?:^|\/)dev-tooling(?:\/|$)/i.test(repoPath)) return false;
  return /(?:agent|model-facing|operations-agent-tool-profile|(?:^|[-_./])tools?(?:[-_./]|$)|catalog)/i.test(
    repoPath,
  );
}

function isOperationsAgentProfile(repoPath: string, source: string): boolean {
  return (
    /operations[-_.]?agent[-_.]?tool[-_.]?profile/i.test(repoPath) ||
    /\bOperationsAgentToolProfile\b/.test(source)
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
