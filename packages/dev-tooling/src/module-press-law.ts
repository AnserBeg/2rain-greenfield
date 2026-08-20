import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import ts from 'typescript';

export type ModulePressLawRuleId =
  | 'PRESS001_NO_MODULES'
  | 'PRESS002_MODULE_DESCRIPTOR'
  | 'PRESS003_DOMAIN_RUNTIME_IMPORT'
  | 'PRESS004_DOMAIN_SQL'
  | 'PRESS005_DOMAIN_GLUE'
  | 'PRESS006_MODULE_ID_IN_PRESS'
  | 'PRESS007_MODULE_GLUE_IN_PRESS'
  | 'PRESS008_COPIED_MODULE_GUARD'
  | 'PRESS009_NO_PRODUCTION_PRESS';

export interface ModulePressLawViolation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
  readonly moduleDirectory: string | null;
  readonly ruleId: ModulePressLawRuleId;
}

export interface ModulePressLawResult {
  readonly moduleDirectories: readonly string[];
  readonly modulesRead: number;
  readonly productionFilesRead: number;
  readonly scannedFiles: number;
  readonly violations: readonly ModulePressLawViolation[];
}

interface ModuleDescriptor {
  readonly directory: string;
  readonly glueNames: readonly string[];
  readonly localIds: readonly string[];
  readonly namespace: string;
  readonly symbolPrefix: string;
}

const scannedExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.sh',
  '.sql',
  '.ts',
  '.tsx',
]);
const staticStringSourceExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.ts',
  '.tsx',
]);

const ignoredDirectories = new Set([
  '.git',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'playwright-report',
  'release',
  'test-results',
]);

const domainRuntimeImport =
  /from\s+['"](?:pg|postgres|@north-star\/runtime|@north-star\/postgres-provider)/u;
const domainSql =
  /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+.+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|TRUNCATE)\b/iu;
const domainGlue =
  /(?:class|function)\s+\w*(?:Handler|Executor|Gateway|Repository|Service)\b|React|route\s*\(/u;
const copiedGuardProse =
  /generic production press has no .+ branch|production press sources are absent|contains module glue/u;
const glueRoles = [
  'Handler',
  'Executor',
  'Gateway',
  'Repository',
  'Service',
] as const;

export function checkModulePressLaw(
  rootDirectory: string,
): ModulePressLawResult {
  const root = resolve(rootDirectory);
  const violations: ModulePressLawViolation[] = [];
  const scanned = new Set<string>();
  const modules = discoverModules(root, violations, scanned);

  if (modules.length === 0) {
    add(
      violations,
      'packages/domain/src',
      1,
      'PRESS001_NO_MODULES',
      null,
      'no definition-backed product modules were discovered',
    );
  }

  for (const module of modules) {
    checkDomainSources(root, module, violations, scanned);
  }

  const productionFiles = productionPressFiles(root);
  if (productionFiles.length === 0) {
    add(
      violations,
      '.',
      1,
      'PRESS009_NO_PRODUCTION_PRESS',
      null,
      'no generic production press files were discovered',
    );
  }

  for (const file of productionFiles) {
    scanned.add(file);
    const source = readFileSync(file, 'utf8');
    const repoPath = normalizePath(relative(root, file));
    const constructedStrings = staticallyConstructedStrings(source, repoPath);
    for (const module of modules) {
      const identityMatch =
        moduleIdentityMatch(source, module) ??
        constructedModuleIdentityMatch(constructedStrings, module);
      if (identityMatch) {
        add(
          violations,
          repoPath,
          lineNumber(source, identityMatch.index),
          'PRESS006_MODULE_ID_IN_PRESS',
          module.directory,
          `generic press references ${module.directory} identity ${identityMatch.value}`,
        );
      }

      const glueMatch = moduleGlueMatch(source, repoPath, module);
      if (glueMatch) {
        add(
          violations,
          repoPath,
          lineNumber(source, glueMatch.index),
          'PRESS007_MODULE_GLUE_IN_PRESS',
          module.directory,
          `generic press contains ${module.directory}-specific ${glueMatch.value}`,
        );
      }
    }
  }

  for (const file of testSourceFiles(root)) {
    scanned.add(file);
    const source = readFileSync(file, 'utf8');
    const match = copiedModuleGuardMatch(source, modules);
    if (!match) continue;
    add(
      violations,
      normalizePath(relative(root, file)),
      lineNumber(source, match.index),
      'PRESS008_COPIED_MODULE_GUARD',
      null,
      'module press law is reimplemented outside the consolidated guard',
    );
  }

  return Object.freeze({
    moduleDirectories: Object.freeze(
      modules.map((module) => module.directory).toSorted(),
    ),
    modulesRead: modules.length,
    productionFilesRead: productionFiles.length,
    scannedFiles: scanned.size,
    violations: Object.freeze(
      violations.toSorted((left, right) =>
        `${left.file}:${String(left.line).padStart(8, '0')}:${left.ruleId}:${left.moduleDirectory ?? ''}`.localeCompare(
          `${right.file}:${String(right.line).padStart(8, '0')}:${right.ruleId}:${right.moduleDirectory ?? ''}`,
        ),
      ),
    ),
  });
}

export function formatModulePressLaw(result: ModulePressLawResult): string {
  if (result.violations.length === 0) {
    return `module-press-law: PASS (${String(result.modulesRead)} modules, ${String(result.scannedFiles)} files)`;
  }
  return [
    `module-press-law: ${String(result.violations.length)} observed violation(s) across ${String(result.modulesRead)} modules and ${String(result.scannedFiles)} files`,
    ...result.violations.map(
      (violation) =>
        `${violation.file}:${String(violation.line)} [${violation.ruleId}] ${violation.message}`,
    ),
  ].join('\n');
}

function discoverModules(
  root: string,
  violations: ModulePressLawViolation[],
  scanned: Set<string>,
): ModuleDescriptor[] {
  const domainRoot = join(root, 'packages/domain/src');
  if (!existsSync(domainRoot)) return [];

  const modules: ModuleDescriptor[] = [];
  for (const entry of readdirSync(domainRoot, { withFileTypes: true }).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    const definition = join(domainRoot, entry.name, 'definition.ts');
    if (!existsSync(definition)) continue;
    scanned.add(definition);
    const source = readFileSync(definition, 'utf8');
    const namespaceMatch =
      /export const ([A-Z][A-Z0-9_]*)_NAMESPACE\s*=\s*['"]([^'"]+)['"]/u.exec(
        source,
      );
    if (!namespaceMatch?.[1] || !namespaceMatch[2]) {
      add(
        violations,
        normalizePath(relative(root, definition)),
        1,
        'PRESS002_MODULE_DESCRIPTOR',
        entry.name,
        'definition-backed module does not declare an exported namespace',
      );
      continue;
    }

    const canonicalNames = [
      ...source.matchAll(/:(?:entity|module)\.([a-z][a-z0-9_]*)/gu),
    ]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    const localIds = [
      ...source.matchAll(/:(?:operation|query)\.([a-z][a-z0-9_]+)/gu),
    ]
      .map((match) => match[1])
      .filter((value): value is string => value !== undefined);
    for (const canonicalName of canonicalNames) {
      for (const suffix of [
        'get',
        'list',
        'search',
        'resolve',
        'create',
        'update',
        'archive',
        'restore',
      ]) {
        localIds.push(`${canonicalName}_${suffix}`);
      }
    }
    modules.push({
      directory: entry.name,
      glueNames: unique([
        pascalCase(entry.name),
        ...canonicalNames.map(pascalCase),
      ]),
      localIds: unique(localIds),
      namespace: namespaceMatch[2],
      symbolPrefix: namespaceMatch[1],
    });
  }
  return modules;
}

function checkDomainSources(
  root: string,
  module: ModuleDescriptor,
  violations: ModulePressLawViolation[],
  scanned: Set<string>,
): void {
  const directory = join(root, 'packages/domain/src', module.directory);
  for (const file of filesBelow(directory)) {
    scanned.add(file);
    const source = readFileSync(file, 'utf8');
    const repoPath = normalizePath(relative(root, file));
    for (const [ruleId, pattern, message] of [
      [
        'PRESS003_DOMAIN_RUNTIME_IMPORT',
        domainRuntimeImport,
        'definition source imports a runtime or provider',
      ],
      ['PRESS004_DOMAIN_SQL', domainSql, 'definition source contains SQL'],
      [
        'PRESS005_DOMAIN_GLUE',
        domainGlue,
        'definition source contains runtime glue',
      ],
    ] as const) {
      const match = pattern.exec(source);
      if (!match) continue;
      add(
        violations,
        repoPath,
        lineNumber(source, match.index),
        ruleId,
        module.directory,
        message,
      );
    }
  }
}

function productionPressFiles(root: string): string[] {
  return ['apps', 'db', 'packages', 'scripts']
    .flatMap((directory) => {
      const path = join(root, directory);
      return existsSync(path) ? filesBelow(path) : [];
    })
    .filter((file) => {
      const repoPath = normalizePath(relative(root, file));
      if (repoPath.startsWith('packages/domain/')) return false;
      return !repoPath.split('/').some((segment) => segment === 'test');
    })
    .sort();
}

function testSourceFiles(root: string): string[] {
  const roots = [join(root, 'test')];
  const apps = join(root, 'apps');
  if (existsSync(apps)) {
    for (const entry of readdirSync(apps, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      roots.push(join(apps, entry.name, 'test'));
    }
  }
  return roots.filter(existsSync).flatMap(filesBelow).sort();
}

function filesBelow(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) files.push(...filesBelow(path));
    } else if (scannedExtensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files.sort();
}

function moduleIdentityMatch(
  source: string,
  module: ModuleDescriptor,
): { index: number; value: string } | undefined {
  const patterns = [
    `${escapeRegExp(module.namespace)}(?![A-Za-z0-9_./-])`,
    `\\b${escapeRegExp(module.symbolPrefix)}_(?:IDS|NAMESPACE)\\b`,
    ...module.localIds.map((localId) => `\\b${escapeRegExp(localId)}\\b`),
  ];
  const match = new RegExp(patterns.join('|'), 'u').exec(source);
  return match ? { index: match.index, value: match[0] } : undefined;
}

interface StaticStringConstruction {
  readonly index: number;
  readonly value: string;
}

function staticallyConstructedStrings(
  source: string,
  repoPath: string,
): readonly StaticStringConstruction[] {
  if (!staticStringSourceExtensions.has(extname(repoPath))) return [];
  if (!source.includes('${') && !source.includes('+')) return [];

  const sourceFile = ts.createSourceFile(
    repoPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(repoPath),
  );
  const constructions: StaticStringConstruction[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTaggedTemplateExpression(node)) {
      // A tag, rather than the template syntax, determines the runtime value.
      // Its tag expression can still contain an ordinary construction, but the
      // template body is not an independently completed string.
      visit(node.tag);
      return;
    }
    if (ts.isTemplateExpression(node) || isStringConcatenation(node)) {
      const value = evaluateStaticString(node);
      if (value !== undefined) {
        constructions.push({ index: node.getStart(sourceFile), value });
      }
      // Observe the maximal ordinary construction once. Descending would turn
      // an internal prefix into a standalone value, including beneath a
      // dynamic outer expression that cannot itself be evaluated.
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return constructions;
}

function constructedModuleIdentityMatch(
  constructions: readonly StaticStringConstruction[],
  module: ModuleDescriptor,
): { index: number; value: string } | undefined {
  for (const construction of constructions) {
    const match = moduleIdentityMatch(construction.value, module);
    if (match) {
      return {
        index: construction.index,
        value: match.value,
      };
    }
  }
  return undefined;
}

function evaluateStaticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) {
    return evaluateStaticString(node.expression);
  }
  if (
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    return evaluateStaticString(node.expression);
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = evaluateStaticString(span.expression);
      if (expression === undefined) return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (isStringConcatenation(node)) {
    const left = evaluateStaticString(node.left);
    const right = evaluateStaticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function isStringConcatenation(node: ts.Node): node is ts.BinaryExpression {
  return (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  );
}

function scriptKind(repoPath: string): ts.ScriptKind {
  switch (extname(repoPath)) {
    case '.js':
    case '.cjs':
    case '.mjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function moduleGlueMatch(
  source: string,
  repoPath: string,
  module: ModuleDescriptor,
): { index: number; value: string } | undefined {
  const names = module.glueNames.filter(Boolean).map(escapeRegExp);
  if (names.length === 0) return undefined;
  const role = `(?:${glueRoles.join('|')})`;
  const pattern = new RegExp(
    `\\b(?:\\w*(?:${names.join('|')})[-_]?${role}|\\w*${role}[-_]?(?:${names.join('|')}))\\b`,
    'iu',
  );
  const sourceMatch = pattern.exec(source);
  if (sourceMatch) return { index: sourceMatch.index, value: sourceMatch[0] };

  const normalizedPath = repoPath.replaceAll('-', '').replaceAll('_', '');
  for (const name of module.glueNames) {
    for (const glueRole of glueRoles) {
      if (
        normalizedPath
          .toLocaleLowerCase('en-US')
          .includes(
            `${name.toLocaleLowerCase('en-US')}${glueRole.toLocaleLowerCase('en-US')}`,
          ) ||
        normalizedPath
          .toLocaleLowerCase('en-US')
          .includes(
            `${glueRole.toLocaleLowerCase('en-US')}${name.toLocaleLowerCase('en-US')}`,
          )
      ) {
        return { index: 0, value: repoPath };
      }
    }
  }
  return undefined;
}

function copiedModuleGuardMatch(
  source: string,
  modules: readonly ModuleDescriptor[],
): { index: number } | undefined {
  const proseMatch = copiedGuardProse.exec(source);
  if (proseMatch) return { index: proseMatch.index };

  for (const assertion of source.matchAll(
    /\b(?:assert\.)?doesNotMatch\s*\(/gu,
  )) {
    const index = assertion.index;
    const callEnd = source.indexOf(');', index);
    const call = source
      .slice(index, callEnd === -1 ? index + 2_000 : callEnd + 2)
      .replaceAll('\\', '');
    if (!/doesNotMatch\s*\(\s*(?:source|genericPress)\s*,/u.test(call)) {
      continue;
    }
    for (const module of modules) {
      if (moduleIdentityMatch(call, module)) return { index };
      if (
        module.glueNames.some((name) =>
          new RegExp(`\\b${escapeRegExp(name)}_`, 'iu').test(call),
        )
      ) {
        return { index };
      }
    }
  }
  return undefined;
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
    .join('');
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].toSorted();
}

function add(
  violations: ModulePressLawViolation[],
  file: string,
  line: number,
  ruleId: ModulePressLawRuleId,
  moduleDirectory: string | null,
  message: string,
): void {
  violations.push({ file, line, message, moduleDirectory, ruleId });
}

function lineNumber(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}
