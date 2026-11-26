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
  | 'PRESS009_NO_PRODUCTION_PRESS'
  | 'PRESS010_NAME_LAW_INPUT'
  | 'PRESS011_FIRST_PARTY_NAME'
  | 'PRESS012_FIRST_PARTY_FIELD'
  | 'PRESS013_DOMAIN_IMPORT'
  | 'PRESS014_ENGINE_NAME'
  | 'PRESS015_BASELINE_RISE';

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
  readonly nameLaw: NameLawResult;
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
      // Literal tokens owned by a static string construction are source syntax,
      // not value adjacency. Route runtime constructions and literal-only
      // template types through the construction observer; the raw observer owns
      // only matches outside those ranges.
      const directMatches = moduleIdentityMatches(source, module).filter(
        (directMatch) =>
          !constructedStrings.some((construction) =>
            matchFallsWithinRanges(directMatch, construction.literalRanges),
          ),
      );
      const constructedMatches = constructedModuleIdentityMatches(
        constructedStrings,
        module,
      );
      for (const identityMatch of [...directMatches, ...constructedMatches]) {
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

  const nameLaw = checkNameLaw(root, violations, scanned);

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
    nameLaw,
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
  const nameLaw = formatNameLaw(result.nameLaw);
  if (result.violations.length === 0) {
    return [
      `module-press-law: PASS (${String(result.modulesRead)} modules, ${String(result.scannedFiles)} files)`,
      ...nameLaw,
    ].join('\n');
  }
  return [
    `module-press-law: ${String(result.violations.length)} observed violation(s) across ${String(result.modulesRead)} modules and ${String(result.scannedFiles)} files`,
    ...result.violations.map(
      (violation) =>
        `${violation.file}:${String(violation.line)} [${violation.ruleId}] ${violation.message}`,
    ),
    ...nameLaw,
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

interface ModuleIdentityMatch {
  readonly index: number;
  readonly value: string;
}

function moduleIdentityMatches(
  source: string,
  module: ModuleDescriptor,
): readonly ModuleIdentityMatch[] {
  const patterns = [
    `${escapeRegExp(module.namespace)}(?![A-Za-z0-9_./-])`,
    `\\b${escapeRegExp(module.symbolPrefix)}_(?:IDS|NAMESPACE)\\b`,
    ...module.localIds.map((localId) => `\\b${escapeRegExp(localId)}\\b`),
  ];
  return [...source.matchAll(new RegExp(patterns.join('|'), 'gu'))].map(
    (match) => ({ index: match.index, value: match[0] }),
  );
}

interface SourceRange {
  readonly end: number;
  readonly start: number;
}

function matchFallsWithinRanges(
  match: ModuleIdentityMatch,
  ranges: readonly SourceRange[],
): boolean {
  return ranges.some(
    (range) =>
      match.index >= range.start &&
      match.index + match.value.length <= range.end,
  );
}

interface StaticStringConstruction {
  readonly index: number;
  readonly leftBoundaryKnown: boolean;
  readonly literalRanges: readonly SourceRange[];
  readonly rightBoundaryKnown: boolean;
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
    if (ts.isTemplateLiteralTypeNode(node)) {
      // Type constructions have an independent population pass below. Runtime
      // completion must not decide whether a type child is reachable.
      return;
    }
    if (ts.isTaggedTemplateExpression(node)) {
      // The tag controls the aggregate result, so do not infer a value for the
      // tagged template. Substitution expressions are completed before the tag
      // receives them and remain independently observable.
      visit(node.tag);
      if (ts.isTemplateExpression(node.template)) {
        for (const span of node.template.templateSpans) {
          visit(span.expression);
        }
      }
      return;
    }
    if (ts.isTemplateExpression(node) || isStringConcatenation(node)) {
      const value = evaluateStaticString(node);
      if (value !== undefined) {
        constructions.push({
          index: node.getStart(sourceFile),
          leftBoundaryKnown: true,
          literalRanges: runtimeStringLiteralRanges(node, sourceFile),
          rightBoundaryKnown: true,
          value,
        });
        // A complete construction is one value. Its direct construction
        // fragments are not independently completed values.
        return;
      }

      constructions.push(...staticallyKnownStringRuns(node, sourceFile));

      // The direct operands of an incomplete construction are not completed
      // values. Statically known runs above are observable only where the
      // shared matcher can establish the relevant boundaries from static text
      // or the construction edges. Continue through semantic boundaries within
      // the operands, where an independently completed construction can exist.
      if (ts.isTemplateExpression(node)) {
        for (const span of node.templateSpans) {
          visitIncompleteConstructionOperand(span.expression);
        }
      } else {
        visitIncompleteConstructionOperand(node.left);
        visitIncompleteConstructionOperand(node.right);
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  const visitIncompleteConstructionOperand = (node: ts.Expression): void => {
    const expression = unwrapStaticStringExpression(node);
    if (isStringConcatenation(expression)) {
      visitIncompleteConstructionOperand(expression.left);
      visitIncompleteConstructionOperand(expression.right);
      return;
    }
    if (ts.isTemplateExpression(expression)) {
      for (const span of expression.templateSpans) {
        visitIncompleteConstructionOperand(span.expression);
      }
      return;
    }
    visit(expression);
  };
  visit(sourceFile);
  constructions.push(...staticallyConstructedTemplateTypes(sourceFile));
  return constructions;
}

interface ExactStaticTypeString {
  readonly literalRanges: readonly SourceRange[];
  readonly value: string;
}

function staticallyConstructedTemplateTypes(
  sourceFile: ts.SourceFile,
): readonly StaticStringConstruction[] {
  const constructions: StaticStringConstruction[] = [];
  const visit = (node: ts.Node): void => {
    if (!ts.isTemplateLiteralTypeNode(node)) {
      ts.forEachChild(node, visit);
      return;
    }

    const construction = exactTemplateTypeConstruction(node, sourceFile);
    if (construction) {
      constructions.push(construction);
      // The complete template type is one exact static value. Its nested
      // fragments are not independent observations of that same value.
      return;
    }

    constructions.push(...staticallyKnownTemplateTypeRuns(node, sourceFile));
    // An unresolved span remains outside this bounded evaluator, but may
    // contain an independently complete nested template type.
    for (const span of node.templateSpans) {
      if (exactStaticTypeString(span.type, sourceFile) === undefined) {
        visit(span.type);
      }
    }
  };
  visit(sourceFile);
  return constructions;
}

function exactTemplateTypeConstruction(
  node: ts.TemplateLiteralTypeNode,
  sourceFile: ts.SourceFile,
): StaticStringConstruction | undefined {
  let value = node.head.text;
  const literalRanges: SourceRange[] = [sourceRange(node.head, sourceFile)];

  for (const span of node.templateSpans) {
    const exact = exactStaticTypeString(span.type, sourceFile);
    if (!exact) return undefined;
    value += exact.value + span.literal.text;
    literalRanges.push(
      ...exact.literalRanges,
      sourceRange(span.literal, sourceFile),
    );
  }

  return {
    index: node.getStart(sourceFile),
    leftBoundaryKnown: true,
    literalRanges,
    rightBoundaryKnown: true,
    value,
  };
}

function exactStaticTypeString(
  node: ts.TypeNode,
  sourceFile: ts.SourceFile,
): ExactStaticTypeString | undefined {
  if (ts.isParenthesizedTypeNode(node)) {
    return exactStaticTypeString(node.type, sourceFile);
  }
  if (ts.isTemplateLiteralTypeNode(node)) {
    const construction = exactTemplateTypeConstruction(node, sourceFile);
    return construction
      ? {
          literalRanges: construction.literalRanges,
          value: construction.value,
        }
      : undefined;
  }
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) {
    return {
      literalRanges: [sourceRange(node, sourceFile)],
      value: 'undefined',
    };
  }
  if (!ts.isLiteralTypeNode(node)) return undefined;

  const literal = node.literal;
  let value: string | undefined;
  if (ts.isStringLiteralLike(literal)) {
    value = literal.text;
  } else if (ts.isNumericLiteral(literal)) {
    value = String(Number(literal.text));
  } else if (ts.isBigIntLiteral(literal)) {
    value = BigInt(literal.text.replace(/n$/u, '')).toString();
  } else if (literal.kind === ts.SyntaxKind.TrueKeyword) {
    value = 'true';
  } else if (literal.kind === ts.SyntaxKind.FalseKeyword) {
    value = 'false';
  } else if (literal.kind === ts.SyntaxKind.NullKeyword) {
    value = 'null';
  } else if (
    ts.isPrefixUnaryExpression(literal) &&
    literal.operator === ts.SyntaxKind.MinusToken &&
    (ts.isNumericLiteral(literal.operand) ||
      ts.isBigIntLiteral(literal.operand))
  ) {
    value = ts.isBigIntLiteral(literal.operand)
      ? (-BigInt(literal.operand.text.replace(/n$/u, ''))).toString()
      : String(-Number(literal.operand.text));
  }

  return value === undefined
    ? undefined
    : {
        literalRanges: [sourceRange(literal, sourceFile)],
        value,
      };
}

function staticallyKnownTemplateTypeRuns(
  node: ts.TemplateLiteralTypeNode,
  sourceFile: ts.SourceFile,
): readonly StaticStringConstruction[] {
  const constructionIndex = node.getStart(sourceFile);
  return collectStaticStringRuns((appendStatic, appendDynamic) => {
    appendStatic(
      node.head.text,
      [sourceRange(node.head, sourceFile)],
      constructionIndex,
    );
    for (const span of node.templateSpans) {
      const exact = exactStaticTypeString(span.type, sourceFile);
      if (exact) {
        appendStatic(exact.value, exact.literalRanges, constructionIndex);
      } else {
        appendDynamic();
      }
      appendStatic(
        span.literal.text,
        [sourceRange(span.literal, sourceFile)],
        constructionIndex,
      );
    }
  });
}

type AppendStaticStringRun = (
  value: string,
  literalRanges: readonly SourceRange[],
  index: number,
) => void;

function collectStaticStringRuns(
  populate: (
    appendStatic: AppendStaticStringRun,
    appendDynamic: () => void,
  ) => void,
): readonly StaticStringConstruction[] {
  const runs: StaticStringConstruction[] = [];
  let current:
    | {
        index: number;
        leftBoundaryKnown: boolean;
        literalRanges: SourceRange[];
        value: string;
      }
    | undefined;
  let nextLeftBoundaryKnown = true;

  const appendStatic = (
    value: string,
    literalRanges: readonly SourceRange[],
    index: number,
  ): void => {
    current ??= {
      index,
      leftBoundaryKnown: nextLeftBoundaryKnown,
      literalRanges: [],
      value: '',
    };
    current.value += value;
    current.literalRanges.push(...literalRanges);
  };
  const finish = (rightBoundaryKnown: boolean): void => {
    if (current && current.value.length > 0) {
      runs.push({ ...current, rightBoundaryKnown });
    }
    current = undefined;
  };
  const appendDynamic = (): void => {
    finish(false);
    nextLeftBoundaryKnown = false;
  };
  populate(appendStatic, appendDynamic);
  finish(true);
  return runs;
}

function staticallyKnownStringRuns(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): readonly StaticStringConstruction[] {
  return collectStaticStringRuns((appendStatic, appendDynamic) => {
    const flatten = (expression: ts.Expression): void => {
      const unwrapped = unwrapStaticStringExpression(expression);
      if (ts.isStringLiteralLike(unwrapped)) {
        appendStatic(
          unwrapped.text,
          runtimeStringLiteralRanges(unwrapped, sourceFile),
          unwrapped.getStart(sourceFile),
        );
        return;
      }
      if (ts.isTemplateExpression(unwrapped)) {
        appendStatic(
          unwrapped.head.text,
          [sourceRange(unwrapped.head, sourceFile)],
          unwrapped.getStart(sourceFile),
        );
        for (const span of unwrapped.templateSpans) {
          flatten(span.expression);
          appendStatic(
            span.literal.text,
            [sourceRange(span.literal, sourceFile)],
            span.literal.getStart(sourceFile),
          );
        }
        return;
      }
      if (isStringConcatenation(unwrapped)) {
        flatten(unwrapped.left);
        flatten(unwrapped.right);
        return;
      }
      appendDynamic();
    };

    flatten(node);
  });
}

// A word character is also a namespace-continuation character. Padding an
// unknown adjacent runtime value with one lets the shared identity matcher
// make the conservative boundary decision without duplicating its patterns.
const unknownIdentityNeighbor = '_';

function constructedModuleIdentityMatches(
  constructions: readonly StaticStringConstruction[],
  module: ModuleDescriptor,
): readonly ModuleIdentityMatch[] {
  const matches: ModuleIdentityMatch[] = [];
  for (const construction of constructions) {
    const leftPadding = construction.leftBoundaryKnown
      ? ''
      : unknownIdentityNeighbor;
    const rightPadding = construction.rightBoundaryKnown
      ? ''
      : unknownIdentityNeighbor;
    const observedValue = `${leftPadding}${construction.value}${rightPadding}`;
    const constructionStart = leftPadding.length;
    const constructionEnd = constructionStart + construction.value.length;
    const constructionMatches = moduleIdentityMatches(
      observedValue,
      module,
    ).filter(
      (identityMatch) =>
        identityMatch.index >= constructionStart &&
        identityMatch.index + identityMatch.value.length <= constructionEnd,
    );
    for (const match of constructionMatches) {
      matches.push({
        index: construction.index,
        value: match.value,
      });
    }
  }
  return matches;
}

function evaluateStaticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  const expression = unwrapStaticStringExpression(node);
  if (expression !== node) return evaluateStaticString(expression);
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

function unwrapStaticStringExpression(node: ts.Expression): ts.Expression {
  let expression = node;
  while (
    ts.isParenthesizedExpression(expression) ||
    ts.isAsExpression(expression) ||
    ts.isTypeAssertionExpression(expression) ||
    ts.isSatisfiesExpression(expression) ||
    ts.isNonNullExpression(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

function runtimeStringLiteralRanges(
  node: ts.Expression,
  sourceFile: ts.SourceFile,
): readonly SourceRange[] {
  const ranges: SourceRange[] = [];
  // Mirror evaluateStaticString's runtime-expression grammar. Type children of
  // wrappers are source occurrences, not tokens owned by the runtime value.
  const append = (current: ts.Node): void => {
    ranges.push(sourceRange(current, sourceFile));
  };
  const visit = (current: ts.Expression): void => {
    if (ts.isStringLiteralLike(current)) {
      append(current);
      return;
    }

    const expression = unwrapStaticStringExpression(current);
    if (expression !== current) {
      visit(expression);
      return;
    }
    if (ts.isTemplateExpression(expression)) {
      append(expression.head);
      for (const span of expression.templateSpans) {
        visit(span.expression);
        append(span.literal);
      }
      return;
    }
    if (isStringConcatenation(expression)) {
      visit(expression.left);
      visit(expression.right);
    }
  };
  visit(node);
  return ranges;
}

function sourceRange(node: ts.Node, sourceFile: ts.SourceFile): SourceRange {
  return {
    end: node.getEnd(),
    start: node.getStart(sourceFile),
  };
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
      if (moduleIdentityMatches(call, module).length > 0) return { index };
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

// ---------------------------------------------------------------------------
// First-party name law (GUARD-WIDEN). Generic code never names a declared
// application's vocabulary.
//
// PRESS006 learns a module's names by pattern from its definition.ts, so it
// misses every template-built ID (purchase_order, shipment, vendor_bill...).
// This layer reads the vocabulary from the compiled first-party release
// instead, and also observes field names, file names, imports from
// packages/domain, and one engine naming another. Today's occurrences are
// frozen per file and per name in a baseline that may only shrink.
// ---------------------------------------------------------------------------

export const NAME_LAW_POLICY_PATH =
  'test/architecture/first-party-names.policy.json';
export const NAME_LAW_BASELINE_PATH =
  'test/architecture/first-party-names.baseline.json';
export const ENGINES_MANIFEST_PATH = 'test/architecture/engines.manifest.json';

export type NameLawLayer = 'engine' | 'field' | 'import' | 'name';

type VocabularyKind =
  | 'capability'
  | 'engine'
  | 'entity'
  | 'field'
  | 'module'
  | 'module-word'
  | 'operation'
  | 'query';

export interface NameLawSlack {
  readonly baseline: number;
  readonly file: string;
  readonly key: string;
  readonly observed: number;
}

export interface NameLawExpiry {
  readonly expires: string;
  readonly file: string;
  readonly owner: string;
}

export interface NameLawResult {
  /** False only when the tree carries no name-law policy at all. */
  readonly active: boolean;
  readonly expired: readonly NameLawExpiry[];
  readonly filesRead: number;
  /** Observed counts: file, then `layer:name`, then count. */
  readonly observations: Readonly<
    Record<string, Readonly<Record<string, number>>>
  >;
  readonly slack: readonly NameLawSlack[];
  readonly vocabulary: readonly string[];
}

export interface NameLawBaselineFile {
  readonly cluster: string;
  readonly expires: string | null;
  readonly names: Readonly<Record<string, number>>;
  readonly owner: string;
}

export interface NameLawBaseline {
  readonly files: Readonly<Record<string, NameLawBaselineFile>>;
  readonly measuredOn: string;
  readonly version: 1;
}

interface NameLawPolicy {
  readonly externalNames: readonly {
    readonly file: string;
    readonly name: string;
  }[];
  readonly moduleWords: readonly string[];
  readonly ordinaryWords: readonly string[];
  readonly platformOwned: readonly { readonly name: string }[];
  readonly requiredNames: readonly string[];
  readonly scope: readonly string[];
  readonly vocabularySources: readonly string[];
}

interface EngineRow {
  readonly files: readonly string[];
  readonly id: string;
  readonly names: readonly string[];
  readonly nameScope: 'engines-only' | 'exclusive';
}

interface VocabularyEntry {
  readonly engine: string | undefined;
  readonly kind: VocabularyKind;
  readonly name: string;
  readonly words: readonly string[];
}

interface Vocabulary {
  readonly byWords: ReadonlyMap<string, VocabularyEntry>;
  readonly idPrefixes: readonly string[];
  readonly maxWords: number;
  readonly ordinary: ReadonlySet<string>;
}

interface NameHit {
  readonly entry: VocabularyEntry;
  readonly index: number;
}

interface ObservedKey {
  count: number;
  readonly line: number;
  readonly message: string;
  readonly ruleId: ModulePressLawRuleId;
}

const inactiveNameLaw: NameLawResult = Object.freeze({
  active: false,
  expired: Object.freeze([]),
  filesRead: 0,
  observations: Object.freeze({}),
  slack: Object.freeze([]),
  vocabulary: Object.freeze([]),
});

const nameLawExtensions = new Set([
  '.cjs',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.mts',
  '.sql',
  '.ts',
  '.tsx',
]);

export function isNameLawRule(ruleId: ModulePressLawRuleId): boolean {
  return ruleId >= 'PRESS010';
}

function checkNameLaw(
  root: string,
  violations: ModulePressLawViolation[],
  scanned: Set<string>,
): NameLawResult {
  const inputs = [
    NAME_LAW_POLICY_PATH,
    NAME_LAW_BASELINE_PATH,
    ENGINES_MANIFEST_PATH,
  ];
  const present = inputs.filter((path) => existsSync(join(root, path)));
  if (present.length === 0) return inactiveNameLaw;
  const refuse = (file: string, message: string): NameLawResult => {
    add(violations, file, 1, 'PRESS010_NAME_LAW_INPUT', null, message);
    return { ...inactiveNameLaw, active: true };
  };
  for (const path of inputs) {
    if (!present.includes(path)) {
      return refuse(path, `name law input ${path} is missing`);
    }
  }

  let policy: NameLawPolicy;
  let engines: readonly EngineRow[];
  let baseline: NameLawBaseline;
  try {
    policy = parsePolicy(readJson(root, NAME_LAW_POLICY_PATH));
    engines = parseEngines(readJson(root, ENGINES_MANIFEST_PATH));
    baseline = parseNameLawBaseline(readJson(root, NAME_LAW_BASELINE_PATH));
  } catch (error) {
    return refuse(
      NAME_LAW_POLICY_PATH,
      `name law input is malformed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const owners = new Map<string, string>();
  for (const engine of engines) {
    for (const file of engine.files) {
      if (!existsSync(join(root, file))) {
        return refuse(
          ENGINES_MANIFEST_PATH,
          `engine ${engine.id} owns ${file}, which does not exist`,
        );
      }
      const prior = owners.get(file);
      if (prior !== undefined) {
        return refuse(
          ENGINES_MANIFEST_PATH,
          `${file} is owned by both engine ${prior} and engine ${engine.id}`,
        );
      }
      owners.set(file, engine.id);
    }
  }

  const sources: unknown[] = [];
  for (const source of policy.vocabularySources) {
    if (!existsSync(join(root, source))) {
      return refuse(source, `vocabulary source ${source} is missing`);
    }
    scanned.add(join(root, source));
    sources.push(readJson(root, source));
  }
  const vocabulary = buildVocabulary(sources, policy, engines);
  const names = new Set(
    [...vocabulary.byWords.values()].map((entry) => entry.name),
  );
  const missing = policy.requiredNames.filter((name) => !names.has(name));
  if (missing.length > 0) {
    return refuse(
      policy.vocabularySources[0] ?? NAME_LAW_POLICY_PATH,
      `vocabulary does not declare required first-party name(s) ${missing.join(', ')}`,
    );
  }

  const external = new Set(
    policy.externalNames.map((entry) => `${entry.file}\u0000${entry.name}`),
  );
  const observed = new Map<string, Map<string, ObservedKey>>();
  const files = policy.scope
    .flatMap((directory) => {
      const path = join(root, directory);
      return existsSync(path) ? nameLawFilesBelow(path) : [];
    })
    .sort();
  for (const file of files) {
    scanned.add(file);
    const repoPath = normalizePath(relative(root, file));
    const source = readFileSync(file, 'utf8');
    const text = withoutComments(source, repoPath);
    const owner = owners.get(repoPath);
    const keys = new Map<string, ObservedKey>();
    const observe = (
      key: string,
      index: number,
      ruleId: ModulePressLawRuleId,
      message: string,
    ): void => {
      const prior = keys.get(key);
      if (prior) {
        prior.count += 1;
        return;
      }
      keys.set(key, {
        count: 1,
        line: index < 0 ? 1 : lineNumber(source, index),
        message,
        ruleId,
      });
    };
    const scopeRoot = policy.scope.find((directory) =>
      repoPath.startsWith(`${directory}/`),
    );
    const pathText = repoPath
      .slice(scopeRoot === undefined ? 0 : scopeRoot.length + 1)
      .replace(/\.[a-z]+$/u, '')
      .replaceAll(/[/.-]/gu, ' ');
    const hits = [
      ...nameHits(text, vocabulary, true),
      ...nameHits(pathText, vocabulary, false).map((hit) => ({
        ...hit,
        index: -1,
      })),
    ];
    for (const hit of hits) {
      if (external.has(`${repoPath}\u0000${hit.entry.name}`)) continue;
      const observation = observationFor(hit.entry, owner, engines);
      if (observation === undefined) continue;
      observe(
        `${observation.layer}:${hit.entry.engine ?? hit.entry.name}`,
        hit.index,
        observation.ruleId,
        observation.message,
      );
    }
    for (const imported of domainImports(text, repoPath)) {
      observe(
        `import:${imported.target}`,
        imported.index,
        'PRESS013_DOMAIN_IMPORT',
        `generic code imports ${imported.target} from packages/domain`,
      );
    }
    if (keys.size > 0) observed.set(repoPath, keys);
  }

  const slack: NameLawSlack[] = [];
  for (const [file, keys] of observed) {
    const allowed = baseline.files[file]?.names ?? {};
    for (const [key, observation] of keys) {
      const allowance = allowed[key];
      if (allowance === undefined) {
        add(
          violations,
          file,
          observation.line,
          observation.ruleId,
          null,
          `${observation.message} (${key} x${String(observation.count)}, not in the baseline)`,
        );
      } else if (observation.count > allowance) {
        add(
          violations,
          file,
          observation.line,
          'PRESS015_BASELINE_RISE',
          null,
          `${key} rose from ${String(allowance)} to ${String(observation.count)}; the baseline only shrinks`,
        );
      } else if (observation.count < allowance) {
        slack.push({
          baseline: allowance,
          file,
          key,
          observed: observation.count,
        });
      }
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const expired: NameLawExpiry[] = [];
  for (const [file, row] of Object.entries(baseline.files)) {
    if (row.expires !== null && row.expires < today) {
      expired.push({ expires: row.expires, file, owner: row.owner });
    }
    const keys = observed.get(file);
    for (const [key, allowance] of Object.entries(row.names)) {
      if (keys?.has(key) !== true) {
        slack.push({ baseline: allowance, file, key, observed: 0 });
      }
    }
  }

  return Object.freeze({
    active: true,
    expired: Object.freeze(expired),
    filesRead: files.length,
    observations: Object.freeze(
      Object.fromEntries(
        [...observed].map(([file, keys]) => [
          file,
          Object.freeze(
            Object.fromEntries(
              [...keys]
                .toSorted(([left], [right]) => left.localeCompare(right))
                .map(([key, observation]) => [key, observation.count]),
            ),
          ),
        ]),
      ),
    ),
    slack: Object.freeze(
      slack.toSorted((left, right) =>
        `${left.file}\u0000${left.key}`.localeCompare(
          `${right.file}\u0000${right.key}`,
        ),
      ),
    ),
    vocabulary: Object.freeze([...names].toSorted()),
  });
}

function observationFor(
  entry: VocabularyEntry,
  owner: string | undefined,
  engines: readonly EngineRow[],
):
  | {
      readonly layer: NameLawLayer;
      readonly message: string;
      readonly ruleId: ModulePressLawRuleId;
    }
  | undefined {
  if (entry.engine !== undefined) {
    if (engineNameAllowed(entry.engine, owner, engines)) return undefined;
    return {
      layer: 'engine',
      message:
        owner === undefined
          ? `generic code names engine ${entry.engine} outside its own files`
          : `engine ${owner} names engine ${entry.engine}`,
      ruleId: 'PRESS014_ENGINE_NAME',
    };
  }
  const layer = layerOfKind(entry.kind);
  if (layer === undefined) return undefined;
  return layer === 'field'
    ? {
        layer,
        message: `generic code names first-party field ${entry.name}`,
        ruleId: 'PRESS012_FIRST_PARTY_FIELD',
      }
    : {
        layer,
        message: `generic code names first-party ${entry.kind} ${entry.name}`,
        ruleId: 'PRESS011_FIRST_PARTY_NAME',
      };
}

function layerOfKind(kind: VocabularyKind): NameLawLayer | undefined {
  switch (kind) {
    case 'field':
      return 'field';
    case 'engine':
      return undefined;
    case 'capability':
    case 'entity':
    case 'module':
    case 'module-word':
    case 'operation':
    case 'query':
      return 'name';
  }
}

/**
 * An engine's name is always allowed in its own files. Inside another engine's
 * files it never is. In other generic code an `exclusive` engine (booking,
 * billing) may not be named; an `engines-only` engine's name is platform
 * vocabulary there and only the cross-engine rule applies to it.
 */
function engineNameAllowed(
  named: string,
  owner: string | undefined,
  engines: readonly EngineRow[],
): boolean {
  if (owner === named) return true;
  if (owner !== undefined) return false;
  return (
    engines.find((engine) => engine.id === named)?.nameScope === 'engines-only'
  );
}

function buildVocabulary(
  sources: readonly unknown[],
  policy: NameLawPolicy,
  engines: readonly EngineRow[],
): Vocabulary {
  const entries = new Map<string, VocabularyEntry>();
  const platformOwned = policy.platformOwned.map((entry) => entry.name);
  const idPrefixes = new Set<string>();
  const addName = (
    name: string,
    kind: VocabularyKind,
    engine?: string,
  ): void => {
    if (
      engine === undefined &&
      platformOwned.some(
        (owned) => name === owned || name.startsWith(`${owned}_`),
      )
    ) {
      return;
    }
    const words = name.split('_').filter(Boolean);
    const key = words.join(' ');
    if (words.length === 0 || entries.has(key)) return;
    entries.set(key, { engine, kind, name, words });
  };
  for (const engine of engines) {
    for (const name of engine.names) addName(name, 'engine', engine.id);
  }
  const collections: readonly (readonly [string, string, VocabularyKind])[] = [
    ['fields', 'fieldId', 'field'],
    ['operations', 'operationId', 'operation'],
    ['queries', 'queryId', 'query'],
    ['entities', 'entityId', 'entity'],
    ['capabilityRequirements', 'capabilityId', 'capability'],
    ['modules', 'moduleId', 'module'],
  ];
  for (const source of sources) {
    const release = asRecord(source, 'vocabulary source');
    const namespace = asRecord(release.package, 'vocabulary package').namespace;
    if (typeof namespace === 'string') {
      const rootSegment = namespace.split('.')[0];
      if (rootSegment) idPrefixes.add(rootSegment);
    }
    for (const [collection, idKey, kind] of collections) {
      const rows = release[collection];
      if (!Array.isArray(rows)) {
        throw new Error(`vocabulary source has no ${collection} array`);
      }
      for (const row of rows) {
        const id = asRecord(row, collection)[idKey];
        const local =
          typeof id === 'string'
            ? /^[^:]+:[a-z_]+\.([a-z][a-z0-9_]*)$/u.exec(id)?.[1]
            : undefined;
        if (local === undefined) {
          throw new Error(`${collection} row has no canonical ${idKey}`);
        }
        addName(local, kind);
      }
    }
  }
  for (const word of policy.moduleWords) addName(word, 'module-word');
  return {
    byWords: entries,
    idPrefixes: [...idPrefixes],
    maxWords: Math.max(
      1,
      ...[...entries.values()].map((entry) => entry.words.length),
    ),
    ordinary: new Set(policy.ordinaryWords),
  };
}

/**
 * Longest known name first, across snake, camel, Pascal and kebab spellings,
 * with a plural last word. A single word that is also ordinary English is a
 * name only in ID position: right after `<namespace root>.` or `:<kind>.`.
 */
function nameHits(
  text: string,
  vocabulary: Vocabulary,
  allowIdPosition: boolean,
): NameHit[] {
  const hits: NameHit[] = [];
  const idPosition = new RegExp(
    `(?::[a-z_]+\\.|\\b(?:${vocabulary.idPrefixes.map(escapeRegExp).join('|') || '(?!)'})\\.)$`,
    'u',
  );
  for (const token of text.matchAll(/[A-Za-z0-9_]+/gu)) {
    const words = identifierWords(token[0]);
    const tokenInIdPosition =
      allowIdPosition &&
      idPosition.test(text.slice(Math.max(0, token.index - 64), token.index));
    let position = 0;
    while (position < words.length) {
      let matched = 0;
      for (
        let length = Math.min(vocabulary.maxWords, words.length - position);
        length >= 1;
        length -= 1
      ) {
        const entry = lookupWords(
          vocabulary,
          words.slice(position, position + length),
        );
        if (entry === undefined) continue;
        if (
          entry.words.length === 1 &&
          vocabulary.ordinary.has(entry.name) &&
          !(tokenInIdPosition && position === 0)
        ) {
          continue;
        }
        hits.push({ entry, index: token.index });
        matched = length;
        break;
      }
      position += matched === 0 ? 1 : matched;
    }
  }
  return hits;
}

function lookupWords(
  vocabulary: Vocabulary,
  words: readonly string[],
): VocabularyEntry | undefined {
  const exact = vocabulary.byWords.get(words.join(' '));
  if (exact) return exact;
  const last = words.at(-1) ?? '';
  const stem = words.slice(0, -1);
  for (const singular of [
    last.endsWith('es') ? last.slice(0, -2) : undefined,
    last.endsWith('s') ? last.slice(0, -1) : undefined,
  ]) {
    if (singular === undefined || singular.length < 3) continue;
    const entry = vocabulary.byWords.get([...stem, singular].join(' '));
    if (entry) return entry;
  }
  return undefined;
}

function identifierWords(token: string): string[] {
  return token
    .replaceAll(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/gu, '$1 $2')
    .split(/[\s_]+/u)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function domainImports(
  text: string,
  repoPath: string,
): { readonly index: number; readonly target: string }[] {
  const imports: { index: number; target: string }[] = [];
  for (const match of text.matchAll(
    /\b(?:from|import|require)\s*\(?\s*(['"])([^'"\n]+)\1/gu,
  )) {
    const specifier = match[2] ?? '';
    let target: string | undefined;
    if (
      specifier === '@north-star/domain' ||
      specifier.startsWith('@north-star/domain/')
    ) {
      target = specifier;
    } else if (specifier.startsWith('.')) {
      const resolved = normalizePath(
        join(repoPath.split('/').slice(0, -1).join('/'), specifier),
      );
      if (resolved.startsWith('packages/domain/')) {
        target = resolved.replace(/\.[a-z]+$/u, '');
      }
    }
    if (target !== undefined) imports.push({ index: match.index, target });
  }
  return imports;
}

function withoutComments(source: string, repoPath: string): string {
  if (extname(repoPath) === '.sql') {
    return source
      .replaceAll(/\/\*[\s\S]*?\*\//gu, blank)
      .replaceAll(/--[^\n]*/gu, blank);
  }
  const sourceFile = ts.createSourceFile(
    repoPath,
    source,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(repoPath),
  );
  const ranges = new Map<number, number>();
  const collect = (position: number): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(source, position) ?? []),
      ...(ts.getTrailingCommentRanges(source, position) ?? []),
    ]) {
      ranges.set(range.pos, range.end);
    }
  };
  const visit = (node: ts.Node): void => {
    collect(node.getFullStart());
    collect(node.getEnd());
    for (const child of node.getChildren(sourceFile)) visit(child);
  };
  visit(sourceFile);
  const parts: string[] = [];
  let cursor = 0;
  for (const [start, end] of [...ranges].toSorted(
    ([left], [right]) => left - right,
  )) {
    if (start < cursor) continue;
    parts.push(source.slice(cursor, start), blank(source.slice(start, end)));
    cursor = end;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

function blank(text: string): string {
  return text.replaceAll(/[^\n]/gu, ' ');
}

function nameLawFilesBelow(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name) && entry.name !== 'test') {
        files.push(...nameLawFilesBelow(path));
      }
    } else if (
      nameLawExtensions.has(extname(entry.name)) &&
      !/\.test\.[a-z]+$/u.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files;
}

function readJson(root: string, path: string): unknown {
  return JSON.parse(readFileSync(join(root, path), 'utf8')) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} is not an object`);
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, label: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item.length === 0)
  ) {
    throw new Error(`${label} is not a list of non-empty strings`);
  }
  return value as string[];
}

function parsePolicy(value: unknown): NameLawPolicy {
  const policy = asRecord(value, 'policy');
  if (policy.version !== 1) throw new Error('policy version must be 1');
  const named = (key: string, fields: readonly string[]) => {
    const rows = policy[key];
    if (!Array.isArray(rows)) throw new Error(`policy ${key} is not a list`);
    return rows.map((row) => {
      const record = asRecord(row, `policy ${key} row`);
      for (const field of fields) {
        if (typeof record[field] !== 'string' || record[field] === '') {
          throw new Error(`policy ${key} row lacks ${field}`);
        }
      }
      return record as Record<string, string>;
    });
  };
  return {
    externalNames: named('externalNames', ['file', 'name', 'reason']).map(
      (row) => ({ file: row.file ?? '', name: row.name ?? '' }),
    ),
    moduleWords: stringList(policy.moduleWords, 'policy moduleWords'),
    ordinaryWords: stringList(policy.ordinaryWords, 'policy ordinaryWords'),
    platformOwned: named('platformOwned', ['name', 'reason']).map((row) => ({
      name: row.name ?? '',
    })),
    requiredNames: stringList(policy.requiredNames, 'policy requiredNames'),
    scope: stringList(policy.scope, 'policy scope'),
    vocabularySources: stringList(
      policy.vocabularySources,
      'policy vocabularySources',
    ),
  };
}

function parseEngines(value: unknown): EngineRow[] {
  const manifest = asRecord(value, 'engines manifest');
  if (manifest.version !== 1) {
    throw new Error('engines manifest version must be 1');
  }
  if (!Array.isArray(manifest.engines) || manifest.engines.length === 0) {
    throw new Error('engines manifest lists no engines');
  }
  const seen = new Set<string>();
  return manifest.engines.map((row) => {
    const engine = asRecord(row, 'engine row');
    const id = engine.id;
    if (typeof id !== 'string' || !/^[a-z][a-z-]*$/u.test(id) || seen.has(id)) {
      throw new Error(`engine row has a missing or repeated id ${String(id)}`);
    }
    seen.add(id);
    if (
      engine.nameScope !== 'exclusive' &&
      engine.nameScope !== 'engines-only'
    ) {
      throw new Error(
        `engine ${id} nameScope must be exclusive or engines-only`,
      );
    }
    if (stringList(engine.businesses, `engine ${id} businesses`).length < 3) {
      throw new Error(
        `engine ${id} names fewer than three businesses (rule 16)`,
      );
    }
    if (engine.adr !== null && typeof engine.adr !== 'string') {
      throw new Error(`engine ${id} adr must be a path or null`);
    }
    const names = stringList(engine.names, `engine ${id} names`);
    if (names.length === 0) throw new Error(`engine ${id} declares no names`);
    if (!Array.isArray(engine.files)) {
      throw new Error(`engine ${id} files is not a list`);
    }
    return {
      files: stringList(engine.files, `engine ${id} files`),
      id,
      names,
      nameScope: engine.nameScope,
    };
  });
}

export function parseNameLawBaseline(value: unknown): NameLawBaseline {
  const baseline = asRecord(value, 'baseline');
  if (baseline.version !== 1) throw new Error('baseline version must be 1');
  if (typeof baseline.measuredOn !== 'string') {
    throw new Error('baseline measuredOn must be a string');
  }
  const files: Record<string, NameLawBaselineFile> = {};
  for (const [file, row] of Object.entries(
    asRecord(baseline.files, 'baseline files'),
  )) {
    const entry = asRecord(row, `baseline ${file}`);
    if (typeof entry.owner !== 'string' || entry.owner === '') {
      throw new Error(`baseline ${file} has no owner packet`);
    }
    if (typeof entry.cluster !== 'string' || entry.cluster === '') {
      throw new Error(`baseline ${file} has no cluster`);
    }
    if (
      entry.expires !== null &&
      (typeof entry.expires !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/u.test(entry.expires))
    ) {
      throw new Error(`baseline ${file} expires must be YYYY-MM-DD or null`);
    }
    const names: Record<string, number> = {};
    for (const [key, count] of Object.entries(
      asRecord(entry.names, `baseline ${file} names`),
    )) {
      if (!Number.isInteger(count) || (count as number) < 1) {
        throw new Error(`baseline ${file} ${key} must be a positive integer`);
      }
      names[key] = count as number;
    }
    files[file] = {
      cluster: entry.cluster,
      expires: entry.expires,
      names,
      owner: entry.owner,
    };
  }
  return { files, measuredOn: baseline.measuredOn, version: 1 };
}

/**
 * The only way the baseline is rewritten: every count drops to what is
 * observed, and a row observed zero times disappears. Refuses when any
 * observation exceeds its allowance or has none, so it can never raise one.
 */
export function lowerNameLawBaseline(
  baseline: NameLawBaseline,
  observations: NameLawResult['observations'],
): NameLawBaseline {
  const files: Record<string, NameLawBaselineFile> = {};
  for (const [file, keys] of Object.entries(observations)) {
    for (const [key, count] of Object.entries(keys)) {
      const allowance = baseline.files[file]?.names[key];
      if (allowance === undefined || count > allowance) {
        throw new Error(
          `${file} ${key} is ${String(count)} against an allowance of ${String(allowance ?? 0)}; the baseline is never raised`,
        );
      }
    }
  }
  for (const [file, row] of Object.entries(baseline.files).toSorted(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const keys = observations[file] ?? {};
    const names = Object.fromEntries(
      Object.entries(row.names)
        .map(
          ([key, allowance]) =>
            [key, Math.min(allowance, keys[key] ?? 0)] as const,
        )
        .filter(([, count]) => count > 0)
        .toSorted(([left], [right]) => left.localeCompare(right)),
    );
    if (Object.keys(names).length > 0) {
      // The committed key order, so a lowering diff shows only counts.
      files[file] = {
        owner: row.owner,
        cluster: row.cluster,
        expires: row.expires,
        names,
      };
    }
  }
  return { version: 1, measuredOn: baseline.measuredOn, files };
}

function formatNameLaw(result: NameLawResult): string[] {
  if (!result.active) return [];
  let total = 0;
  for (const keys of Object.values(result.observations)) {
    for (const count of Object.values(keys)) total += count;
  }
  const lines = [
    `name-law: ${String(total)} first-party name use(s) in ${String(Object.keys(result.observations).length)} of ${String(result.filesRead)} generic files, vocabulary of ${String(result.vocabulary.length)} names`,
  ];
  if (result.slack.length > 0) {
    lines.push(
      `name-law: ${String(result.slack.length)} baseline row(s) are above what is observed; lower them with \`corepack pnpm guard:lower-baseline\``,
      ...result.slack
        .slice(0, 20)
        .map(
          (row) =>
            `  ${row.file} ${row.key}: baseline ${String(row.baseline)}, observed ${String(row.observed)}`,
        ),
    );
  }
  for (const row of result.expired) {
    lines.push(
      `name-law: ${row.file} (owner ${row.owner}) passed its expiry ${row.expires}`,
    );
  }
  return lines;
}
