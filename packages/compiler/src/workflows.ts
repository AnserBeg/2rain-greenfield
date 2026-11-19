import { canonicalize, type WorkflowDefinition } from '@north-star/canonical-model';
import ts from 'typescript';

import { hashCanonical } from './hash.js';

export const WORKFLOW_RUNTIME_FLOOR = 26;
export const WORKFLOW_PROJECTION_VERSION = 'northstar.workflow-payload/v1';

export interface WorkflowQueryContract {
  readonly lifecycle: string;
  readonly permissionId: string;
  readonly queryId: string;
  readonly queryType: string;
  readonly parameters?: readonly {
    readonly parameterId: string;
    readonly parameterType: { readonly kind: string };
  }[];
  readonly legalEntityScope?: { readonly parameter: { readonly targetId: string } };
}

export interface WorkflowOperationContract {
  readonly confirmation: string;
  readonly effect: { readonly kind: string; readonly entity?: { readonly targetId: string } };
  readonly lifecycle: string;
  readonly operationId: string;
  readonly permissionId: string;
  readonly tier: string;
  readonly inputContract?: {
    readonly closedArgumentKeys: readonly string[];
    readonly fields: readonly {
      readonly enumOptionIds: readonly string[];
      readonly fieldId: string;
      readonly fieldKind: string;
      readonly required: boolean;
    }[];
    readonly relationInputs: readonly { readonly relationId: string; readonly required: boolean }[];
    readonly systemInput?: unknown;
  };
}

export interface CompiledWorkflow extends WorkflowDefinition {
  readonly bodyDigest: string;
  readonly executable: string;
  readonly sdk: WorkflowSdk;
}

export interface WorkflowSdk {
  readonly declarations: string;
  readonly queries: readonly WorkflowQueryContract[];
  readonly operations: readonly WorkflowOperationContract[];
}

export interface WorkflowProjection {
  readonly kind: 'workflowPayload';
  readonly schemaVersion: typeof WORKFLOW_PROJECTION_VERSION;
  readonly workflows: readonly CompiledWorkflow[];
}

export function workflowSdk(
  workflow: WorkflowDefinition,
  queries: readonly WorkflowQueryContract[],
  operations: readonly WorkflowOperationContract[],
): WorkflowSdk {
  const selectedQueries = workflow.grants.queries.map((id) => {
    const query = queries.find((entry) => entry.queryId === id && entry.lifecycle === 'active');
    if (!query) throw new Error(`Workflow query grant no longer resolves: ${id}`);
    return query;
  });
  const selectedOperations = workflow.grants.operations.map((id) => {
    const operation = operations.find((entry) => entry.operationId === id && entry.lifecycle === 'active');
    if (!operation?.inputContract) throw new Error(`Workflow operation grant no longer resolves: ${id}`);
    return operation;
  });
  const declarations = `
    type Json = null | string | number | boolean | readonly Json[] | { readonly [key: string]: Json };
    type ReceiptEvent = Readonly<{ type: 'goodsReceiptPosted'; eventId: string; receiptId: string; legalEntityId: string; movementIds: readonly string[] }>;
    type RecordResult = Readonly<{ recordId: string; revision: number; values: Readonly<Record<string, Json>> }>;
    interface WorkflowSdk {
      now(): string;
      sleep(milliseconds: number): void;
      waitForEvent(type: 'goodsReceiptPosted', timeoutMs: number): ReceiptEvent | null;
      requestApproval(summary: string): boolean;
      ${selectedQueries.map(queryDeclaration).join('\n')}
      ${selectedOperations.map(operationDeclaration).join('\n')}
    }
  `;
  return { declarations, queries: selectedQueries, operations: selectedOperations };
}

function queryDeclaration(query: WorkflowQueryContract): string {
  const parameters = (query.parameters ?? []).map(({ parameterId, parameterType }) =>
    `${JSON.stringify(parameterId)}: ${parameterType.kind === 'legalEntityReferenceParameterType' ? 'string | readonly string[]' : scalarType(parameterType.kind)}`,
  );
  const args = query.queryType === 'get' ? ['recordId: string'] : [];
  if (query.queryType === 'resolve') args.push('match: { key: string; value: string }');
  if (query.queryType === 'search') args.push('text: string');
  if (parameters.length) args.push(`parameters: { ${parameters.join('; ')} }`);
  const result = query.queryType === 'aggregate'
    ? 'Readonly<{ outcome: "exact"; value: Json }>'
    : 'Readonly<{ outcome: "exact" | "ambiguous" | "not-found" | "unsupported"; records: readonly RecordResult[] }>';
  return `query(id: ${JSON.stringify(query.queryId)}, input: { ${args.join('; ')} }): ${result};`;
}

function operationDeclaration(operation: WorkflowOperationContract): string {
  const contract = operation.inputContract!;
  const fields = contract.fields.map((field) => {
    const type = field.enumOptionIds.length
      ? field.enumOptionIds.map((id) => JSON.stringify(id)).join(' | ')
      : scalarType(field.fieldKind);
    return `${JSON.stringify(field.fieldId)}${field.required ? '' : '?'}: ${type}${field.required ? '' : ' | null'}`;
  });
  const relations = contract.relationInputs.map((relation) =>
    `${JSON.stringify(relation.relationId)}${relation.required ? '' : '?'}: string`,
  );
  const keys: Readonly<Record<string, string>> = {
    arguments: 'arguments?: Readonly<Record<string, Json>>',
    expectedRevision: 'expectedRevision: number',
    legalEntityId: 'legalEntityId: string',
    patch: `patch: Partial<{ ${fields.join('; ')} }>`,
    recordId: 'recordId: string',
    relations: `relations${contract.relationInputs.some((relation) => relation.required) ? '' : '?'}: { ${relations.join('; ')} }`,
    values: `values: { ${fields.join('; ')} }`,
  };
  const input = contract.closedArgumentKeys.map((key) => {
    if (!(key in keys)) throw new Error(`Unknown workflow operation input: ${key}`);
    return keys[key];
  }).join('; ');
  return `operation(id: ${JSON.stringify(operation.operationId)}, input: { ${input} }): Readonly<{ outcome: 'succeeded' | 'unsupported'; readBack: RecordResult | null }>;`;
}

function scalarType(kind: string): string {
  if (kind === 'integerFieldType') return 'number';
  if (kind === 'booleanFieldType') return 'boolean';
  return 'string';
}

const blockedIdentifiers = new Set([
  'Date', 'Temporal', 'performance', 'crypto', 'process', 'require', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'globalThis', 'eval', 'Function', 'WebAssembly',
  'WeakRef', 'FinalizationRegistry', 'Atomics', 'SharedArrayBuffer', 'Promise',
]);

export function compileWorkflow(workflow: WorkflowDefinition, sdk: WorkflowSdk): CompiledWorkflow {
  const name = '/__northstar_workflow__.ts';
  const source = `${sdk.declarations}\nfunction run(sdk: WorkflowSdk, event: ReceiptEvent): void {\n${workflow.body}\n}\n`;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    lib: ['lib.es2022.d.ts'],
    types: [],
    strict: true,
    noEmitOnError: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const file = ts.createSourceFile(name, source, options.target!, true);
  host.getSourceFile = (path, ...args) => path === name ? file : getSourceFile(path, ...args);
  const lastStatement = file.statements.at(-1);
  if (!lastStatement || !ts.isFunctionDeclaration(lastStatement) || lastStatement.name?.text !== 'run' || file.statements.length !== 5 || lastStatement.end !== source.trimEnd().length) {
    throw new Error('Workflow source must be the body of one function');
  }
  function lint(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node) ||
      node.kind === ts.SyntaxKind.ImportKeyword || node.kind === ts.SyntaxKind.ExportKeyword ||
      node.kind === ts.SyntaxKind.AsyncKeyword ||
      (ts.isIdentifier(node) && blockedIdentifiers.has(node.text)) ||
      ((ts.isPropertyAccessExpression(node) && node.name.text === 'random') ||
        (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === 'random'))
    ) {
      throw new Error(`Workflow uses forbidden JavaScript syntax: ${node.getText(file)}`);
    }
    ts.forEachChild(node, lint);
  }
  lint(lastStatement);
  if (file.referencedFiles.length || file.typeReferenceDirectives.length || file.libReferenceDirectives.length) {
    throw new Error('Workflow reference directives are forbidden');
  }
  const program = ts.createProgram([name], options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program);
  if (diagnostics.length) {
    throw new Error(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n')).join('\n'));
  }
  let executable = '';
  program.emit(undefined, (_path, code) => { executable = code; });
  if (!executable) throw new Error('Workflow emitted no executable code');
  return {
    ...workflow,
    bodyDigest: hashCanonical('northstar.workflow-body/v1', workflow.body).digest,
    executable,
    sdk,
  };
}

export function assertWorkflowBinding(
  compiled: CompiledWorkflow,
  queries: readonly WorkflowQueryContract[],
  operations: readonly WorkflowOperationContract[],
): void {
  const sdk = workflowSdk(compiled, queries, operations);
  if (canonicalize(compileWorkflow(compiled, sdk)) !== canonicalize(compiled)) {
    throw new Error(`Workflow executable or SDK binding changed: ${compiled.workflowId}`);
  }
}
