import {
  popupCommand,
  popupOptionId,
} from '../../../packages/customization/src/popup-revision.js';
import type { PopupOption } from '../../../packages/canonical-model/src/popup-actions.js';
import { layoutDigest } from '@north-star/canonical-model';
import {
  layoutCommand,
  arrangeableLayoutFields,
  type LayoutTarget,
  recordTypeEntityId,
} from '@north-star/customization';
import { slug } from '../../../packages/customization/src/apply.js';

/*
 * The shapes this screen reads from the customization service, declared here:
 * apps/web never imports the provider (surface-data-binding gate); the
 * composition hands in the service, whose results are structurally these.
 */
import {
  fieldComparisonValidationDraft,
  literalValidationDraft,
  VALIDATION_COMPARISONS,
  type LiteralValidationTarget,
} from '../../../packages/customization/src/validation-draft.js';

import {
  calculatedDisplayDraft,
  DISPLAY_OPERATIONS,
  type CalculatedDisplayTarget,
} from '../../../packages/customization/src/calculated-display-draft.js';

interface PatchSummary {
  readonly kind: string;
  readonly displayLabel: string | null;
  readonly patchId: string;
}
interface ScreenPatch extends PatchSummary {
  readonly createdAt: string;
  readonly state: 'live' | 'approved' | 'drafted' | 'stale';
}
interface CustomizationStatus {
  readonly failedActivation?: {
    readonly attemptId: string;
    readonly fence: string;
  };
  readonly activeFence: number;
  readonly historyUnavailable?: true;
  readonly rollbackAvailable: boolean;
  readonly activeChain: readonly PatchSummary[];
  readonly activeReleaseId: string;
  readonly upgradeRefusal: {
    readonly code: string;
    readonly message: string;
    readonly issues?: readonly string[];
  } | null;
  readonly upgrades: readonly {
    readonly candidateReleaseId: string;
    readonly upgradeId: string;
    readonly state: string;
  }[];
  readonly patches: readonly ScreenPatch[];
}
interface CustomizationTargets {
  readonly popupActions?: readonly PopupOption[];
  readonly layouts?: readonly LayoutTarget[];
  readonly documentTargets?: readonly {
    readonly entityId: string;
    readonly label: string;
  }[];
  readonly calculatedDisplayTargets?: readonly CalculatedDisplayTarget[];
  readonly validationTargets?: readonly LiteralValidationTarget[];
  readonly linkTargets?: readonly {
    readonly entityId: string;
    readonly label: string;
    readonly companyOwned: boolean;
  }[];
  readonly permissionRoleKeys?: readonly string[];
  readonly permissionRoleLabels?: Readonly<Record<string, string>>;
  readonly permissionRestrictions?: readonly {
    operationId: string;
    roleKey: string;
  }[];
  readonly permissionActions?: readonly {
    readonly id: string;
    readonly label: string;
  }[];
  readonly metricLists?: readonly {
    readonly surfaceId: string;
    readonly label: string;
    readonly views: readonly {
      readonly viewId: string;
      readonly label: string;
    }[];
    readonly measures: readonly {
      readonly fieldId: string;
      readonly label: string;
    }[];
  }[];
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

interface LiveWorkflow {
  readonly workflowId: string;
  readonly trigger: string;
  readonly body: string;
  readonly grants: {
    readonly queries: readonly string[];
    readonly operations: readonly string[];
  };
}

import type { TrustedRequestContext } from '@north-star/runtime';

import { SURFACE_CLIENT_SCRIPT } from './surface-client.js';
import { escapeHtml } from './html.js';

/** The page shape the app server writes; the stylesheet is the runtime's own. */
export interface CustomizeScreenResponse {
  readonly html: string;
  readonly statusCode: number;
}
type CustomizeScreenSubmission = Readonly<Record<string, string>>;
type LoadTargets = () => Promise<CustomizationTargets>;

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
    signal?: AbortSignal,
    actor?: TrustedRequestContext,
  ): Promise<DraftOutcome>;
  /** Present once AI drafting is composed: plain English to one typed patch. */
  draftFromRequest?(
    request: string,
    signal?: AbortSignal,
    actor?: TrustedRequestContext,
  ): Promise<DraftOutcome>;
  recover(
    mode: 'reverify' | 'revert',
    expected: { attemptId: string; fence: string },
  ): Promise<ActivationOutcome>;
  rollback(
    expectedReleaseId: string,
    expectedFence: string,
  ): Promise<ActivationOutcome>;
  status(): Promise<CustomizationStatus>;
  targets(actor?: TrustedRequestContext): Promise<CustomizationTargets>;
  workflows?(actor?: TrustedRequestContext): Promise<readonly LiveWorkflow[]>;
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
  actor?: TrustedRequestContext,
): Promise<CustomizeScreenResponse> {
  stylesheet = stylesheetHref
    ? `<link rel="stylesheet" href="${escapeHtml(stylesheetHref)}">`
    : '';
  const url = new URL(requestUrl, 'http://surface-runtime.local');
  const loadTargets = () => service.targets(actor);
  try {
    if (!submission) {
      if (activating.has(service))
        return page(
          'Activating',
          '<h1>Activating your change</h1><p role="status">Activation is still running. This takes about a minute.</p><a href="/?customize">Check progress</a>',
        );
      const popup = url.searchParams.get('popup');
      if (popup)
        return page(
          'Customize a record button',
          popupEditor(
            (await loadTargets()).popupActions ?? [],
            popup,
            url.searchParams.get('button'),
          ),
        );
      const layout = url.searchParams.get('layout');
      if (layout) {
        const target = (await loadTargets()).layouts?.find(
          (t) => t.body.surfaceId + '/' + t.body.mode === layout,
        );
        return target
          ? page('Arrange page', layoutEditor(target) + backLink())
          : failure('Choose an available page.');
      }
      const arrange = url.searchParams.get('arrange');
      if (arrange)
        return page('Arrange a list', await arrangeForm(loadTargets, arrange));
      const saveView = url.searchParams.get('saveView');
      if (saveView)
        return page(
          'Save a list view',
          await savedViewForm(loadTargets, saveView),
        );
      const metric = url.searchParams.get('metric');
      if (metric)
        return page('Add a metric card', await metricForm(loadTargets, metric));
      const display = url.searchParams.get('calculatedDisplay');
      if (display)
        return page(
          'Add a calculated display field',
          calculatedDisplayForm(await loadTargets(), display),
        );
      const validation = url.searchParams.get('validation');
      if (validation)
        return page(
          'Add validation',
          validationForm(await loadTargets(), validation),
        );
      return page('Customize', await overview(service, loadTargets, actor));
    }
    switch (submission.action) {
      case 'draft':
        return drafted(
          await service.draft(
            submission.kind === 'addPopupActionRevision'
              ? popupSubmission(
                  (await loadTargets()).popupActions ?? [],
                  submission,
                )
              : submission.kind === 'addLayoutRevision'
                ? layoutSubmission(
                    (await loadTargets()).layouts ?? [],
                    submission,
                  )
                : patchFromForm(
                    submission,
                    submission.kind === 'addValidation'
                      ? (await loadTargets()).validationTargets?.find(
                          ({ entityId }) => entityId === submission.entity,
                        )
                      : undefined,
                    submission.kind === 'addCalculatedDisplayField'
                      ? (await loadTargets()).calculatedDisplayTargets?.find(
                          ({ recordSurfaceId }) =>
                            recordSurfaceId === submission.surface,
                        )
                      : undefined,
                  ),
            'visualBuilder',
            undefined,
            actor,
          ),
        );
      case 'ask':
        if (!service.draftFromRequest) {
          return failure('Asking in plain English is not set up here.');
        }
        return drafted(
          await service.draftFromRequest(
            String(submission.request ?? ''),
            undefined,
            actor,
          ),
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
          `<p class="eyebrow">Live</p><h1>The change is live</h1><p>Every page shows it from now on. No restart was needed.</p>${await liveLinks(loadTargets)}${backLink()}`,
          'data-customize-result="activated"',
        );
      }
      case 'reverify':
      case 'revert':
        if (!submission.attemptId || !submission.fence)
          return failure(
            'Open Customize again to review the failed activation.',
          );
        await service.recover(submission.action, {
          attemptId: submission.attemptId,
          fence: submission.fence,
        });
        return page(
          'Activation recovered',
          `<h1>${submission.action === 'revert' ? 'Previous release restored and verified' : 'Activation verified'}</h1><p>Inventory posting can resume.</p>${backLink()}`,
        );
      case 'rollback':
        if (!submission.releaseId || !submission.fence)
          return failure(
            'Open Customize again to review the live release before rolling back.',
          );
        await service.rollback(submission.releaseId, submission.fence);
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

async function overview(
  service: CustomizeScreenService,
  loadTargets: LoadTargets,
  actor?: TrustedRequestContext,
): Promise<string> {
  const status = await service.status();
  if (status.failedActivation)
    return [
      '<h1>Activation verification failed</h1><p>The previous verified release is still live. Inventory posting can resume once recovery succeeds.</p>',
      button('reverify', 'Retry verification', status.failedActivation),
      button(
        'revert',
        'Restore the previous verified release',
        status.failedActivation,
      ),
    ].join('');
  const targets = await loadTargets();
  const workflows = (await service.workflows?.(actor)) ?? [];
  const latest = status.activeChain.at(-1);
  const activeUpgrade = status.upgrades.find(
    (u) =>
      u.state === 'live' && u.candidateReleaseId === status.activeReleaseId,
  );
  const live = activeUpgrade
    ? `Platform upgrade ${activeUpgrade.upgradeId}`
    : latest
      ? describe(latest)
      : null;
  const refusal = status.upgradeRefusal;
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
      return `<tr data-patch-id="${escapeHtml(patch.patchId)}" data-patch-state="${patch.state}"><td>${escapeHtml(describe(patch))}</td><td>${stateLabel(patch.state)}</td><td>${escapeHtml(patch.createdAt.slice(0, 16).replace('T', ' '))}</td><td>${action}</td></tr>`;
    })
    .join('');
  return [
    '<p class="eyebrow">Customize</p><h1>Customize this application</h1>',
    `<section data-customize-live><h2>What is live</h2>${
      live
        ? `<p>${String(status.activeChain.length)} change${status.activeChain.length === 1 ? '' : 's'} on top of the standard application. Latest: ${escapeHtml(live)}.</p>`
        : status.historyUnavailable
          ? '<p>The verified release is live. Its customization history is unavailable.</p>'
          : '<p>The standard application, with no customizations.</p>'
    }${status.rollbackAvailable ? button('rollback', 'Roll back the latest change', { releaseId: status.activeReleaseId, fence: String(status.activeFence) }) : ''}</section>`,
    workflows.length
      ? `<section data-customize-workflows><h2>Live workflows</h2>${workflows.map(renderLiveWorkflow).join('')}</section>`
      : '',
    refusal
      ? `<section data-customize-upgrade-refusal><h2>Platform upgrade refused</h2><p>Your current release is still live.</p><p>${escapeHtml(refusal.code)} · ${escapeHtml(refusal.message)}</p>${(refusal.issues ?? []).map((issue) => `<pre>${escapeHtml(issue)}</pre>`).join('')}</section>`
      : '',
    `<section data-customize-changes><h2>Changes</h2>${
      rows
        ? `<table><thead><tr><th>Change</th><th>State</th><th>Drafted</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
        : status.historyUnavailable
          ? '<p>Recorded changes are unavailable.</p>'
          : '<p>No changes yet.</p>'
    }</section>`,
    '<h2>Describe a change</h2>',
    askForm(service),
    recordTypeForm(targets),
    extendRecordTypeForm(targets),
    fieldForm(targets),
    documentFieldForm(targets),
    choiceForm(targets),
    popupPicker(targets.popupActions ?? []),
    layoutPicker(targets.layouts ?? []),
    arrangePicker(targets),
    savedViewPicker(targets),
    metricPicker(targets),
    permissionForm(targets),
    validationSelector(targets),
    calculatedDisplaySelector(targets),
    ...(targets.forms ?? []).map(
      (form) =>
        `<form method="post"><fieldset><legend>Show fields up front on ${escapeHtml(form.label)}</legend><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="arrangeLayout"><input type="hidden" name="surface" value="${escapeHtml(form.surfaceId)}"><input type="hidden" name="formLayout" value="1">${form.fields.map((f) => `<label><input type="checkbox" name="front:${escapeHtml(f.fieldId)}"${f.upFront ? ' checked' : ''}> ${escapeHtml(f.label)}</label>`).join(' ')}<button>Draft form arrangement</button></fieldset></form>`,
    ),
  ].join('');
}

function renderLiveWorkflow(workflow: LiveWorkflow): string {
  const { trigger } = workflow;
  const { operations, queries } = workflow.grants;
  const describe = (id: string) =>
    id.slice(id.lastIndexOf('.') + 1).replaceAll('_', ' ');
  const actions = [
    ...operations.map((id) => `use the ${describe(id)} action`),
    ...queries.map((id) => `read ${describe(id)}`),
  ];
  const summary = actions.length
    ? `When ${trigger.toLowerCase()}, this workflow may ${new Intl.ListFormat('en').format(actions)}.`
    : `This workflow starts when ${trigger.toLowerCase()}.`;
  const grant = (label: string, ids: readonly string[]) =>
    `<dt>${label}</dt><dd>${ids.length ? ids.map((id) => `<code>${escapeHtml(id)}</code>`).join('<br>') : 'None'}</dd>`;
  return `<article><h3>${escapeHtml(describe(workflow.workflowId))}</h3><p>${escapeHtml(summary)}</p>
    <dl><dt>Trigger</dt><dd>${escapeHtml(trigger)}</dd>
    ${grant('Query grants', queries)}${grant('Operation grants', operations)}</dl>
    <details><summary>View code</summary><pre class="workflow-plan-input"><code>${escapeHtml(workflow.body)}</code></pre></details>
  </article>`;
}

function askForm(service: CustomizeScreenService): string {
  if (!service.draftFromRequest) return '';
  return `<form method="post" data-customize-form="ask"><fieldset><legend>Ask in plain English</legend><label>What should change?<br><textarea name="request" rows="3" cols="60" required placeholder="Add an Equipment record with name, serial number, purchase date and a status"></textarea></label><input type="hidden" name="action" value="ask"><p><button type="submit">Draft it</button></p></fieldset></form>`;
}

function fieldRows(prefix = 'field', firstNamesRecord = false): string {
  const rows = Array.from({ length: FIELD_ROWS }, (_, index) => {
    const n = String(index + 1);
    const first = firstNamesRecord && index === 0;
    return `<tr><td><input name="${prefix}_${n}_label" aria-label="Field ${n} name"${first ? ' required value="Name"' : ''}></td><td>${typeSelect(`${prefix}_${n}_type`, `Field ${n} type`, first)}</td><td><input type="checkbox" name="${prefix}_${n}_required" aria-label="Field ${n} required"${first ? ' checked disabled' : ''}></td><td><input name="${prefix}_${n}_options" aria-label="Field ${n} choices" placeholder="For a choice, enter comma-separated options"></td></tr>`;
  }).join('');
  return `<table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Choices</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function recordTypeForm(targets: CustomizationTargets): string {
  return `<form method="post" data-customize-form="addRecordType"><fieldset><legend>A new record type</legend><label>Name of the record type <input name="label" required placeholder="Equipment"></label><label>Ownership <select name="companyOwnership"><option value="">Shared across companies</option><option value="entityOwned">Each record belongs to one company</option></select></label>${fieldRows('field', true)}<p>The first field names each record. Leave unused rows empty.</p>${recordTypeDetails(targets.linkTargets ?? [])}<input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addRecordType"><p><button type="submit">Draft this record type</button></p></fieldset></form>`;
}

function extendRecordTypeForm(targets: CustomizationTargets): string {
  const options = targets.recordTypes
    .filter((entity) => entity.tenantAuthored)
    .map(
      (entity) =>
        `<option value="${escapeHtml(entity.entityId)}">${escapeHtml(entity.label)}</option>`,
    )
    .join('');
  if (!options) return '';
  return `<form method="post" data-customize-form="extendRecordType"><fieldset><legend>Lines and actions</legend><label>Record type <select name="entity" required>${options}</select></label>${recordTypeDetails()}<input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="extendRecordType"><button>Draft changes</button></fieldset></form>`;
}

function recordTypeDetails(
  linkTargets?: CustomizationTargets['linkTargets'],
): string {
  const linkOptions = (linkTargets ?? [])
    .map(
      (target) =>
        `<option value="${escapeHtml(target.entityId)}">${escapeHtml(target.label)}${target.companyOwned ? ' (company owned)' : ''}</option>`,
    )
    .join('');
  const links = Array.from({ length: 4 }, (_, index) => {
    const n = index + 1;
    return `<div><label>Link ${n} name <input name="link_${n}_label"></label><label>Target <select name="link_${n}_target"><option value="">Choose a record type</option>${linkOptions}</select></label></div>`;
  }).join('');
  const states = Array.from({ length: 8 }, (_, index) => {
    const n = index + 1;
    return `<div><label>State ${n} name <input name="state_${n}_label"></label><label>Meaning <select name="state_${n}_role"><option value="">Neutral</option><option value="inProgress">In progress</option><option value="success">Success</option><option value="attention">Needs attention</option><option value="blocked">Blocked</option></select></label></div>`;
  }).join('');
  const actions = Array.from({ length: 12 }, (_, index) => {
    const n = index + 1;
    return `<div><label>Action ${n} name <input name="transition_${n}_label"></label><label>From <input name="transition_${n}_from"></label><label>To <input name="transition_${n}_to"></label></div>`;
  }).join('');
  return `<details><summary>Line table</summary><label>Table name <input name="lines_label"></label>${fieldRows('line')}</details>${linkTargets?.length ? `<details><summary>Links</summary>${links}</details>` : ''}<details><summary>States and actions</summary><label>Initial state <input name="initial"></label>${states}${actions}</details>`;
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

function documentFieldForm(targets: CustomizationTargets): string {
  if (!targets.documentTargets?.length) return '';
  const options = targets.documentTargets
    .map(
      ({ entityId, label }) =>
        `<option value="${escapeHtml(entityId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  return `<form method="post" data-customize-form="addDocumentField"><fieldset><legend>A new files field</legend><label>On <select name="entity" required>${options}</select></label><label>Field name <input name="label" required maxlength="80"></label><label>Maximum files <input name="maxCount" type="number" min="1" max="20" value="1" required></label><label>Internal categories, separated by commas <input name="categories" maxlength="320"></label><label><input name="required" type="checkbox"> Required to complete a document task</label><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addDocumentField"><p><button>Draft files field</button></p></fieldset></form>`;
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
  loadTargets: LoadTargets,
  surfaceId: string,
): Promise<string> {
  const list = (await loadTargets()).lists.find(
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

function calculatedDisplaySelector(targets: CustomizationTargets): string {
  if (!targets.calculatedDisplayTargets?.length) return '';
  const options = targets.calculatedDisplayTargets
    .map(
      ({ recordSurfaceId, label }) =>
        `<option value="${escapeHtml(recordSurfaceId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  return `<form method="get" data-customize-form="calculatedDisplayPicker"><fieldset><legend>Add a calculated display field</legend><input type="hidden" name="customize" value=""><label for="calculated-record">Record page</label> <select id="calculated-record" name="calculatedDisplay" required>${options}</select><p><button>Set up calculation</button></p></fieldset></form>`;
}

function calculatedDisplayForm(
  targets: CustomizationTargets,
  surface: string,
): string {
  const target = targets.calculatedDisplayTargets?.find(
    ({ recordSurfaceId }) => recordSurfaceId === surface,
  );
  if (!target)
    return `<h1>Choose a record page for this calculation</h1>${backLink()}`;
  const fields = target.fields
    .map(
      ({ fieldId, label }) =>
        `<option value="${escapeHtml(fieldId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  const operations = DISPLAY_OPERATIONS.map(
    ([operator, label]) => `<option value="${operator}">${label}</option>`,
  ).join('');
  const lists = target.lists
    .map(
      ({ surfaceId, label }) =>
        `<option value="${escapeHtml(surfaceId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  return `<h1>Add a calculated display field to ${escapeHtml(target.label)}</h1><form method="post" data-customize-form="calculatedDisplay"><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addCalculatedDisplayField"><input type="hidden" name="surface" value="${escapeHtml(surface)}"><label>Field name <input name="label" required maxlength="80"></label><label for="calculated-first">First field</label> <select id="calculated-first" name="leftFieldId" required>${fields}</select><label for="calculated-operation">Operation</label> <select id="calculated-operation" name="operator" required>${operations}</select><label for="calculated-second">Second field</label> <select id="calculated-second" name="rightFieldId" required>${fields}</select>${lists ? `<label for="calculated-list">Also show on a list</label> <select id="calculated-list" name="listSurfaceId"><option value="">Record page only</option>${lists}</select>` : ''}<p><button>Draft calculation</button></p></form>${backLink()}`;
}

function validationSelector(targets: CustomizationTargets): string {
  if (!targets.validationTargets?.length) return '';
  const options = targets.validationTargets
    .map(
      ({ entityId, label }) =>
        `<option value="${escapeHtml(entityId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  return `<form method="get" data-customize-form="addValidation"><fieldset><legend>Add validation</legend><input type="hidden" name="customize" value=""><label>Record type <select name="validation" required>${options}</select></label><p><button>Set up validation</button></p></fieldset></form>`;
}

function validationForm(
  targets: CustomizationTargets,
  entityId: string,
): string {
  const target = targets.validationTargets?.find(
    (option) => option.entityId === entityId,
  );
  if (!target) return `<h1>Choose a record type</h1>${backLink()}`;
  const fields = target.fields
    .map(
      ({ fieldId, label }) =>
        `<option value="${escapeHtml(fieldId)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  const subject = `<input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addValidation"><input type="hidden" name="entity" value="${escapeHtml(entityId)}">`;
  const literal = `<form method="post">${subject}<label>Field <select name="fieldId" required>${fields}</select></label><label>Rule <select name="check"><option value="required">Require a value</option><option value="minimum">Minimum number</option><option value="maximum">Maximum number</option><option value="maximumLength">Maximum text length</option><option value="notBeforeToday">Today or later</option></select></label><label>Limit for numbers or text length <input name="limit" maxlength="40"></label><label>Message shown when saving <input name="message" maxlength="240" required></label><p><button>Draft validation rule</button></p></form>`;
  const comparisons = VALIDATION_COMPARISONS.map(
    ([operator, label]) => `<option value="${operator}">${label}</option>`,
  ).join('');
  const related = target.relatedFields
    ?.map(
      ({ relationId, fieldId, label }) =>
        `<option value="${escapeHtml(`${relationId}/${fieldId}`)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  const comparison =
    target.fields.length > 1 || related
      ? `<form method="post" data-customize-form="compareValidationFields">${subject}<input type="hidden" name="check" value="compareFields"><fieldset><legend>Compare fields</legend><label>Field to check <select name="fieldId" required>${fields}</select></label><label>Comparison <select name="operator" required>${comparisons}</select></label><label>Other field <select name="otherField" required><option value="">Choose a field</option><optgroup label="This record">${fields}</optgroup>${related ? `<optgroup label="Related record">${related}</optgroup>` : ''}</select></label><label>Message when the comparison fails <input name="message" maxlength="240" required></label><p><button>Draft field comparison</button></p></fieldset></form>`
      : '';
  return `<h1>Add validation for ${escapeHtml(target.label)}</h1>${literal}${comparison}${backLink()}`;
}

function permissionForm(targets: CustomizationTargets): string {
  if (!targets.permissionRoleKeys?.length || !targets.permissionActions?.length)
    return '';
  const labels = targets.permissionRoleLabels;
  const roleLabel = (key: string) =>
    labels && Object.hasOwn(labels, key) ? (labels[key] ?? key) : key;
  const roles = targets.permissionRoleKeys
    .map(
      (role) =>
        `<option value="${escapeHtml(role)}">${escapeHtml(roleLabel(role))}</option>`,
    )
    .join('');
  const actions = targets.permissionActions
    .map(
      ({ id, label }) =>
        `<option value="${escapeHtml(id)}">${escapeHtml(label)}</option>`,
    )
    .join('');
  const existing = (targets.permissionRestrictions ?? [])
    .map(({ operationId, roleKey }) => {
      const action =
        targets.permissionActions?.find(({ id }) => id === operationId)
          ?.label ?? operationId;
      const role = roleLabel(roleKey);
      return `<li>${escapeHtml(action)} for ${escapeHtml(role)} ${button(
        'draft',
        'Draft removal',
        {
          kind: 'unNarrowPermission',
          operation: operationId,
          roleKey,
        },
      )}</li>`;
    })
    .join('');
  return `<form method="post" data-customize-form="narrowPermission"><fieldset><legend>Restrict an action for a role</legend><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="narrowPermission"><label for="restriction-role">Role</label> <select id="restriction-role" name="roleKey" required><option value="">Choose a role</option>${roles}</select><label for="restriction-operation">Action</label> <select id="restriction-operation" name="operation" required><option value="">Choose an action</option>${actions}</select><p>A person can still use the action if one of their other roles grants it.</p><p><button>Draft permission restriction</button></p></fieldset></form>${existing ? `<h3>Current action restrictions</h3><ul>${existing}</ul>` : ''}`;
}

function metricPicker(targets: CustomizationTargets): string {
  if (!targets.metricLists?.length) return '';
  const options = targets.metricLists
    .map(
      (target) =>
        `<option value="${escapeHtml(target.surfaceId)}">${escapeHtml(target.label)}</option>`,
    )
    .join('');
  return `<form method="get" data-customize-form="addMetricCard"><fieldset><legend>Add a metric card to Today</legend><input type="hidden" name="customize" value=""><label for="metric-list">List</label> <select id="metric-list" name="metric" required>${options}</select><p><button>Set up metric</button></p></fieldset></form>`;
}

async function metricForm(
  loadTargets: LoadTargets,
  surfaceId: string,
): Promise<string> {
  const { metricLists } = await loadTargets();
  const target = metricLists?.find((list) => list.surfaceId === surfaceId);
  if (!target)
    return `<p>Choose a list that reads records directly.</p>${backLink()}`;
  const views = target.views
    .map(
      (view) =>
        `<option value="${escapeHtml(view.viewId)}">${escapeHtml(view.label)}</option>`,
    )
    .join('');
  const measures = target.measures
    .map(
      (field) =>
        `<option value="${escapeHtml(field.fieldId)}">Sum of ${escapeHtml(field.label)}</option>`,
    )
    .join('');
  return `<h1>Add a metric for ${escapeHtml(target.label)}</h1><form method="post"><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="addMetricCard"><input type="hidden" name="surface" value="${escapeHtml(surfaceId)}"><label>Card name <input name="label" required maxlength="80"></label><label for="metric-view">View</label> <select id="metric-view" name="view"><option value="">Default view</option>${views}</select><label for="metric-measure">Measure</label> <select id="metric-measure" name="sumField"><option value="">Count records</option>${measures}</select><p><button>Draft metric</button></p></form>${backLink()}`;
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
    ? `<form method="get" data-customize-form="saveListView"><fieldset><legend>Save a list view</legend><input type="hidden" name="customize" value=""><label for="saved-view-list">List</label> <select id="saved-view-list" name="saveView" required>${options}</select><p><button>Set up view</button></p></fieldset></form>`
    : '';
}

async function savedViewForm(
  loadTargets: LoadTargets,
  surfaceId: string,
): Promise<string> {
  const list = (await loadTargets()).lists.find(
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
          return `<p><label for="saved-view-sort-${n}">${label}</label> <select id="saved-view-sort-${n}" name="view_sort_${n}"><option value="">No column</option>${sortable}</select> <label for="saved-view-sort-direction-${n}">Order</label> <select id="saved-view-sort-direction-${n}" name="view_sort_direction_${n}"><option value="ascending">Ascending</option><option value="descending">Descending</option></select></p>`;
        },
      ).join('')}</fieldset>`
    : '';
  const filters = view.filters
    .map(
      (filter, index) =>
        `<label for="saved-view-filter-${index}">${escapeHtml(filter.label)}</label> <select id="saved-view-filter-${index}" name="view_filter:${escapeHtml(filter.field)}"><option value="">All</option>${filter.options.map((option) => `<option value="${escapeHtml(option.value)}">${escapeHtml(option.label)}</option>`).join('')}</select>`,
    )
    .join(' ');
  return `<h1>Save a view for ${escapeHtml(list.label)}</h1><form method="post" data-customize-form="savedView"><input type="hidden" name="action" value="draft"><input type="hidden" name="kind" value="saveListView"><input type="hidden" name="surface" value="${escapeHtml(surfaceId)}"><label>View name <input name="label" required maxlength="80"></label><fieldset><legend>Columns</legend><table><thead><tr><th>Heading</th><th>Position</th><th>Hide</th></tr></thead><tbody>${rows}</tbody></table></fieldset>${sorts}${filters ? `<fieldset><legend>Filters</legend>${filters}</fieldset>` : ''}<p><button>Draft view</button></p></form>${backLink()}`;
}

/** The typed patch a form describes; the service validates it. */
export function patchFromForm(
  form: CustomizeScreenSubmission,
  validationTarget?: LiteralValidationTarget,
  calculatedTarget?: CalculatedDisplayTarget,
): unknown {
  const field = (n: number, prefix = 'field') => {
    const key = `${prefix}_${n}`;
    const label = String(form[`${key}_label`] ?? '').trim();
    if (!label) return null;
    const type = String(form[`${key}_type`] ?? 'text');
    const options = String(form[`${key}_options`] ?? '')
      .split(',')
      .map((option) => option.trim())
      .filter(Boolean);
    return {
      label,
      type,
      ...(form[`${key}_required`] === 'on' ? { required: true } : {}),
      ...(type === 'choice' ? { options } : {}),
    };
  };
  switch (form.kind) {
    case 'addDocumentField': {
      const entityId = String(form.entity ?? '');
      const [namespace, entity] = entityId.split(':entity.');
      if (!namespace || !entity) throw new Error('Choose a record type.');
      const label = (form.label ?? '').trim();
      const maxCount = Number(form.maxCount);
      const fieldId = `${namespace}:field.custom_${entity}_${slug(label)}`;
      const categories = (form.categories ?? '')
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
        .map((name) => ({
          kind: 'addUploadCategory',
          schemaVersion: 'northstar.document-category/v1',
          categoryId: `${namespace}:category.custom_${entity}_${slug(label)}_${slug(name)}`,
          fieldId,
          entityId,
          label: name,
          maxCount,
          required: false,
          visibility: 'internal',
          retentionClass: 'northstar.documents:retention.manual',
          documentExpiryDate: null,
          maxBytes: 20 * 1024 * 1024,
          contentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
        }));
      const field = {
        kind: 'addDocumentField',
        schemaVersion: 'northstar.document-field/v1',
        type: 'files',
        fieldId,
        entityId,
        label,
        required: form.required === 'on',
        maxCount,
        allowedCategoryIds: categories.map(({ categoryId }) => categoryId),
      };
      return categories.length
        ? { kind: 'changeSet', patches: [field, ...categories] }
        : field;
    }
    case 'addCalculatedDisplayField':
      if (!calculatedTarget)
        throw new Error('Choose a record page for the calculation.');
      return calculatedDisplayDraft(calculatedTarget, {
        label: form.label ?? '',
        operator: form.operator ?? '',
        leftFieldId: form.leftFieldId ?? '',
        rightFieldId: form.rightFieldId ?? '',
        listSurfaceId: form.listSurfaceId ?? '',
      });
    case 'addValidation':
      if (!validationTarget) throw new Error('Choose an eligible record type.');
      if (form.check === 'compareFields') {
        const [first = '', second] = String(form.otherField ?? '').split('/');
        return fieldComparisonValidationDraft(validationTarget, {
          fieldId: String(form.fieldId ?? ''),
          operator: String(form.operator ?? ''),
          otherFieldId: second ?? first,
          ...(second ? { relationId: first } : {}),
          message: String(form.message ?? ''),
        });
      }
      return literalValidationDraft(validationTarget, {
        fieldId: String(form.fieldId ?? ''),
        check: String(form.check ?? ''),
        limit: String(form.limit ?? ''),
        message: String(form.message ?? ''),
      });
    case 'narrowPermission':
    case 'unNarrowPermission':
      return {
        kind: form.kind,
        roleKey: form.roleKey,
        target: { kind: 'operation', id: form.operation },
      };
    case 'addMetricCard':
      return {
        kind: 'addMetricCard',
        surface: form.surface,
        label: form.label,
        ...(form.view ? { view: form.view } : {}),
        ...(form.sumField ? { sumField: form.sumField } : {}),
      };
    case 'addRecordType':
    case 'extendRecordType': {
      const label = (form.label ?? '').trim();
      const header =
        form.kind === 'addRecordType'
          ? {
              fields: Array.from({ length: FIELD_ROWS }, (_, index) =>
                field(index + 1),
              ).filter((entry) => entry !== null),
              kind: 'addRecordType',
              label,
              ...(form.companyOwnership
                ? { companyOwnership: form.companyOwnership }
                : {}),
            }
          : null;
      const entity = header
        ? recordTypeEntityId('northstar.app', label)
        : form.entity;
      const value = (key: string) => (form[key] ?? '').trim();
      const lines = Array.from({ length: FIELD_ROWS }, (_, index) =>
        field(index + 1, 'line'),
      ).filter((entry) => entry !== null);
      const links = Array.from({ length: 4 }, (_, index) => {
        const key = `link_${index + 1}`;
        return {
          kind: 'addLink',
          entity,
          label: value(`${key}_label`),
          target: value(`${key}_target`),
        };
      }).filter((entry) => entry.label || entry.target);
      const states = Array.from({ length: 8 }, (_, index) => {
        const key = `state_${index + 1}`;
        const role = value(`${key}_role`);
        return { label: value(`${key}_label`), ...(role ? { role } : {}) };
      }).filter((entry) => entry.label || entry.role);
      const transitions = Array.from({ length: 12 }, (_, index) => {
        const key = `transition_${index + 1}`;
        return {
          label: value(`${key}_label`),
          from: value(`${key}_from`),
          to: value(`${key}_to`),
        };
      }).filter((entry) => entry.from || entry.to || entry.label);
      const tableLabel = value('lines_label');
      const initial = value('initial');
      const patches = [
        ...(header ? [header] : []),
        ...links,
        ...(tableLabel || lines.length
          ? [{ kind: 'addLineTable', entity, label: tableLabel, fields: lines }]
          : []),
        ...(initial || states.length || transitions.length
          ? [{ kind: 'declareLifecycle', entity, initial, states, transitions }]
          : []),
      ];
      return patches.length === 1 ? patches[0] : { kind: 'changeSet', patches };
    }
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

async function liveLinks(loadTargets: LoadTargets): Promise<string> {
  const lists = (await loadTargets()).lists.filter((list) =>
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

function describe(patch: PatchSummary): string {
  const label = patch.displayLabel ?? patch.patchId;
  switch (patch.kind) {
    case 'addRecordType':
      return `New record type "${label}"`;
    case 'addField':
      return `New field "${label}"`;
    case 'addDocumentField':
      return `New files field "${label}"`;
    case 'addChoice':
      return `New choice "${label}"`;
    case 'addLink':
      return `New link "${label}"`;
    case 'addLineTable':
      return `New line table "${label}"`;
    case 'declareLifecycle':
      return 'New states and actions';
    case 'addPopupActionRevision':
      return `Record button “${label}”`;
    case 'addLayoutRevision':
      return 'Arranged form or record page';
    case 'changeSet':
      return patch.displayLabel ?? 'Grouped changes';
    case 'arrangeLayout':
      return label === 'form'
        ? 'Arranged form fields'
        : 'Arranged list columns';
    case 'saveListView':
      return `Saved list view "${label}"`;
    case 'addMetricCard':
      return `Metric card "${label}"`;
    case 'addCalculatedDisplayField':
      return `Calculated display field "${label}"`;
    case 'addValidation':
      return `Validation rule "${label}"`;
    case 'narrowPermission':
      return `Action restriction for "${label}"`;
    case 'unNarrowPermission':
      return `Removed action restriction for "${label}"`;
    default:
      return `${patch.kind} (${patch.patchId})`;
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

function layoutPicker(targets: readonly LayoutTarget[]) {
  if (!targets.length) return '';
  return `<form method="get"><input type="hidden" name="customize" value=""><fieldset><legend>Arrange a form or record page</legend><label for="customize-layout-page">Page</label> <select id="customize-layout-page" name="layout">${targets.map((t) => `<option value="${escapeHtml(t.body.surfaceId + '/' + t.body.mode)}">${escapeHtml(t.label)} · ${t.body.mode}</option>`).join('')}</select> <button>Choose page</button></fieldset></form>`;
}
function layoutEditor(target: LayoutTarget) {
  const { body } = target;
  const input = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const start =
    '<form method="post">' +
    input('action', 'draft') +
    input('kind', 'addLayoutRevision') +
    input('layout', body.surfaceId + '/' + body.mode) +
    input('source', layoutDigest(target.body)) +
    input('predecessor', target.predecessor ?? '');
  const moveControls = (
    id: string,
    label: string,
    siblings: string[],
    field: boolean,
    rename: boolean,
  ) => {
    const i = siblings.indexOf(id);
    return (
      start +
      input('member', id) +
      `<fieldset><legend>${escapeHtml(label)}</legend>${rename ? `<label>New label <input name="label" maxlength="240" value="${escapeHtml(label)}"></label> <button name="edit" value="rename">Rename</button>` : ''}
    ${i > 0 ? '<button name="edit" value="up">Move up</button>' : ''}
    ${i + 1 < siblings.length ? '<button name="edit" value="down">Move down</button>' : ''}
    ${
      field && body.sections.length > 1
        ? `<label>Destination <select name="destination">${body.sections
            .filter((s) => !s.fields.some((f) => f.id === id))
            .map(
              (s) =>
                `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label.text)}</option>`,
            )
            .join(
              '',
            )}</select></label> <button name="edit" value="move">Move field</button>`
        : ''
    }</fieldset></form>`
    );
  };
  return (
    `<h1>Arrange ${escapeHtml(target.label)} · ${escapeHtml(body.mode)}</h1>${start}<label>Section name <input name="label" required maxlength="240"></label> <button name="edit" value="create">Draft new section</button></form>` +
    body.order
      .map((id) => {
        const section = body.sections.find((s) => s.id === id);
        if (!section)
          return moveControls(
            id,
            body.blocks.find((b) => b.id === id)!.label.text,
            body.order,
            false,
            false,
          );
        const fields = arrangeableLayoutFields(body, section);
        return `<section><h2>${escapeHtml(section.label.text)}</h2>${moveControls(id, section.label.text, body.order, false, true)}${fields
          .map((f) =>
            moveControls(
              f.id,
              f.label.text,
              fields
                .filter((entry) => entry.tier === f.tier)
                .map((entry) => entry.id),
              true,
              true,
            ),
          )
          .join('')}</section>`;
      })
      .join('')
  );
}
function layoutSubmission(
  targets: readonly LayoutTarget[],
  form: Readonly<Record<string, string>>,
) {
  const target = targets.find(
    (t) => t.body.surfaceId + '/' + t.body.mode === form.layout,
  );
  if (
    !target ||
    layoutDigest(target.body) !== form.source ||
    (target.predecessor ?? '') !== form.predecessor
  )
    throw new Error(
      'The page has changed. Open its current layout and draft again.',
    );
  return layoutCommand(target, {
    action: form.edit ?? '',
    member: form.member,
    destination: form.destination,
    label: form.label,
  });
}

function popupPicker(options: readonly PopupOption[]) {
  if (!options.length) return '';
  const edit = options.flatMap((o) =>
    o.existing
      .filter(
        (r) =>
          r.status === 'active' &&
          r.target.contractVersion === o.target.contractVersion,
      )
      .map(
        (r) =>
          `<li><a href="/?customize&amp;popup=${encodeURIComponent(popupOptionId(o))}&amp;button=${encodeURIComponent(r.actionId)}">Edit ${escapeHtml(r.label.text)} on ${escapeHtml(o.page)}</a></li>`,
      ),
  );
  return `<form method="get"><fieldset><legend>Add a record button</legend><input type="hidden" name="customize" value=""><label>Page and action <select name="popup">${options.map((o) => `<option value="${escapeHtml(popupOptionId(o))}">${escapeHtml(o.page)} — ${escapeHtml(o.label)}</option>`).join('')}</select></label><button>Choose fields</button></fieldset></form>${edit.length ? `<ul>${edit.join('')}</ul>` : ''}`;
}

function popupEditor(
  options: readonly PopupOption[],
  key: string,
  actionId: string | null,
) {
  const o = options.find((v) => popupOptionId(v) === key);
  const prior = o?.existing.find(
    (r) => r.actionId === actionId && r.status === 'active',
  );
  if (!o || (actionId && !prior)) return 'Choose an available record action.';
  const hidden = (name: string, value: string) =>
    `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`;
  const choice = (val: string, label: string, selected: boolean) =>
    `<option value="${escapeHtml(val)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const fields = o.fields.map((f) => {
    const source = prior?.inputs.find((i) => i.binding === f.id)?.source;
    return `<fieldset><legend>${escapeHtml(f.label)}</legend><label>Input source <select name="source:${escapeHtml(f.id)}">${o.target.kind === 'update' ? choice('', 'Leave out', !source) : ''}${choice('entry', 'Ask the person', source?.kind === 'userEntry')}${
      f.automatic
        ? choice('constant', 'Fixed text', source?.kind === 'constant') +
          o.sources
            .filter(
              (s) =>
                (s.maximumLength ?? Infinity) <=
                  (f.maximumLength ?? Infinity) &&
                (!f.required || s.required),
            )
            .map((s) =>
              choice(
                s.id,
                'From record · ' + s.label,
                source?.kind === 'recordField' && source.fieldId === s.id,
              ),
            )
            .join('')
        : ''
    }</select></label>${f.automatic ? `<label>Fixed text <input name="constant:${escapeHtml(f.id)}" maxlength="${f.maximumLength ?? 2000}" value="${escapeHtml(source?.kind === 'constant' ? source.value : '')}"></label>` : ''}</fieldset>`;
  });
  return `<h1>${escapeHtml(o.page)} · ${escapeHtml(o.label)}</h1><form method="post">${hidden('action', 'draft')}${hidden('kind', 'addPopupActionRevision')}${hidden('popup', key)}${hidden('contract', o.target.contractVersion)}${hidden('predecessor', prior?.revisionId ?? '')}${hidden('button', prior?.actionId ?? '')}<label>Button label <input name="label" required maxlength="80" value="${escapeHtml(prior?.label.text ?? o.label)}"></label>${fields.join('')}<button>Draft button</button>${prior ? '<button name="retire" value="yes" formnovalidate>Draft retirement</button>' : ''}</form>${backLink()}`;
}

function popupSubmission(
  options: readonly PopupOption[],
  form: CustomizeScreenSubmission,
) {
  const o = options.find(
    (o) =>
      popupOptionId(o) === form.popup &&
      form.contract === o.target.contractVersion,
  );
  if (!o)
    throw new Error('The action contract changed. Reopen the button editor.');
  const inputs = o.fields.flatMap(({ id }) => {
    const source = form['source:' + id];
    if (!source) return [];
    if (source === 'entry') return [{ binding: id, source }];
    return [
      source === 'constant'
        ? { binding: id, source, value: form['constant:' + id] ?? '' }
        : { binding: id, source: 'record', fieldId: source },
    ];
  });
  return popupCommand(options, {
    option: form.popup,
    label: form.label,
    contract: form.contract,
    actionId: form.button,
    predecessor: form.predecessor,
    retire: form.retire === 'yes',
    inputs,
  });
}
