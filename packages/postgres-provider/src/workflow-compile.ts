import ts from 'typescript';

import { MAXIMUM_WORKFLOW_SOURCE_BYTES } from './workflow-isolate.js';
import type { WorkflowSdk } from './workflow-sdk.js';

export interface CompiledWorkflow {
  readonly executable: string;
  readonly sdk: WorkflowSdk;
}

const forbiddenNames = new Set([
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

/** The function a workflow body is the inside of. */
export const WORKFLOW_BODY_SIGNATURE =
  'function run(sdk: WorkflowSdk, event: ReceiptEvent): void' as const;

/**
 * The rules this compiler and its lint enforce, stated to the AI drafter
 * (AI-BUILD-1 slice 2), generated from the same signature and ban list.
 */
export function workflowAuthoringRules(): readonly string[] {
  return [
    `body is ONLY the statements inside \`${WORKFLOW_BODY_SIGNATURE} { ... }\`: no function wrapper, no export or import, no async or await, and no return value (it returns void). Use sdk and event directly.`,
    `The body must not use these names: ${[...forbiddenNames].join(', ')}. Use sdk.now() for the time.`,
    'The body type-checks under strict TypeScript against the SDK declarations below; fixtures replay the body twice and must list exactly the calls it makes, in order, with exactly the inputs it passes.',
  ];
}

export function compileWorkflowBody(
  body: string,
  sdk: WorkflowSdk,
): CompiledWorkflow {
  if (Buffer.byteLength(body) > MAXIMUM_WORKFLOW_SOURCE_BYTES) {
    throw new Error('Workflow source exceeds the bundle limit');
  }
  const fileName = '/workflow.ts';
  const sdkFileName = '/workflow-sdk.d.ts';
  const prefix = `${WORKFLOW_BODY_SIGNATURE} {\n`;
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
  lintWorkflowBody(declaration.body, file);

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
  return Object.freeze({ executable, sdk });
}

function lintWorkflowBody(node: ts.Node, file: ts.SourceFile): void {
  if (
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
