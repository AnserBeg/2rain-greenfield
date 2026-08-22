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
  return collectStaticStringRuns((appendStatic, appendDynamic) => {
    appendStatic(
      node.head.text,
      [sourceRange(node.head, sourceFile)],
      node.getStart(sourceFile),
    );
    for (const span of node.templateSpans) {
      const exact = exactStaticTypeString(span.type, sourceFile);
      if (exact) {
        appendStatic(
          exact.value,
          exact.literalRanges,
          span.type.getStart(sourceFile),
        );
      } else {
        appendDynamic();
      }
      appendStatic(
        span.literal.text,
        [sourceRange(span.literal, sourceFile)],
        span.literal.getStart(sourceFile),
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
