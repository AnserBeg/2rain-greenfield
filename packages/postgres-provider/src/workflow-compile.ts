import {
  RemovedWorkflowAction,
  WORKFLOW_SDK_VERSION,
} from './workflow-sdk-version.js';
import ts from 'typescript';

import { MAXIMUM_WORKFLOW_SOURCE_BYTES } from './workflow-isolate.js';
import type { WorkflowSdk } from './workflow-sdk.js';

export interface CompiledWorkflow {
  readonly executable: string;
  readonly sdk: WorkflowSdk;
}

const forbiddenNames = new Set([
  'arguments',
  'Date',
  'Temporal',
  'performance',
  'crypto',
  'process',
  'require',
  'module',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'Deno',
  'Bun',
  'std',
  'os',
  'readFile',
  'writeFile',
  'setTimeout',
  'setInterval',
  'globalThis',
  'eval',
  'Function',
  'WebAssembly',
  'WeakRef',
  'FinalizationRegistry',
  'Atomics',
  'SharedArrayBuffer',
  'Promise',
  'Proxy',
  'Intl',
  'random',
]);

export function compileWorkflowBody(body: string, sdk: WorkflowSdk) {
  if (Buffer.byteLength(body) > MAXIMUM_WORKFLOW_SOURCE_BYTES) {
    throw new Error('Workflow source exceeds the bundle limit');
  }
  const fileName = '/workflow.ts';
  const sdkFileName = '/workflow-sdk.d.ts';
  const prefix =
    'function run(sdk: WorkflowSdk, event: ReceiptEvent): void {\n';
  const source = `${prefix}${body}\n}`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noEmitOnError: true,
    skipLibCheck: true,
  };
  const file = ts.createSourceFile(fileName, source, options.target!, true);
  const declaration = file.statements[0];
  if (
    file.statements.length !== 1 ||
    !declaration ||
    !ts.isFunctionDeclaration(declaration) ||
    declaration.body?.getStart(file) !== prefix.lastIndexOf('{') ||
    declaration.body.end !== source.length
  ) {
    throw new Error('Workflow source must fit inside one function body');
  }
  if (
    file.referencedFiles.length ||
    file.typeReferenceDirectives.length ||
    file.libReferenceDirectives.length ||
    file.hasNoDefaultLib
  ) {
    throw new Error('Workflow reference directives are forbidden');
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.ES2022,
    false,
    ts.LanguageVariant.Standard,
    body,
  );
  for (
    let token = scanner.scan();
    token !== ts.SyntaxKind.EndOfFileToken;
    token = scanner.scan()
  ) {
    if (
      (token === ts.SyntaxKind.SingleLineCommentTrivia ||
        token === ts.SyntaxKind.MultiLineCommentTrivia) &&
      /@ts-(?:ignore|nocheck|expect-error)\b/u.test(scanner.getTokenText())
    )
      throw new Error('Workflow compiler suppression is forbidden');
  }

  const host = ts.createCompilerHost(options);
  const defaultLibPath = host.getDefaultLibLocation!();
  const isDefaultLib = (name: string) =>
    name.startsWith(`${defaultLibPath}/`) &&
    /^lib\.[a-z0-9.]+\.d\.ts$/u.test(name.slice(defaultLibPath.length + 1));
  const readFile = host.readFile.bind(host);
  const getSourceFile = host.getSourceFile.bind(host);
  const fileExists = host.fileExists.bind(host);
  const declarationFile = ts.createSourceFile(
    sdkFileName,
    sdk.declarations,
    options.target!,
    true,
  );
  host.readFile = (name) =>
    name === fileName
      ? source
      : name === sdkFileName
        ? sdk.declarations
        : isDefaultLib(name)
          ? readFile(name)
          : undefined;
  host.fileExists = (name) =>
    name === fileName ||
    name === sdkFileName ||
    (isDefaultLib(name) && fileExists(name));
  host.getSourceFile = (name, ...args) =>
    name === fileName
      ? file
      : name === sdkFileName
        ? declarationFile
        : isDefaultLib(name)
          ? getSourceFile(name, ...args)
          : undefined;

  const program = ts.createProgram([fileName, sdkFileName], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (
    sdk.version === WORKFLOW_SDK_VERSION &&
    diagnostics.some(
      (d) =>
        d.code === 2339 &&
        ts.flattenDiagnosticMessageText(d.messageText, '\n') ===
          "Property 'waitForEvent' does not exist on type 'WorkflowSdk'.",
    )
  )
    throw new RemovedWorkflowAction();
  lintWorkflowBody(declaration.body, file);
  if (diagnostics.length) {
    throw new Error(
      ts
        .formatDiagnostics(diagnostics, {
          getCanonicalFileName: (name) => name,
          getCurrentDirectory: () => '/',
          getNewLine: () => '\n',
        })
        .trim(),
    );
  }
  let executable: string | undefined;
  program.emit(file, (_path, code) => {
    executable = code;
  });
  if (
    !executable ||
    Buffer.byteLength(executable) > MAXIMUM_WORKFLOW_SOURCE_BYTES
  ) {
    throw new Error(
      'Workflow emitted no executable or exceeded the executable limit',
    );
  }
  const sites = workflowSites(file, declaration.body, program.getTypeChecker());
  const emitted = ts.createSourceFile(
    '/workflow.js',
    executable,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  );
  const accesses: ts.PropertyAccessExpression[] = [];
  const collect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && isSdkAccess(node.expression))
      accesses.push(node.expression);
    ts.forEachChild(node, collect);
  };
  collect(emitted);
  if (sites.length !== accesses.length)
    throw new Error('Unable to account for every emitted SDK call');
  let traced = executable;
  for (let i = accesses.length - 1; i >= 0; --i) {
    const name = accesses[i]!.name;
    traced =
      traced.slice(0, name.getStart(emitted)) +
      'site' +
      i +
      traced.slice(name.end);
  }
  return Object.freeze({ executable, sdk, sites, traced });
}

function isSdkAccess(node: ts.Node): node is ts.PropertyAccessExpression {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'sdk'
  );
}

function workflowSites(
  file: ts.SourceFile,
  body: ts.Block,
  checker: ts.TypeChecker,
) {
  const sites: {
    method: string;
    target: string | null;
    fields: string[];
    branch: boolean;
    loop: boolean;
    line: number;
  }[] = [];
  function visit(node: ts.Node, branch: boolean, loop: boolean) {
    if (ts.isCallExpression(node) && isSdkAccess(node.expression)) {
      const method = node.expression.name.text;
      const targeted = ['query', 'operation', 'requestApproval'].includes(
        method,
      );
      const argument = node.arguments[method === 'requestApproval' ? 1 : 0];
      if (targeted && argument && !ts.isStringLiteralLike(argument))
        throw new Error('Workflow review requires a literal SDK target');
      const input =
        targeted && node.arguments[method === 'requestApproval' ? 2 : 1];
      const fields: string[] = [];
      if (input) {
        const inputType = checker.getTypeAtLocation(input);
        for (const property of inputType.getProperties()) {
          fields.push(property.name);
          if (['values', 'patch', 'relations'].includes(property.name)) {
            const type = checker.getTypeOfSymbolAtLocation(property, input);
            fields.push(...type.getProperties().map((field) => field.name));
          }
        }
      }
      sites.push({
        method,
        target:
          targeted && argument && ts.isStringLiteralLike(argument)
            ? argument.text
            : null,
        fields: fields.sort(),
        branch,
        loop,
        line: file.getLineAndCharacterOfPosition(node.getStart(file)).line,
      });
    }
    ts.forEachChild(node, (child) =>
      visit(
        child,
        branch ||
          (ts.isIfStatement(node) && child !== node.expression) ||
          (ts.isConditionalExpression(node) && child !== node.condition) ||
          ts.isCaseOrDefaultClause(node) ||
          (ts.isBinaryExpression(node) &&
            child === node.right &&
            [
              ts.SyntaxKind.AmpersandAmpersandToken,
              ts.SyntaxKind.BarBarToken,
              ts.SyntaxKind.QuestionQuestionToken,
            ].includes(node.operatorToken.kind)),
        loop || ts.isIterationStatement(node, false),
      ),
    );
  }
  visit(body, false, false);
  return sites;
}

function lintWorkflowBody(node: ts.Node, file: ts.SourceFile): void {
  if (
    (ts.isIdentifier(node) &&
      node.text === 'sdk' &&
      !(
        isSdkAccess(node.parent) &&
        node.parent.expression === node &&
        ts.isCallExpression(node.parent.parent) &&
        node.parent.parent.expression === node.parent &&
        [
          'now',
          'sleep',
          'query',
          'operation',
          'requestApproval',
          'waitForEvent',
        ].includes(node.parent.name.text)
      )) ||
    node.kind === ts.SyntaxKind.ImportKeyword ||
    node.kind === ts.SyntaxKind.ExportKeyword ||
    node.kind === ts.SyntaxKind.AsyncKeyword ||
    ts.isImportTypeNode(node) ||
    ts.isModuleDeclaration(node) ||
    (ts.isIdentifier(node) && forbiddenNames.has(node.text)) ||
    (ts.isElementAccessExpression(node) &&
      ts.isStringLiteralLike(node.argumentExpression) &&
      forbiddenNames.has(node.argumentExpression.text)) ||
    (ts.isBindingElement(node) &&
      node.propertyName &&
      ts.isStringLiteralLike(node.propertyName) &&
      forbiddenNames.has(node.propertyName.text)) ||
    (ts.isComputedPropertyName(node) &&
      ts.isStringLiteralLike(node.expression) &&
      forbiddenNames.has(node.expression.text))
  ) {
    throw new Error(
      `Workflow uses forbidden syntax: ${node.getText(file).slice(0, 80)}`,
    );
  }
  ts.forEachChild(node, (child) => lintWorkflowBody(child, file));
}
