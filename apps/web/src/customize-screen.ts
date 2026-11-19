/*
 * The shapes this screen reads from the customization service, declared here:
 * apps/web never imports the provider (surface-data-binding gate); the
 * composition hands in the service, whose results are structurally these.
 */
type PatchBody = Readonly<Record<string, unknown>> & { readonly kind: string };
interface ScreenPatch {
  readonly createdAt: string;
  readonly patch: PatchBody;
  readonly patchId: string;
  readonly state: 'live' | 'approved' | 'drafted' | 'stale';
}
interface CustomizationStatus {
  readonly activeChain: readonly { readonly patch: PatchBody }[];
  readonly patches: readonly ScreenPatch[];
}
interface CustomizationTargets {
  readonly choiceFields: readonly {
    readonly fieldId: string;
    readonly label: string;
    readonly options: readonly string[];
  }[];
  readonly forms?: readonly {
    readonly surfaceId: string;
    readonly label: string;
    readonly fields: readonly {
      readonly fieldId: string;
      readonly label: string;
      readonly upFront: boolean;
    }[];
  }[];
  readonly lists: readonly {
    readonly columns: readonly {
      readonly hidden?: true;
      readonly fieldId: string;
      readonly label: string;
    }[];
    readonly label: string;
    readonly surfaceId: string;
    readonly savedView?: {
      readonly columns: readonly {
        readonly columnId: string;
        readonly label: string;
        readonly title: boolean;
        readonly sortable: boolean;
      }[];
      readonly filters: readonly {
        readonly field: string;
        readonly label: string;
        readonly options: readonly { value: string; label: string }[];
      }[];
    };
  }[];
  readonly recordTypes: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly tenantAuthored: boolean;
  }[];
}
type DraftOutcome =
  | {
      readonly patchId: string;
      readonly renderedDiff: string;
      readonly status: 'drafted';
    }
  | {
      readonly code?: string;
      readonly issues?: readonly string[];
      readonly message: string;
      readonly missingCapability?: string;
      readonly status: 'invalid' | 'refused' | 'rejected' | 'unsupported';
    };
interface ApprovalOutcome {
  readonly renderedDiff: string;
}
interface ActivationOutcome {
  readonly releaseRoot: string;
}

import { SURFACE_CLIENT_SCRIPT } from './surface-client.js';
import { escapeHtml } from './html.js';

/** The page shape the app server writes; the stylesheet is the runtime's own. */
export interface CustomizeScreenResponse {
  readonly html: string;
  readonly statusCode: number;
}
type CustomizeScreenSubmission = Readonly<Record<string, string>>;

/**
 * The Customize screen (CUSTOMIZE slice 3): the same loop as the command line
 * -- describe a change, read its plain diff, Approve,
 * Activate -- and a Roll back button on the live release. It is reached at
 * `/?customize`. Every change is a typed patch built from the form and checked
 * again by the service; the screen holds no state of its own.
 *
 * This is the minimal screen the six-week test needs, not the §8.5 builder
 * archetype (filed).
 */
export interface CustomizeScreenService {
  activate(patchId: string): Promise<ActivationOutcome>;
  approve(patchId: string): Promise<ApprovalOutcome>;
  draft(
    input: unknown,
    channel: 'visualBuilder' | 'conversationalAi',
  ): Promise<DraftOutcome>;
  /** Present once AI drafting is composed: plain English to one typed patch. */
  draftFromRequest?(request: string): Promise<DraftOutcome>;
  rollback(): Promise<ActivationOutcome>;
  status(): Promise<CustomizationStatus>;
  targets(): Promise<CustomizationTargets>;
}

const FIELD_ROWS = 6;
// Each demo service belongs to one tenant/environment in this server.
const activating = new WeakMap<CustomizeScreenService, number>();
let stylesheet = '';
const FIELD_TYPES = [
  ['text', 'Text'],
  ['number', 'Whole number'],
  ['date', 'Date'],
  ['yesNo', 'Yes or no'],
  ['choice', 'Choice'],
] as const;

export async function renderCustomizeScreen(
  service: CustomizeScreenService,
  requestUrl: string,
  submission: CustomizeScreenSubmission | null,
  /** The runtime stylesheet's route, handed in by the app server. */
  stylesheetHref = '',
): Promise<CustomizeScreenResponse> {
  stylesheet = stylesheetHref
    ? `<link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">`
    : '';
  const url = new URL(requestUrl, 'http://surface-runtime.local');
  try {
    if (!submission) {
      if (activating.has(service))
        return page(
          'Activating',
          '<h1>Activating your change</h1><p role="status">Activation is still running. This takes about a minute.</p><a href="/?customize">Check progress</a>',
        );
      const arrange = url.searchParams.get('arrange');
      if (arrange)
        return page('Arrange a list', await arrangeForm(service, arrange));
      const saveView = url.searchParams.get('saveView');
      if (saveView)
        return page('Save a list view', await savedViewForm(service, saveView));
      return page('Customize', await overview(service));
    }
    switch (submission.action) {
      case 'draft':
        return drafted(
          await service.draft(patchFromForm(submission), 'visualBuilder'),
        );
      case 'ask':
        if (!service.draftFromRequest) {
          return failure('Asking in plain English is not set up here.');
        }
        return drafted(
          await service.draftFromRequest(String(submission.request ?? '')),
        );
      case 'approve': {
        const approved = await service.approve(String(submission.patchId));
        return page(
          'Approved',
          `<p class="eyebrow">Approved — not live yet</p><h1>Approved</h1>${diffBlock(approved.renderedDiff)}${button('activate', 'Activate now', { patchId: String(submission.patchId) })}${backLink()}`,
        );
      }
      case 'activate': {
        activating.set(service, (activating.get(service) ?? 0) + 1);
        try {
          await service.activate(String(submission.patchId));
        } finally {
          const remaining = activating.get(service)! - 1;
          if (remaining) activating.set(service, remaining);
          else activating.delete(service);
        }
        return page(
          'Live',
          `<p class="eyebrow">Live</p><h1>The change is live</h1><p>Every page shows it from now on. No restart was needed.</p>${await liveLinks(service)}${backLink()}`,
          'data-customize-result="activated"',
        );
      }
      case 'rollback':
        await service.rollback();
        return page(
          'Rolled back',
          `<p class="eyebrow">Rolled back</p><h1>The change is rolled back</h1><p>It is hidden again. Every record entered under it is kept and comes back if it is activated again.</p>${backLink()}`,
          'data-customize-result="rolledBack"',
        );
      default:
        return failure('That is not something this screen can do.');
    }
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code: unknown }).code)
        : null;
    return failure(
      error instanceof Error ? error.message : String(error),
      code,
    );
  }
}

async function overview(service: CustomizeScreenService): Promise<string> {
  const [status, targets] = await Promise.all([
    service.status(),
    service.targets(),
  ]);
  const live = status.activeChain.at(-1);
  const rows = status.patches
    .slice()
    .reverse()
    .map((patch) => {
      const action =
        patch.state === 'drafted'
          ? button('approve', 'Approve', { patchId: patch.patchId })
          : patch.state === 'approved'
            ? button('activate', 'Activate', { patchId: patch.patchId })
            : '';
      return `<tr data-patch-id="${escapeHtml(patch.patchId)}" data-patch-state="${patch.state}"><td>${escapeHtml(describe(patch.patch))}</td><td>${stateLabel(patch.state)}</td><td>${escapeHtml(patch.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${action}</td></tr>`;
    })
    .join('');
  return [
    '<p class="eyebrow">Customize</p><h1>Customize this application</h1>',
    `<section data-customize-live><h2>What is live</h2>${
      live
        ? `<p>${String(status.activeChain.length)} change${status.activeChain.length === 1 ? '' : 's'} on top of the standard application. Latest: ${escapeHtml(describe(live.patch))}.</p>${button('rollback', 'Roll back the latest change', {})}`
        : '<p>The standard application, with no customizations.</p>'
    }</section>`,
    `<section data-customize-changes><h2>Changes</h2>${
      rows
        ? `<table><thead><tr><th>Change</th><th>State</th><th>Drafted</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : '<p>No changes yet.</p>'
    }</section>`,
    '<h2>Describe a change</h2>',
    askForm(service),
    recordTypeForm(),
    fieldForm(targets),
    choiceForm(targets),
    arrangePicker(targets),
    savedViewPicker(targets),
    ...(targets.forms ?? []).map(
      (form) =>
        `<form method="post"><fieldset><legend>Show fields up front on ${escapeHtml(form.label)}</legend><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="arrangeLayout"><input type="hidden" name="surface" value="${escapeHtml(form.surfaceId)}"><input type="hidden" name="formLayout" value="1">${form.fields.map((f) => `<label><input type="checkbox" name="front:${escapeHtml(f.fieldId)}"${f.upFront ? ' checked' : ''}> ${escapeHtml(f.label)}</label>`).join(' ')}<button>Draft form arrangement</button></fieldset></form>`,
    ),
  ].join('');
}

function askForm(service: CustomizeScreenService): string {
  if (!service.draftFromRequest) return '';
  return `<form method="post" data-customize-form="ask"><fieldset><legend>Ask in plain English</legend><label>What should change?<br><textarea name="request" rows="3" cols="60" required placeholder="Add an Equipment record with name, serial number, purchase date and a status"></textarea></label><input type="hidden" name="action" value="ask"><p><button type="submit">Draft it</button></p></fieldset></form>`;
}

function recordTypeForm(): string {
  const rows = Array.from({ length: FIELD_ROWS }, (_, index) => {
    const n = String(index + 1);
    return `<tr><td><input name="field_${n}_label" aria-label="Field ${n} name"${index === 0 ? ' required value="Name"' : ''}></td><td>${typeSelect(`field_${n}_type`, `Field ${n} type`, index === 0)}</td><td><input type="checkbox" name="field_${n}_required" aria-label="Field ${n} required"${index === 0 ? ' checked disabled' : ''}></td><td><input name="field_${n}_options" aria-label="Field ${n} choices" placeholder="for a choice: In service, Retired"></td></tr>`;
  }).join('');
  return `<form method="post" data-customize-form="addRecordType"><fieldset><legend>A new record type</legend><label>Name of the record type <input name="label" required placeholder="Equipment"></label><table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Choices</th></tr></thead><tbody>${rows}</tbody></table><p>The first field names each record. Leave unused rows empty.</p><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addRecordType"><p><button type="submit">Draft this record type</button></p></fieldset></form>`;
}

function fieldForm(targets: CustomizationTargets): string {
  const options = targets.recordTypes
    .map(
      (entity) =>
        `<option value="${escapeHtml(entity.entityId)}">${escapeHtml(entity.label)}</option>`,
    )
    .join('');
  return `<form method="post" data-customize-form="addField"><fieldset><legend>A new field</legend><label>On <select name="entity" required>${options}</select></label> <label>Field name <input name="field_1_label" required></label> <label>Type ${typeSelect('field_1_type', 'Field type', false)}</label> <label>Choices <input name="field_1_options" placeholder="for a choice: Yes, No"></label> <label><input type="checkbox" name="field_1_required"> Required (record types added here only)</label><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addField"><p><button type="submit">Draft this field</button></p></fieldset></form>`;
}

function choiceForm(targets: CustomizationTargets): string {
  if (targets.choiceFields.length === 0) {
    return '<fieldset><legend>A new choice</legend><p>Choices can be added to choice fields a customization created; there are none yet.</p></fieldset>';
  }
  const options = targets.choiceFields
    .map(
      (field) =>
        `<option value="${escapeHtml(field.fieldId)}">${escapeHtml(field.label)} (${escapeHtml(field.options.join(', '))})</option>`,
    )
    .join('');
  return `<form method="post" data-customize-form="addChoice"><fieldset><legend>A new choice</legend><label>For <select name="enumField" required>${options}</select></label> <label>Choice <input name="option" required></label><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addChoice"><p><button type="submit">Draft this choice</button></p></fieldset></form>`;
}

function arrangePicker(targets: CustomizationTargets): string {
  const options = targets.lists
    .map(
      (list) =>
        `<option value="${escapeHtml(list.surfaceId)}">${escapeHtml(list.label)}</option>`,
    )
    .join('');
  return `<form method="get" data-customize-form="arrangeLayout"><fieldset><legend>Arrange a list</legend><input type="hidden" name="customize" value=""><label>List <select name="arrange" required>${options}</select></label><p><button type="submit">Choose columns</button></p></fieldset></form>`;
}

async function arrangeForm(
  service: CustomizeScreenService,
  surfaceId: string,
): Promise<string> {
  const list = (await service.targets()).lists.find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  if (!list) {
    return `<h1>Arrange a list</h1><p>That list cannot be arranged.</p>${backLink()}`;
  }
  const rows = list.columns
    .map((column, index) => {
      const n = String(index + 1);
      return `<tr><td><input type="hidden" name="column_${n}_field" value="${escapeHtml(column.fieldId)}">${column.hidden ? `<input type="hidden" name="column_${n}_available" value="1">` : ''}<input type="number" min="1" max="${String(list.columns.length)}" name="column_${n}_position" value="${n}" aria-label="Position of ${escapeHtml(column.label)}"></td><td><input name="column_${n}_label" value="${escapeHtml(column.label)}" aria-label="Heading for ${escapeHtml(column.label)}"></td><td><input type="checkbox" name="column_${n}_hide"${column.hidden ? ' checked' : ''} aria-label="Hide ${escapeHtml(column.label)}"></td></tr>`;
    })
    .join('');
  return `<p class="eyebrow">Customize</p><h1>Arrange ${escapeHtml(list.label)}</h1><form method="post" data-customize-form="arrangeColumns"><table><thead><tr><th>Position</th><th>Heading</th><th>Hide</th></tr></thead><tbody>${rows}</tbody></table><input type="hidden" name="surface" value="${escapeHtml(list.surfaceId)}"><input type="hidden" name="columns" value="${String(list.columns.length)}"><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="arrangeLayout"><p><button type="submit">Draft this arrangement</button></p></form>${backLink()}`;
}

function savedViewPicker(targets: CustomizationTargets): string {
  const options = targets.lists
    .filter((list) => list.savedView)
    .map(
      (list) =>
        `<option value="${escapeHtml(list.surfaceId)}">${escapeHtml(list.label)}</option>`,
    )
    .join('');
  return options
    ? `<form method="get" data-customize-form="saveListView"><fieldset><legend>Save a list view</legend><input type="hidden" name="customize" value=""><label>List <select name="saveView" required>${options}</select></label><p><button>Set up view</button></p></fieldset></form>`
    : '';
}

async function savedViewForm(
  service: CustomizeScreenService,
  surfaceId: string,
): Promise<string> {
  const list = (await service.targets()).lists.find(
    (candidate) => candidate.surfaceId === surfaceId,
  );
  const view = list?.savedView;
  if (!view)
    return `<h1>Save a list view</h1><p>Choose a list that can take another view.</p>${backLink()}`;
  const rows = view.columns
    .map((column, index) => {
      const n = index + 1;
      const heading = escapeHtml(column.label);
      return `<tr><th scope="row">${heading}</th><td><input type="hidden" name="view_column_${n}" value="${escapeHtml(column.columnId)}"><input type="number" name="view_position_${n}" min="1" max="${view.columns.length}" value="${n}" aria-label="Position of ${heading}"></td><td><input type="checkbox" name="view_hide_${n}" aria-label="Hide ${heading}"${column.title ? ' disabled' : ''}></td></tr>`;
    })
    .join('');
  const sortable = view.columns
    .filter((column) => column.sortable)
    .map(
      (column) =>
        `<option value="${escapeHtml(column.columnId)}">${escapeHtml(column.label)}</option>`,
    )
    .join('');
  const sorts = sortable
    ? `<fieldset><legend>Sort</legend>${Array.from(
        { length: 3 },
        (_, index) => {
          const n = index + 1;
          const label = index === 0 ? 'Sort by' : `Then by (${n})`;
          return `<p><label>${label} <select name="view_sort_${n}"><option value="">No column</option>${sortable}</select></label> <label>Order <select name="view_sort_direction_${n}"><option value="ascending">Ascending</option><option value="descending">Descending</option></select></label></p>`;
        },
      ).join('')}</fieldset>`
    : '';
  const filters = view.filters
    .map(
      (filter) =>
        `<label>${escapeHtml(filter.label)} <select name="view_filter:${escapeHtml(filter.field)}"><option value="">All</option>${filter.options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select></label>`,
    )
    .join(' ');
  return `<h1>Save a view for ${escapeHtml(list.label)}</h1><form method="post" data-customize-form="savedView"><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="saveListView"><input type="hidden" name="surface" value="${escapeHtml(surfaceId)}"><label>View name <input name="label" required maxlength="80"></label><fieldset><legend>Columns</legend><table><thead><tr><th>Heading</th><th>Position</th><th>Hide</th></tr></thead><tbody>${rows}</tbody></table></fieldset>${sorts}${filters ? `<fieldset><legend>Filters</legend>${filters}</fieldset>` : ''}<p><button>Draft view</button></p></form>${backLink()}`;
}

/** The typed patch a form describes; the service validates it. */
export function patchFromForm(form: CustomizeScreenSubmission): unknown {
  const field = (n: number) => {
    const label = String(form[`field_${String(n)}_label`] ?? '').trim();
    if (!label) return null;
    const type = String(form[`field_${String(n)}_type`] ?? 'text');
    const options = String(form[`field_${String(n)}_options`] ?? '')
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean);
    return {
      label,
      type,
      ...(form[`field_${String(n)}_required`] === 'on'
        ? { required: true }
        : {}),
      ...(type === 'choice' ? { options } : {}),
    };
  };
  switch (form.kind) {
    case 'addRecordType':
      return {
        fields: Array.from({ length: FIELD_ROWS }, (_, index) =>
          field(index + 1),
        ).filter((entry) => entry !== null),
        kind: 'addRecordType',
        label: String(form.label ?? '').trim(),
      };
    case 'addField':
      return { entity: form.entity, field: field(1), kind: 'addField' };
    case 'addChoice':
      return {
        enumField: form.enumField,
        kind: 'addChoice',
        option: String(form.option ?? '').trim(),
      };
    case 'saveListView':
      return {
        kind: 'saveListView',
        surface: form.surface,
        label: form.label,
        columns: Array.from({ length: 16 }, (_, index) => index + 1)
          .filter(
            (n) => form[`view_column_${n}`] && form[`view_hide_${n}`] !== 'on',
          )
          .sort(
            (left, right) =>
              Number(form[`view_position_${left}`]) -
              Number(form[`view_position_${right}`]),
          )
          .map((n) => form[`view_column_${n}`]),
        sort: [1, 2, 3].flatMap((n) =>
          form[`view_sort_${n}`]
            ? [
                {
                  column: form[`view_sort_${n}`],
                  direction: form[`view_sort_direction_${n}`],
                },
              ]
            : [],
        ),
        filters: Object.entries(form).flatMap(([key, value]) =>
          key.startsWith('view_filter:') && value
            ? [{ field: key.slice('view_filter:'.length), value }]
            : [],
        ),
      };
    case 'arrangeLayout': {
      if (form.formLayout)
        return {
          kind: 'arrangeLayout',
          surface: form.surface,
          upFront: Object.keys(form)
            .filter((name) => name.startsWith('front:') && form[name] === 'on')
            .map((name) => name.slice(6)),
        };
      const count = Number(form.columns ?? 0);
      const columns = Array.from({ length: count }, (_, index) => {
        const n = String(index + 1);
        return {
          field: String(form[`column_${n}_field`] ?? ''),
          hidden: form[`column_${n}_hide`] === 'on',
          available: form[`column_${n}_available`] === '1',
          label: String(form[`column_${n}_label`] ?? '').trim(),
          position: Number(form[`column_${n}_position`] ?? index + 1),
          index,
        };
      }).filter((column) => !(column.available && column.hidden));
      const ordered = columns
        .slice()
        .sort(
          (left, right) =>
            left.position - right.position || left.index - right.index,
        );
      return {
        hide: columns
          .filter((column) => column.hidden)
          .map((column) => column.field),
        kind: 'arrangeLayout',
        order: ordered
          .filter((column) => !column.hidden)
          .map((column) => column.field),
        relabel: columns
          .filter((column) => !column.hidden && column.label !== '')
          .map((column) => ({ field: column.field, label: column.label })),
        surface: form.surface,
      };
    }
    default:
      return { kind: String(form.kind ?? '') };
  }
}

function drafted(outcome: DraftOutcome): CustomizeScreenResponse {
  if (outcome.status !== 'drafted') {
    return page(
      'Not drafted',
      `<p class="eyebrow">${outcome.status === 'unsupported' ? 'Not supported yet' : 'Not drafted'}</p><h1>${outcome.status === 'unsupported' ? 'This change is not supported yet' : 'This change cannot be drafted'}</h1><p data-customize-refusal="${escapeHtml(outcome.code ?? outcome.missingCapability ?? outcome.status)}">${escapeHtml(outcome.message)}</p>${
        outcome.issues && outcome.issues.length > 0
          ? `<ul>${outcome.issues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join('')}</ul>`
          : ''
      }<p>Nothing was recorded.</p>${backLink()}`,
      'data-customize-result="refused"',
      422,
    );
  }
  return page(
    'Review the change',
    `<p class="eyebrow">Drafted — nothing is live yet</p><h1>Review the change</h1>${diffBlock(outcome.renderedDiff)}${button('approve', 'Approve', { patchId: outcome.patchId })}${backLink()}`,
    `data-customize-result="drafted" data-patch-id="${escapeHtml(outcome.patchId)}"`,
  );
}

async function liveLinks(service: CustomizeScreenService): Promise<string> {
  const lists = (await service.targets()).lists.filter((list) =>
    list.surfaceId.includes('.custom_'),
  );
  return lists.length === 0
    ? ''
    : `<p>${lists
        .map(
          (list) =>
            `<a href="/?surface=${encodeURIComponent(list.surfaceId)}">Open ${escapeHtml(list.label)}</a>`,
        )
        .join(' · ')}</p>`;
}

function describe(patch: Record<string, unknown>): string {
  switch (patch.kind) {
    case 'addRecordType':
      return `New record type "${String(patch.label)}"`;
    case 'addField':
      return `New field "${String((patch.field as Record<string, unknown>).label)}"`;
    case 'addChoice':
      return `New choice "${String(patch.option)}"`;
    case 'arrangeLayout':
      return patch.upFront ? 'Arranged form fields' : 'Arranged list columns';
    case 'saveListView':
      return `Saved list view "${String(patch.label)}"`;
    default:
      return String(patch.kind);
  }
}

function stateLabel(state: string): string {
  return (
    {
      approved: 'Approved — ready to activate',
      drafted: 'Drafted — needs approval',
      live: 'Live',
      stale: 'Out of date — draft it again',
    }[state] ?? state
  );
}

function diffBlock(text: string): string {
  return `<section data-customize-diff><h2>What this change does</h2><pre>${escapeHtml(text)}</pre></section>`;
}

function button(
  action: string,
  label: string,
  fields: Readonly<Record<string, string>>,
): string {
  const progress =
    action === 'approve'
      ? 'Building and verifying your change… this takes about a minute.'
      : action === 'activate'
        ? 'Activating your change… this takes about a minute.'
        : '';
  return `<form method="post" data-customize-action="${action}">${Object.entries(
    fields,
  )
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
    )
    .join(
      '',
    )}<input type="hidden" name="action" value="${action}"><button type="submit">${escapeHtml(label)}</button>${progress ? `<p role="status" hidden>${progress}</p>` : ''}</form>`;
}

function typeSelect(name: string, label: string, textOnly: boolean): string {
  return `<select name="${name}" aria-label="${escapeHtml(label)}">${FIELD_TYPES.filter(
    ([value]) => !textOnly || value === 'text',
  )
    .map(([value, text]) => `<option value="${value}">${text}</option>`)
    .join('')}</select>`;
}

function backLink(): string {
  return '<p><a href="/?customize">Back to Customize</a> · <a href="/">Back to the application</a></p>';
}

function failure(
  message: string,
  code: string | null = null,
): CustomizeScreenResponse {
  return page(
    'Customize',
    `<p class="eyebrow">Customize</p><h1>That did not work</h1><p data-customize-refusal="${escapeHtml(code ?? 'ERROR')}">${escapeHtml(message)}</p>${backLink()}`,
    'data-customize-result="refused"',
    409,
  );
}

function page(
  title: string,
  body: string,
  attributes = '',
  statusCode = 200,
): CustomizeScreenResponse {
  return Object.freeze({
    html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · 2rain</title>${stylesheet}</head><body class="standalone"><main class="standalone__card" data-customize-screen ${attributes}>${body}</main>${body.includes('role="status" hidden') ? `<script>${SURFACE_CLIENT_SCRIPT}</script>` : ''}</body></html>`,
    statusCode,
  });
}
