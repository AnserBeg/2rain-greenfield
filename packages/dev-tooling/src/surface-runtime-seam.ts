import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

export interface SurfaceContractViolation {
  file: string;
  message: string;
  ruleId:
    | 'SURF001_RUNTIME_BYPASS'
    | 'SURF002_COMPONENT_VOCABULARY'
    | 'SURF003_RUNTIME_AUTHORITY'
    | 'UX001_SKILL_SHAPE'
    | 'UX002_PLAN_PIN'
    | 'UX003_VOCABULARY_DRIFT'
    | 'UX004_RUNTIME_PIN';
}

export interface SurfaceContractCheckResult {
  violations: SurfaceContractViolation[];
}

interface UxGrammarPin {
  archetypes: string[];
  componentPolicy: string;
  components: string[];
  definitionSource: string;
  planSections: string[];
  runtimeEntrypoint: string;
  schemaVersion: string;
  slots: Record<string, string[]>;
  statusRoles: string[];
}

const paths = Object.freeze({
  appServer: 'apps/web/src/app-server.ts',
  canonicalConstants: 'packages/canonical-model/src/constants.ts',
  componentRegistry: 'apps/web/src/component-registry.ts',
  plan: 'docs/greenfield-north-star-erp-platform-plan.md',
  skill: '.agents/skills/ux-grammar/SKILL.md',
  surfaceContract: 'apps/web/src/surface-contract.ts',
  surfaceComposition: 'apps/web/src/surface-composition.ts',
  surfaceRuntime: 'apps/web/src/surface-runtime.ts',
});

const expectedPinIdentity = Object.freeze({
  componentPolicy: 'closed-own-entry-only',
  definitionSource: 'RequestRuntimeView.projections.surface',
  planSections: Object.freeze(['8.5', '8.6']),
  runtimeEntrypoint: 'apps/web/src/surface-runtime.ts#renderSurfaceRuntime',
  schemaVersion: 'northstar.ux-grammar-pin/v1',
});

const planSlotAnchors = Object.freeze({
  activity: 'activity rail',
  breadcrumb: 'breadcrumb',
  bulkActions: 'bulk bar',
  childTables: 'child tables',
  commandBar: 'command bar',
  dataGrid: 'spreadsheet-grade grid',
  decision: 'one decision per screen',
  draftBanner: 'visible draft banner',
  exceptions: 'exception cards',
  keyFacts: 'key facts',
  modeSwitch: 'operate/customize mode switch',
  primaryAction: 'large touch targets',
  properties: 'right properties drawer',
  publishDiff: 'publish diff',
  savedViews: 'saved-view tabs',
  scanInput: 'scan-first input',
  sections: 'sections',
  selection: 'edit-in-place selection',
  setupChecklist: 'setup checklist',
  title: 'title',
  titleStatus: 'title + status chip',
} satisfies Record<string, string>);

export function checkUxGrammarPin(
  rootDirectory: string,
): SurfaceContractCheckResult {
  const root = resolve(rootDirectory);
  const violations: SurfaceContractViolation[] = [];
  const skill = readRequired(
    root,
    paths.skill,
    'UX001_SKILL_SHAPE',
    violations,
  );
  const plan = readRequired(root, paths.plan, 'UX002_PLAN_PIN', violations);
  const canonical = readRequired(
    root,
    paths.canonicalConstants,
    'UX003_VOCABULARY_DRIFT',
    violations,
  );
  const surfaceContract = readRequired(
    root,
    paths.surfaceContract,
    'UX004_RUNTIME_PIN',
    violations,
  );
  const surfaceRuntime = readRequired(
    root,
    paths.surfaceRuntime,
    'UX004_RUNTIME_PIN',
    violations,
  );
  const appServer = readRequired(
    root,
    paths.appServer,
    'UX004_RUNTIME_PIN',
    violations,
  );
  const componentRegistry = readRequired(
    root,
    paths.componentRegistry,
    'UX004_RUNTIME_PIN',
    violations,
  );

  if (
    skill === undefined ||
    plan === undefined ||
    canonical === undefined ||
    surfaceContract === undefined ||
    surfaceRuntime === undefined ||
    appServer === undefined ||
    componentRegistry === undefined
  ) {
    return result(violations);
  }

  checkSkillShape(skill, violations);
  const pin = parseSkillPin(skill, violations);
  if (!pin) return result(violations);

  checkPlanPin(plan, pin, violations);
  checkVocabularyPin(
    canonical,
    surfaceContract,
    componentRegistry,
    pin,
    violations,
  );
  checkRuntimePin(
    surfaceContract,
    surfaceRuntime,
    appServer,
    componentRegistry,
    pin,
    violations,
  );
  return result(violations);
}

export function checkSurfaceRuntimeSeam(
  rootDirectory: string,
): SurfaceContractCheckResult {
  const root = resolve(rootDirectory);
  const violations: SurfaceContractViolation[] = [];
  const skill = readRequired(
    root,
    paths.skill,
    'SURF003_RUNTIME_AUTHORITY',
    violations,
  );
  const surfaceRuntime = readRequired(
    root,
    paths.surfaceRuntime,
    'SURF003_RUNTIME_AUTHORITY',
    violations,
  );
  const appServer = readRequired(
    root,
    paths.appServer,
    'SURF003_RUNTIME_AUTHORITY',
    violations,
  );
  const componentRegistry = readRequired(
    root,
    paths.componentRegistry,
    'SURF003_RUNTIME_AUTHORITY',
    violations,
  );

  if (
    skill === undefined ||
    surfaceRuntime === undefined ||
    appServer === undefined ||
    componentRegistry === undefined
  ) {
    return result(violations);
  }

  const pin = parseSkillPin(skill, violations);
  if (!pin) return result(violations);

  checkRuntimeAuthority(
    surfaceRuntime,
    appServer,
    componentRegistry,
    violations,
  );
  checkRegisteredComponents(componentRegistry, pin, violations);
  scanForBypass(root, violations);
  return result(violations);
}

export function formatSurfaceContractViolations(
  label: string,
  check: SurfaceContractCheckResult,
): string {
  if (check.violations.length === 0) return `${label}: PASS`;
  return [
    `${label}: FAIL (${check.violations.length} violations)`,
    ...check.violations.map(
      (violation) =>
        `${violation.file} [${violation.ruleId}] ${violation.message}`,
    ),
  ].join('\n');
}

function checkSkillShape(
  skill: string,
  violations: SurfaceContractViolation[],
): void {
  if (!skill.startsWith('---\n')) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill frontmatter must be the first bytes in the file',
    );
    return;
  }
  const end = skill.indexOf('\n---\n', 4);
  if (end < 0) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill frontmatter must have a closing delimiter',
    );
    return;
  }
  const frontmatter = skill.slice(4, end);
  if (!/^name:\s*ux-grammar\s*$/m.test(frontmatter)) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill frontmatter must name ux-grammar',
    );
  }
  if (!/^description:\s*\S/m.test(frontmatter)) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill frontmatter must contain a non-empty description',
    );
  }
  const compactSkill = skill.replaceAll('`', '').replace(/\s+/g, ' ');
  const requiredGuidance = [
    'Users customize content, never grammar',
    'Every screen renders through SurfaceRuntime from a compiled SurfaceDefinition',
    'No bespoke route or React screen for ordinary reads/writes',
    'Status colors resolve only from role tokens',
    'Weight matches consequence',
  ];
  if (requiredGuidance.some((fragment) => !compactSkill.includes(fragment))) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill must retain the binding G1 guidance anchors',
    );
  }
}

function parseSkillPin(
  skill: string,
  violations: SurfaceContractViolation[],
): UxGrammarPin | undefined {
  const match = skill.match(
    /<!-- ux-grammar-contract:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- ux-grammar-contract:end -->/,
  );
  if (!match?.[1]) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'skill must contain one machine-readable ux-grammar contract block',
    );
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'ux-grammar contract block must be valid JSON',
    );
    return undefined;
  }
  if (!isRecord(value)) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'ux-grammar contract block must be a JSON object',
    );
    return undefined;
  }

  const requiredKeys = [
    'archetypes',
    'componentPolicy',
    'components',
    'definitionSource',
    'planSections',
    'runtimeEntrypoint',
    'schemaVersion',
    'slots',
    'statusRoles',
  ];
  if (!sameStrings(Object.keys(value).sort(), requiredKeys)) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'ux-grammar contract keys must match the versioned G1 shape exactly',
    );
    return undefined;
  }
  if (
    !isStringArray(value.archetypes) ||
    typeof value.componentPolicy !== 'string' ||
    !isStringArray(value.components) ||
    typeof value.definitionSource !== 'string' ||
    !isStringArray(value.planSections) ||
    typeof value.runtimeEntrypoint !== 'string' ||
    typeof value.schemaVersion !== 'string' ||
    !isStringArrayRecord(value.slots) ||
    !isStringArray(value.statusRoles)
  ) {
    add(
      violations,
      paths.skill,
      'UX001_SKILL_SHAPE',
      'ux-grammar contract values must match the versioned G1 types',
    );
    return undefined;
  }

  return {
    archetypes: value.archetypes,
    componentPolicy: value.componentPolicy,
    components: value.components,
    definitionSource: value.definitionSource,
    planSections: value.planSections,
    runtimeEntrypoint: value.runtimeEntrypoint,
    schemaVersion: value.schemaVersion,
    slots: value.slots,
    statusRoles: value.statusRoles,
  };
}

function checkPlanPin(
  plan: string,
  pin: UxGrammarPin,
  violations: SurfaceContractViolation[],
): void {
  const section85 = section(plan, '### 8.5 Binding UX grammar', '### 8.6');
  const section86 = section(
    plan,
    '### 8.6 Grammar encoding and enforcement',
    '## 9.',
  );
  if (
    !sameStrings(pin.planSections, expectedPinIdentity.planSections) ||
    section85 === undefined ||
    section86 === undefined
  ) {
    add(
      violations,
      paths.plan,
      'UX002_PLAN_PIN',
      'skill must pin existing plan sections 8.5 and 8.6',
    );
    return;
  }

  const compact85 = section85.replace(/\s+/g, ' ');
  const compact86 = section86.replace(/\s+/g, ' ');

  const required85 = [
    'users customize content, never grammar',
    'one three-part shell',
    'one global status-color grammar',
    'weight matches consequence',
  ];
  const required86 = [
    'every screen renders through SurfaceRuntime from a compiled definition',
    'Unknown archetypes, slots, or status roles fail compilation',
    'drift between document, skill, and code fails CI',
  ];
  const planStatusRoles = statusRolesFromPlan(compact85);
  const planSlotsMatch = pin.archetypes.every((archetype) => {
    const row = fixedAnatomyRow(section85, archetype);
    const slots = pin.slots[archetype];
    return (
      row !== undefined &&
      slots !== undefined &&
      slots.every((slot) => {
        const anchor = planSlotAnchors[slot as keyof typeof planSlotAnchors];
        return anchor !== undefined && row.includes(anchor);
      })
    );
  });
  if (
    required85.some((fragment) => !compact85.includes(fragment)) ||
    required86.some((fragment) => !compact86.includes(fragment)) ||
    !planStatusRoles ||
    !sameSet(planStatusRoles, pin.statusRoles) ||
    !planSlotsMatch ||
    pin.archetypes.some(
      (archetype) => !section85.includes(`| ${capitalize(archetype)} |`),
    )
  ) {
    add(
      violations,
      paths.plan,
      'UX002_PLAN_PIN',
      'plan 8.5-8.6 no longer contains the pinned grammar anchors',
    );
  }
}

function checkVocabularyPin(
  canonical: string,
  surfaceContract: string,
  componentRegistry: string,
  pin: UxGrammarPin,
  violations: SurfaceContractViolation[],
): void {
  const canonicalArchetypes = stringArray(
    canonical,
    /export const SURFACE_ARCHETYPES = \[([\s\S]*?)\] as const;/,
  );
  const canonicalStatusRoles = stringArray(
    canonical,
    /export const STATUS_ROLES = \[([\s\S]*?)\] as const;/,
  );
  const runtimeArchetypes = stringArray(
    surfaceContract,
    /const archetypes = \[([\s\S]*?)\] as const;/,
  );
  const runtimeStatusRoles = stringArray(
    surfaceContract,
    /const statusRoles = \[([\s\S]*?)\] as const;/,
  );
  const canonicalSlots = slotVocabulary(canonical, pin.archetypes, false);
  const runtimeSlots = slotVocabulary(surfaceContract, pin.archetypes, true);
  const components = registeredComponentIds(componentRegistry);

  if (
    !canonicalArchetypes ||
    !runtimeArchetypes ||
    !sameSet(pin.archetypes, canonicalArchetypes) ||
    !sameSet(pin.archetypes, runtimeArchetypes)
  ) {
    add(
      violations,
      paths.skill,
      'UX003_VOCABULARY_DRIFT',
      'skill, canonical model, and SurfaceRuntime archetypes must match',
    );
  }
  if (
    !canonicalStatusRoles ||
    !runtimeStatusRoles ||
    !sameSet(pin.statusRoles, canonicalStatusRoles) ||
    !sameSet(pin.statusRoles, runtimeStatusRoles)
  ) {
    add(
      violations,
      paths.skill,
      'UX003_VOCABULARY_DRIFT',
      'skill, canonical model, and SurfaceRuntime status roles must match',
    );
  }
  if (
    !canonicalSlots ||
    !runtimeSlots ||
    !sameSlotVocabulary(pin.slots, canonicalSlots) ||
    !sameSlotVocabulary(pin.slots, runtimeSlots)
  ) {
    add(
      violations,
      paths.skill,
      'UX003_VOCABULARY_DRIFT',
      'skill, canonical model, and SurfaceRuntime slots must match',
    );
  }
  if (!components || !sameStrings([...pin.components].sort(), components)) {
    add(
      violations,
      paths.skill,
      'UX003_VOCABULARY_DRIFT',
      'skill component vocabulary must match the closed G1 registry',
    );
  }
}

function checkRuntimePin(
  surfaceContract: string,
  surfaceRuntime: string,
  appServer: string,
  componentRegistry: string,
  pin: UxGrammarPin,
  violations: SurfaceContractViolation[],
): void {
  const identityMatches =
    pin.schemaVersion === expectedPinIdentity.schemaVersion &&
    pin.runtimeEntrypoint === expectedPinIdentity.runtimeEntrypoint &&
    pin.definitionSource === expectedPinIdentity.definitionSource &&
    pin.componentPolicy === expectedPinIdentity.componentPolicy;
  const codeMatches =
    surfaceContract.includes('const projection = view.projections.surface;') &&
    surfaceRuntime.includes('export function renderSurfaceRuntime(') &&
    surfaceRuntime.includes('assertRequestRuntimeView(view);') &&
    surfaceRuntime.includes('readCompiledSurfaceManifest(view)') &&
    surfaceRuntime.includes('renderRegisteredSurfaceComponent({') &&
    appServer.includes('entry.run({ headers: request.headers }, (view) =>') &&
    appServer.includes('renderSurfaceRuntime(view, url.href)') &&
    componentRegistry.includes('Object.hasOwn(');
  if (!identityMatches || !codeMatches) {
    add(
      violations,
      paths.skill,
      'UX004_RUNTIME_PIN',
      'skill runtime authority pin must match the issued-view SurfaceRuntime seam',
    );
  }
}

function checkRuntimeAuthority(
  surfaceRuntime: string,
  appServer: string,
  componentRegistry: string,
  violations: SurfaceContractViolation[],
): void {
  const runtimeRequired = [
    'assertRequestRuntimeView(view);',
    'readCompiledSurfaceManifest(view)',
    'renderRegisteredSurfaceComponent({',
  ];
  const runtimeForbidden = [
    /ActiveReleasePointer/,
    /TenantRelease/,
    /readFileSync/,
    /process\.env/,
  ];
  if (
    runtimeRequired.some((fragment) => !surfaceRuntime.includes(fragment)) ||
    runtimeForbidden.some((pattern) => pattern.test(surfaceRuntime)) ||
    !appServer.includes('entry.run({ headers: request.headers }, (view) =>') ||
    !appServer.includes('renderSurfaceRuntime(view, url.href)') ||
    !componentRegistry.includes('Object.hasOwn(') ||
    /registerSurfaceComponent|new Map\s*</.test(componentRegistry)
  ) {
    add(
      violations,
      paths.surfaceRuntime,
      'SURF003_RUNTIME_AUTHORITY',
      'browser surfaces must use one issued view and the closed SurfaceRuntime registry',
    );
  }
}

function checkRegisteredComponents(
  componentRegistry: string,
  pin: UxGrammarPin,
  violations: SurfaceContractViolation[],
): void {
  const actual = registeredComponentIds(componentRegistry);
  if (!actual || !sameStrings(actual, [...pin.components].sort())) {
    add(
      violations,
      paths.componentRegistry,
      'SURF002_COMPONENT_VOCABULARY',
      'registered components must match the closed ux-grammar G1 vocabulary',
    );
  }
}

function scanForBypass(
  root: string,
  violations: SurfaceContractViolation[],
): void {
  const sourceRoot = join(root, 'apps/web');
  if (!existsSync(sourceRoot)) {
    add(
      violations,
      'apps/web',
      'SURF003_RUNTIME_AUTHORITY',
      'web production source directory is missing',
    );
    return;
  }
  const allowedMarkup = new Set<string>([
    // Generic v6 interpreter delegated only by SurfaceRuntime and its registry.
    paths.surfaceComposition,
    paths.componentRegistry,
    paths.surfaceRuntime,
    // Owner-ratified RECEIPT §5.11 exception: this focused renderer is consumed
    // only by the closed registry; it is not an alternate surface authority.
    'apps/web/src/receiving-section.ts',
  ]);
  const allowedSurfaceConsumers = new Set<string>([
    paths.surfaceComposition,
    paths.componentRegistry,
    paths.surfaceRuntime,
  ]);
  const structuralMarkup =
    /<\s*(?:html|body|head|header|footer|main|nav|aside|section|article|form|fieldset|legend|input|select|textarea|button|table|h[1-6])(?:\s|>)|createElement\(\s*['"](?:html|body|head|header|footer|main|nav|aside|section|article|form|fieldset|legend|input|select|textarea|button|table|h[1-6])['"]|(?:jsx|jsxs|jsxDEV)\(\s*['"](?:html|body|head|header|footer|main|nav|aside|section|article|form|fieldset|legend|input|select|textarea|button|table|h[1-6])['"]|data-surface-archetype\s*=|data-component\s*=/i;

  const genericRuntime = readFileSync(join(root, paths.surfaceRuntime), 'utf8');
  if (/goods_receipt|purchase_order|receiving-section/u.test(genericRuntime)) {
    add(
      violations,
      paths.surfaceRuntime,
      'SURF001_RUNTIME_BYPASS',
      'generic SurfaceRuntime contains application-domain selection or loading',
    );
  }

  for (const file of sourceFiles(sourceRoot)) {
    const repoPath = normalize(relative(root, file));
    const source = readFileSync(file, 'utf8');
    if (
      repoPath !== paths.surfaceRuntime &&
      repoPath !== paths.componentRegistry &&
      /from ['"][^'"]*surface-composition\.js['"]/.test(source)
    )
      add(
        violations,
        repoPath,
        'SURF001_RUNTIME_BYPASS',
        'only SurfaceRuntime and its closed registry may delegate to the composition interpreter',
      );
    if (!allowedMarkup.has(repoPath) && structuralMarkup.test(source)) {
      add(
        violations,
        repoPath,
        'SURF001_RUNTIME_BYPASS',
        'surface markup exists outside SurfaceRuntime or its closed component registry',
      );
    }
    if (
      !allowedSurfaceConsumers.has(repoPath) &&
      /from ['"][^'"]*(?:component-registry|surface-contract)\.js['"]/.test(
        source,
      )
    ) {
      add(
        violations,
        repoPath,
        'SURF001_RUNTIME_BYPASS',
        'only SurfaceRuntime may consume the surface contract or component registry',
      );
    }
    if (
      repoPath !== paths.appServer &&
      /from ['"][^'"]*surface-runtime\.js['"]/.test(source)
    ) {
      add(
        violations,
        repoPath,
        'SURF001_RUNTIME_BYPASS',
        'only the issued-view app server may invoke SurfaceRuntime',
      );
    }
  }
}

function registeredComponentIds(source: string): string[] | undefined {
  const match = source.match(
    /const componentRegistry:[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\);/,
  );
  if (!match?.[1]) return undefined;
  const lines = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const property = /^['"]([^'"]+)['"]\s*:\s*[A-Za-z_$][\w$]*,$/;
  if (lines.some((line) => !property.test(line))) return undefined;
  return lines
    .map((line) => line.match(property)?.[1])
    .filter((entry): entry is string => entry !== undefined)
    .sort();
}

function statusRolesFromPlan(section85: string): string[] | undefined {
  const match = section85.match(/one global status-color grammar \(([^)]+)\)/);
  if (!match?.[1]) return undefined;
  return match[1].split(',').map((role) => {
    const normalized = role.trim();
    return normalized === 'in progress' ? 'inProgress' : normalized;
  });
}

function fixedAnatomyRow(
  section85: string,
  archetype: string,
): string | undefined {
  const prefix = `| ${capitalize(archetype)} |`;
  const rows = section85.split('\n').filter((line) => line.startsWith(prefix));
  if (rows.length !== 1) return undefined;
  return rows[0]?.slice(prefix.length, rows[0].lastIndexOf('|')).trim();
}

function slotVocabulary(
  source: string,
  archetypes: string[],
  runtime: boolean,
): Record<string, string[]> | undefined {
  const slots: Record<string, string[]> = {};
  for (const archetype of archetypes) {
    const expression = runtime
      ? new RegExp(`${archetype}:\\s*Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\)`)
      : new RegExp(`${archetype}:\\s*\\[([\\s\\S]*?)\\]`);
    const values = stringArray(source, expression);
    if (!values) return undefined;
    slots[archetype] = values;
  }
  return slots;
}

function stringArray(source: string, expression: RegExp): string[] | undefined {
  const match = source.match(expression);
  if (!match?.[1]) return undefined;
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)]
    .map((entry) => entry[1])
    .filter((entry): entry is string => entry !== undefined);
}

function section(
  document: string,
  startHeading: string,
  nextHeadingPrefix: string,
): string | undefined {
  const start = document.indexOf(startHeading);
  if (start < 0) return undefined;
  const next = document.indexOf(nextHeadingPrefix, start + startHeading.length);
  return document.slice(start, next < 0 ? undefined : next);
}

function readRequired(
  root: string,
  repoPath: string,
  ruleId: SurfaceContractViolation['ruleId'],
  violations: SurfaceContractViolation[],
): string | undefined {
  const path = join(root, repoPath);
  if (!existsSync(path)) {
    add(violations, repoPath, ruleId, 'required contract file is missing');
    return undefined;
  }
  return readFileSync(path, 'utf8');
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        [
          'node_modules',
          'playwright-report',
          'release',
          'test',
          'test-results',
        ].includes(entry.name)
      ) {
        continue;
      }
      files.push(...sourceFiles(path));
    } else if (
      ['.html', '.js', '.jsx', '.ts', '.tsx'].includes(extname(entry.name))
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

function sameSlotVocabulary(
  left: Record<string, string[]>,
  right: Record<string, string[]>,
): boolean {
  const keys = Object.keys(left).sort();
  if (!sameStrings(keys, Object.keys(right).sort())) return false;
  return keys.every((key) => sameStrings(left[key] ?? [], right[key] ?? []));
}

function sameSet(left: string[], right: string[]): boolean {
  return sameStrings([...left].sort(), [...right].sort());
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isStringArrayRecord(
  value: unknown,
): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every(isStringArray);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function capitalize(value: string): string {
  return value.length === 0
    ? value
    : `${value[0]?.toUpperCase()}${value.slice(1)}`;
}

function add(
  violations: SurfaceContractViolation[],
  file: string,
  ruleId: SurfaceContractViolation['ruleId'],
  message: string,
): void {
  violations.push({ file, message, ruleId });
}

function result(
  violations: SurfaceContractViolation[],
): SurfaceContractCheckResult {
  return {
    violations: violations.sort((left, right) =>
      `${left.file}:${left.ruleId}:${left.message}`.localeCompare(
        `${right.file}:${right.ruleId}:${right.message}`,
      ),
    ),
  };
}

function normalize(path: string): string {
  return path.replaceAll('\\', '/');
}
