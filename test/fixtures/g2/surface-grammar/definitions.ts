import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const namespace = 'northstar.shell';
const moduleId = `${namespace}:module.workspace`;
const queryId = `${namespace}:query.workspace_get`;
const componentId = 'northstar.shell:component.setup_checklist';
const languageVersion = 'v3';
const archetypes = ['home', 'list', 'record', 'task', 'builder'] as const;
const slotsByArchetype = Object.freeze({
  builder: [
    'modeSwitch',
    'selection',
    'properties',
    'draftBanner',
    'publishDiff',
  ],
  home: ['exceptions', 'setupChecklist'],
  list: ['title', 'savedViews', 'dataGrid', 'bulkActions'],
  record: [
    'breadcrumb',
    'titleStatus',
    'commandBar',
    'keyFacts',
    'sections',
    'childTables',
    'activity',
  ],
  task: ['decision', 'scanInput', 'primaryAction'],
} as const);
type SurfaceArchetype = (typeof archetypes)[number];

export interface SurfaceGrammarFixtureOptions {
  readonly omitSlot?: Readonly<{
    archetype: SurfaceArchetype;
    slot: string;
  }>;
}

export interface FixtureCompiledSurface {
  readonly archetype: string;
  readonly label: string;
  readonly lifecycle: string;
  readonly slots: readonly {
    readonly contentReferenceId: string;
    readonly orderKey: number;
    readonly slot: string;
    readonly slotId: string;
  }[];
  readonly statusRoles: readonly string[];
  readonly surfaceId: string;
}

export const SURFACE_GRAMMAR_FIXTURE_IDS = Object.freeze({
  componentId,
  surfaceIds: Object.freeze(
    Object.fromEntries(
      archetypes.map((archetype) => [
        archetype,
        `${namespace}:surface.grammar_${archetype}`,
      ]),
    ) as Readonly<Record<SurfaceArchetype, string>>,
  ),
});

export function authoredSurfaceGrammarFixture(
  options: SurfaceGrammarFixtureOptions = {},
): Record<string, unknown> {
  const definition = JSON.parse(
    readFileSync(
      resolve(process.cwd(), 'apps/web/release/shell.authored.json'),
      'utf8',
    ),
  ) as {
    surfaces: Array<Record<string, unknown>>;
  } & Record<string, unknown>;
  definition.surfaces = archetypes.map((archetype, index) => {
    const slots = slotsByArchetype[archetype]
      .filter(
        (slot) =>
          options.omitSlot?.archetype !== archetype ||
          options.omitSlot.slot !== slot,
      )
      .map((slot, slotIndex) => ({
        content: reference('opaqueSurfaceContentReference', componentId),
        kind: 'surfaceSlot',
        orderKey: (slotIndex + 1) * 10,
        schemaVersion: languageVersion,
        slot,
        slotId: `${namespace}:slot.grammar_${archetype}_${snakeCase(slot)}`,
      }));
    return {
      archetype,
      dataSource: reference('queryReference', queryId),
      kind: 'surfaceDefinition',
      label: `${archetype.slice(0, 1).toUpperCase()}${archetype.slice(1)}`,
      module: reference('moduleReference', moduleId),
      schemaVersion: languageVersion,
      slots,
      statusRoles:
        archetype === 'builder'
          ? ['success', 'attention', 'blocked', 'inProgress']
          : [['success', 'attention', 'blocked', 'inProgress'][index % 4]],
      surfaceId: SURFACE_GRAMMAR_FIXTURE_IDS.surfaceIds[archetype],
    };
  });
  return definition;
}

function reference(kind: string, targetId: string) {
  return { kind, schemaVersion: languageVersion, targetId };
}

function snakeCase(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}
