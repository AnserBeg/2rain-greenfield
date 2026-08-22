// The committed negative controls for `record-claim-fidelity`.
//
// One control per diagnostic code, and each control varies EXACTLY ONE property
// of an otherwise-green synthetic world. Deleting an assertion from the checker
// therefore reds exactly one control, which is the rule that does not relax at
// any band. `scripts/check-records.sh --self-test` and the architecture suite
// run the same functions, so the controls cannot drift apart from the gate.
//
// The controls are SYNTHETIC by construction. The tree they measure is built
// from git objects written directly into the object database — never from the
// working tree, never from a checkout, and never by repairing anything. A
// verifier must not share a code path with the thing that heals what it
// verifies, so nothing here writes a file, moves a ref, or touches the index
// that `git status` reads.
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  verifyRecordClaims,
  createGitReader,
  type MarkdownDocument,
  type RecordClaimCode,
  type RecordClaimInput,
  type RecordClaimManifest,
} from './record-claim-fidelity.js';

export interface RecordClaimControl {
  readonly code: RecordClaimCode;
  readonly title: string;
  /** What a vacuous gate would do instead, in one line. */
  readonly vacuity: string;
  readonly run: (world: SyntheticWorld) => RecordClaimInput[];
}

export interface RecordClaimControlResult {
  readonly code: RecordClaimCode;
  readonly title: string;
  readonly passed: boolean;
  readonly observed: readonly string[];
}

const ABSENT_SHA = '0'.repeat(40);
const PROBE_BASE_SOURCE = 'export const untouched = 1;\n';
const PROBE_HEAD_SOURCE = `${PROBE_BASE_SOURCE}export function probeSymbol(): number {\n  return untouched;\n}\n`;
// A file the WORKING TREE really has. The unchanged-path control claims it, so
// a checker that read the working tree instead of the frozen commits would find
// a difference and pass — which is exactly the ux-picker r3 failure.
const HEALED_PATH = 'test/architecture/record-claim-fidelity.ts';
const RENAMED_SOURCE = 'export const renamed = 1;\n';

export interface SyntheticWorld {
  readonly root: string;
  /** base..head changes `probe/impl.ts` only. */
  readonly base: string;
  readonly head: string;
  /** base..healedHead changes no executable path; `HEALED_PATH` is identical in both. */
  readonly healedBase: string;
  readonly healedHead: string;
  /** base..undeclaredHead also changes `scripts/probe.sh`. */
  readonly undeclaredHead: string;
  /** Shares no history with `base`. */
  readonly unrelated: string;
}

export function buildSyntheticWorld(root: string): SyntheticWorld {
  const base = commitTree(root, { 'probe/impl.ts': PROBE_BASE_SOURCE });
  const head = commitTree(root, { 'probe/impl.ts': PROBE_HEAD_SOURCE }, base);
  const undeclaredHead = commitTree(
    root,
    {
      'probe/impl.ts': PROBE_HEAD_SOURCE,
      'scripts/probe.sh': '#!/usr/bin/env bash\nexit 0\n',
    },
    base,
  );
  const healedBase = commitTree(root, {
    [HEALED_PATH]: '// frozen placeholder\n',
    'docs/probe.md': 'before\n',
  });
  const healedHead = commitTree(
    root,
    {
      [HEALED_PATH]: '// frozen placeholder\n',
      'docs/probe.md': 'after\n',
    },
    healedBase,
  );
  return {
    base,
    head,
    healedBase,
    healedHead,
    root,
    undeclaredHead,
    unrelated: commitTree(root, {
      'probe/impl.ts': 'export const other = 2;\n',
    }),
  };
}

/**
 * A world in which every assertion holds. Every control below is this input
 * with exactly one property changed.
 */
export function greenInput(world: SyntheticWorld): RecordClaimInput {
  return {
    adrs: [
      document(
        'docs/decisions/ADR-9001-probe.md',
        '# ADR-9001\n\nStatus: accepted\n\nTier: Mechanical\n',
      ),
    ],
    git: createGitReader(world.root),
    ledger: ledgerDocument([['probe-packet', 'accepted']]),
    manifest: { schemaVersion: 'probe', unresolvableRatifications: [] },
    pathKind: () => 'absent',
    records: [recordDocument(declaration(world.base, world.head))],
    routingSources: [
      document(
        'docs/execution/probe-queue.md',
        'The finding is routed to `probe-packet`.\n',
      ),
    ],
    rowIdSources: [ledgerDocument([['probe-packet', 'accepted']])],
  };
}

export const RECORD_CLAIM_CONTROLS: readonly RecordClaimControl[] = [
  {
    code: 'RECORD_CLAIM_PATH_UNCHANGED',
    run: (world) => [
      {
        ...greenInput(world),
        // The claimed path is byte-identical between base and head, while the
        // WORKING TREE holds a different version of that same file.
        records: [
          recordDocument(
            declaration(world.healedBase, world.healedHead, {
              changedPaths: [HEALED_PATH],
              symbols: [],
            }),
          ),
        ],
      },
    ],
    title:
      'a claimed path byte-identical at base and head reds even when the working tree would satisfy it',
    vacuity:
      'a checker reading the working tree instead of the frozen commits passes the ux-picker r3 commit',
  },
  {
    code: 'RECORD_CLAIM_SYMBOL_ABSENT',
    run: (world) => {
      const base = commitTree(world.root, {
        'probe/impl.ts': PROBE_BASE_SOURCE,
      });
      const head = commitTree(
        world.root,
        {
          // `probeSymbol` occurs twice and is declared neither time.
          'probe/impl.ts': `${PROBE_BASE_SOURCE}// probeSymbol lives here one day.\nexport const note = 'probeSymbol';\n`,
        },
        base,
      );
      return [
        {
          ...greenInput(world),
          records: [recordDocument(declaration(base, head))],
        },
      ];
    },
    title:
      'a claimed symbol present only in a comment and a string literal reds',
    vacuity:
      'a checker matching the name as a string counts a mention as a declaration',
  },
  {
    code: 'RECORD_CLAIM_PATH_UNDECLARED',
    run: (world) => {
      const renameBase = commitTree(world.root, {
        'probe/old.ts': RENAMED_SOURCE,
      });
      const renameHead = commitTree(
        world.root,
        { 'probe/new.ts': RENAMED_SOURCE },
        renameBase,
      );
      return [
        {
          ...greenInput(world),
          // `scripts/probe.sh` also changed and the block declares nothing over it.
          records: [
            recordDocument(declaration(world.base, world.undeclaredHead)),
          ],
        },
        {
          ...greenInput(world),
          // A pure rename. The destination is declared; the VACATED path is not,
          // and git's default rename detection reports only the destination, so
          // without `--no-renames` this whole class is invisible.
          records: [
            recordDocument(
              declaration(renameBase, renameHead, {
                changedPaths: ['probe/new.ts'],
                symbols: [{ name: 'renamed', path: 'probe/new.ts' }],
              }),
            ),
          ],
        },
      ];
    },
    title:
      'an executable path changed but undeclared reds — under scripts/, and on the vacated side of a rename',
    vacuity:
      'an exclusion list that swallows scripts/, or default rename detection reporting only the destination, lets a lease violation land silently',
  },
  {
    code: 'RECORD_CLAIM_SYMBOL_FILE_ABSENT',
    run: (world) => {
      const base = commitTree(world.root, {
        'probe/impl.ts': PROBE_HEAD_SOURCE,
      });
      // Head DELETES the claimed file. Deletion is a real change, so the path
      // assertion passes and the undeclared-path assertion passes; only the
      // missing-blob branch catches it. Review measured that deleting that
      // branch alone reded nothing, because the comment-and-string control
      // exercises the other branch entirely.
      const head = commitTree(
        world.root,
        { 'probe/other.ts': 'export const other = 1;\n' },
        base,
      );
      return [
        {
          ...greenInput(world),
          records: [
            recordDocument(
              declaration(base, head, {
                changedPaths: ['probe/impl.ts', 'probe/other.ts'],
                symbols: [{ name: 'probeSymbol', path: 'probe/impl.ts' }],
              }),
            ),
          ],
        },
      ];
    },
    title: 'a symbol claimed in a file the head DELETED reds',
    vacuity:
      'deletion is a real change, so every other Family A assertion passes and the claim survives',
  },
  {
    code: 'RECORD_CLAIM_PACKET_MISMATCH',
    run: (world) => [
      {
        ...greenInput(world),
        // The block is valid and its claims all hold — against ANOTHER packet's
        // commits. Copied verbatim into a different record, it certified work
        // this record did not do.
        records: [
          recordDocument(
            declaration(world.base, world.head),
            'docs/execution/packets/some-other-packet.md',
          ),
        ],
      },
    ],
    title: 'a valid block copied into a different packet record reds',
    vacuity:
      'the packet field is decorative, so a copy/paste certifies the original packet twice',
  },
  {
    code: 'RECORD_CLAIM_PACKET_DUPLICATED',
    run: (world) => [
      {
        ...greenInput(world),
        records: [
          recordDocument(declaration(world.base, world.head)),
          recordDocument(declaration(world.base, world.head)),
        ],
      },
    ],
    title: 'one packet declared by two records reds',
    vacuity: 'two records certify one packet and each reads as the authority',
  },
  {
    code: 'RECORD_LEDGER_COLUMN_ABSENT',
    run: (world) => [
      {
        ...greenInput(world),
        ledger: document(
          'docs/execution/ledger.md',
          '# Execution ledger\n\n| ID | Packet | Stage | Tier | State | SHA | Evidence |\n|---|---|---|---|---|---|---|\n| probe-packet | probe | — | Mechanical | accepted | — | — |\n',
        ),
      },
    ],
    title: 'a packet table whose header carries no Status column reds',
    vacuity:
      'a renamed or reordered column makes every ratification lookup read some other cell',
  },
  {
    code: 'RECORD_CLAIM_BLOCK_UNPARSABLE',
    run: (world) => [
      {
        ...greenInput(world),
        records: [recordDocument('{ "packet": not json }')],
      },
    ],
    title:
      'a declaration block that is not JSON reds rather than being skipped',
    vacuity:
      'an unreadable block silently exempts its packet from every claim assertion',
  },
  {
    code: 'RECORD_CLAIM_BLOCK_INVALID',
    run: (world) => {
      const valid = JSON.parse(declaration(world.base, world.head)) as Record<
        string,
        unknown
      >;
      const mutations: Record<string, unknown>[] = [
        { ...valid, unreviewedDefault: true },
        { ...valid, schemaVersion: 'northstar.record-claim/v0' },
        { ...valid, base: valid.base?.toString().slice(0, 7) },
        { ...valid, changedPaths: [] },
        { ...valid, changedPaths: ['probe/impl.ts', 'probe/impl.ts'] },
        { ...valid, changedPaths: ['../outside/impl.ts'] },
        { ...valid, packet: '' },
        { ...valid, symbols: [{ name: 'probeSymbol' }] },
        {
          ...valid,
          symbols: [{ name: 'probe symbol', path: 'probe/impl.ts' }],
        },
        // Shell functions are not resolvable by the TypeScript reader, so a
        // symbol claim over a shell script must be refused, not guessed at.
        {
          ...valid,
          symbols: [{ name: 'probeSymbol', path: 'scripts/probe.sh' }],
        },
      ];
      return mutations.map((mutation) => ({
        ...greenInput(world),
        records: [recordDocument(JSON.stringify(mutation, undefined, 2))],
      }));
    },
    title: 'every malformed declaration shape reds, one shape at a time',
    vacuity:
      'a shape the parser does not recognise passes as though it declared nothing',
  },
  {
    code: 'RECORD_CLAIM_BLOCK_DUPLICATED',
    run: (world) => [
      {
        ...greenInput(world),
        records: [
          document(
            'docs/execution/packets/probe-packet.md',
            `${fence(declaration(world.base, world.head))}\n\n${fence(
              declaration(world.base, world.head),
            )}\n`,
          ),
        ],
      },
    ],
    title: 'two declaration blocks in one record red',
    vacuity: 'a second block silently overrides or shadows the first',
  },
  {
    code: 'RECORD_CLAIM_COMMIT_UNRESOLVABLE',
    run: (world) => [
      {
        ...greenInput(world),
        records: [recordDocument(declaration(ABSENT_SHA, world.head))],
      },
      {
        ...greenInput(world),
        // A head that does not descend from the declared base is not this
        // packet's range, so the claims are measured against the wrong tree.
        records: [recordDocument(declaration(world.unrelated, world.head))],
      },
    ],
    title:
      'an unresolvable base and a head outside the declared range both red',
    vacuity: 'a rotten or wrong range measures nothing and reports success',
  },
  {
    code: 'RECORD_CLAIM_NO_RECORDS',
    run: (world) => [{ ...greenInput(world), records: [] }],
    title: 'discovering zero packet records reds',
    vacuity: 'a discovery glob that matches nothing reports every claim upheld',
  },
  {
    code: 'RECORD_CLAIM_NO_DECLARATIONS',
    run: (world) => [
      {
        ...greenInput(world),
        records: [
          document(
            'docs/execution/packets/probe-packet.md',
            '# probe-packet\n\nNo block here.\n',
          ),
        ],
      },
    ],
    title: 'records that all declare nothing red',
    vacuity:
      'deleting the last declaration block disables the whole family in silence',
  },
  {
    code: 'RECORD_ADR_RATIFICATION_STALE',
    run: (world) => [
      {
        ...greenInput(world),
        adrs: [
          document(
            'docs/decisions/ADR-9002-probe.md',
            '# ADR-9002\n\nStatus: proposed by packet `probe-packet`; ratified when that\npacket is accepted\n\nTier: Critical\n',
          ),
        ],
      },
      {
        ...greenInput(world),
        // PRECEDENCE. The provenance packet is planned and the RATIFICATION
        // packet is accepted. A reader that binds to the first anchor it tries
        // reports success and never tests the condition the ADR states.
        adrs: [
          document(
            'docs/decisions/ADR-9006-probe.md',
            '# ADR-9006\n\nStatus: proposed by packet author-packet;\nratified when implementation-packet is accepted\n\nTier: Critical\n',
          ),
        ],
        ledger: ledgerDocument([
          ['author-packet', 'planned'],
          ['implementation-packet', 'accepted'],
        ]),
        rowIdSources: [
          ledgerDocument([
            ['author-packet', 'planned'],
            ['implementation-packet', 'accepted'],
          ]),
        ],
        routingSources: [
          document(
            'docs/execution/probe-queue.md',
            'The finding is routed to `author-packet`.\n',
          ),
        ],
      },
      {
        ...greenInput(world),
        // ESCAPED PIPE. A literal `|` inside an earlier cell shifts every later
        // column, so a status read at a fixed index lands on Tier and passes.
        ledger: document(
          'docs/execution/ledger.md',
          '# Execution ledger\n\n| ID | Packet | Stage | Tier | Status | SHA | Evidence |\n|---|---|---|---|---|---|---|\n| probe-packet | name with \\| detail | — | Mechanical | accepted | — | — |\n',
        ),
        adrs: [
          document(
            'docs/decisions/ADR-9007-probe.md',
            '# ADR-9007\n\nStatus: proposed by packet `probe-packet`; ratified when that\npacket is accepted\n\nTier: Critical\n',
          ),
        ],
      },
    ],
    title:
      'a proposed ADR whose packet the ledger records as accepted reds — including when the ratification packet is named second, and when an escaped pipe shifts the Status column',
    vacuity:
      'the record layer keeps a status line the ledger has already contradicted',
  },
  {
    code: 'RECORD_ADR_PACKET_UNRESOLVED',
    run: (world) => [
      {
        ...greenInput(world),
        adrs: [
          document(
            'docs/decisions/ADR-9003-probe.md',
            '# ADR-9003\n\nStatus: proposed by the orchestrator; ratified when its first\nimplementing packet is accepted.\n\nTier: Critical\n',
          ),
        ],
      },
    ],
    title:
      'a proposed ADR naming no resolvable packet reds unless it is pinned',
    vacuity:
      'an unparseable status is skipped, so the check quietly stops applying',
  },
  {
    code: 'RECORD_ADR_NONE_SCANNED',
    run: (world) => [{ ...greenInput(world), adrs: [] }],
    title: 'discovering zero decision records reds',
    vacuity:
      'a discovery glob that matches nothing reports every ratification current',
  },
  {
    code: 'RECORD_MANIFEST_PIN_STALE',
    run: (world) => [
      {
        ...greenInput(world),
        manifest: {
          schemaVersion: 'probe',
          unresolvableRatifications: [
            {
              adr: 'ADR-9004-probe.md',
              reason: 'no longer observed unresolvable',
            },
          ],
        } satisfies RecordClaimManifest,
      },
    ],
    title: 'a pin that is no longer observed unresolvable reds',
    vacuity: 'the pin becomes a permanent exemption nobody re-derives',
  },
  {
    code: 'RECORD_LEDGER_ID_DUPLICATE',
    run: (world) => [
      {
        ...greenInput(world),
        ledger: ledgerDocument([
          ['probe-packet', 'accepted'],
          ['probe-packet', 'planned'],
        ]),
      },
    ],
    title: 'a ledger id appearing twice reds',
    vacuity:
      'two rows disagree about one packet and each reader picks a different one',
  },
  {
    code: 'RECORD_LEDGER_TABLE_ABSENT',
    run: (world) => [
      {
        ...greenInput(world),
        ledger: document(
          'docs/execution/ledger.md',
          '# Execution ledger\n\nNo table.\n',
        ),
      },
    ],
    title: 'a ledger with no packet table reds',
    vacuity:
      'a renamed or reshaped table makes uniqueness and ratification read zero rows',
  },
  {
    code: 'RECORD_ROUTING_UNRESOLVED',
    run: (world) => [
      {
        ...greenInput(world),
        routingSources: [
          document(
            'docs/execution/probe-queue.md',
            'The finding is routed to `no-such-owning-row`.\n',
          ),
        ],
      },
      {
        ...greenInput(world),
        // A TABLE HEADER is not a tracked row. `ID` is the ledger's own first
        // column name, and it resolved until the header was excluded.
        routingSources: [
          document('docs/execution/probe-queue.md', 'routed to `ID`.\n'),
        ],
      },
      {
        ...greenInput(world),
        // A DIRECTORY is not a document. `docs/execution` exists and resolved
        // nothing about who owns the finding.
        pathKind: (candidate) =>
          candidate === 'docs/execution' ? 'directory' : 'absent',
        routingSources: [
          document(
            'docs/execution/probe-queue.md',
            'routed to `docs/execution`.\n',
          ),
        ],
      },
    ],
    title:
      'a routing naming neither a tracked row nor a document reds — including a table header and a directory',
    vacuity:
      'a recorded finding with no owning row is a disposition with no executing gate',
  },
];

export function runRecordClaimControls(
  root: string,
): RecordClaimControlResult[] {
  const world = buildSyntheticWorld(root);
  return RECORD_CLAIM_CONTROLS.map((control) => {
    const observed = new Set<string>();
    let passed = true;
    for (const input of control.run(world)) {
      const codes = verifyRecordClaims(input).findings.map(({ code }) => code);
      for (const code of codes) {
        observed.add(code);
      }
      // The control must red on its own assertion and on nothing else, or a
      // deletion elsewhere would also red it and attribution is lost.
      if (codes.length === 0 || codes.some((code) => code !== control.code)) {
        passed = false;
      }
    }
    return {
      code: control.code,
      observed: [...observed].sort(),
      passed,
      title: control.title,
    };
  });
}

// ---------------------------------------------------------------------------
// Synthetic document and git-object builders
// ---------------------------------------------------------------------------

function document(path: string, text: string): MarkdownDocument {
  return { path, text };
}

function recordDocument(
  body: string,
  path = 'docs/execution/packets/probe-packet.md',
): MarkdownDocument {
  return document(path, `# probe-packet\n\n${fence(body)}\n`);
}

function fence(body: string): string {
  return `\`\`\`record-claim\n${body}\n\`\`\``;
}

function declaration(
  base: string,
  head: string,
  overrides: Partial<{
    changedPaths: readonly string[];
    symbols: readonly { path: string; name: string }[];
  }> = {},
): string {
  return JSON.stringify(
    {
      base,
      changedPaths: overrides.changedPaths ?? ['probe/impl.ts'],
      head,
      packet: 'probe-packet',
      schemaVersion: 'northstar.record-claim/v1',
      symbols: overrides.symbols ?? [
        { name: 'probeSymbol', path: 'probe/impl.ts' },
      ],
    },
    undefined,
    2,
  );
}

function ledgerDocument(
  rows: readonly (readonly [string, string])[],
): MarkdownDocument {
  const body = rows
    .map(
      ([id, status]) =>
        `| ${id} | probe | — | Mechanical | ${status} | — | — |`,
    )
    .join('\n');
  return document(
    'docs/execution/ledger.md',
    `# Execution ledger\n\n| ID | Packet | Stage | Tier | Status | SHA | Evidence |\n|---|---|---|---|---|---|---|\n${body}\n`,
  );
}

function git(
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): string {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
  }
  return result.stdout;
}

/**
 * Writes a dangling commit straight into the object database. It touches no ref,
 * no branch and no index that `git status` reads, so the controls cannot disturb
 * a working tree — including one another lane is holding.
 */
function commitTree(
  root: string,
  files: Readonly<Record<string, string>>,
  parent?: string,
): string {
  const indexFile = join(mkdtempSync(join(tmpdir(), 'record-claim-')), 'index');
  for (const [path, content] of Object.entries(files)) {
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: root,
      encoding: 'utf8',
      input: content,
    });
    if (blob.status !== 0) {
      throw new Error(`git hash-object failed: ${blob.stderr}`);
    }
    git(
      root,
      [
        'update-index',
        '--add',
        '--cacheinfo',
        `100644,${blob.stdout.trim()},${path}`,
      ],
      { GIT_INDEX_FILE: indexFile },
    );
  }
  const tree = git(root, ['write-tree'], { GIT_INDEX_FILE: indexFile }).trim();
  // A fixed clock, per AGENTS.md section 7: this machine steps its wall clock
  // backward under load, and a synthetic commit has no reason to sample it.
  const stamp = '1750000000 +0000';
  return git(
    root,
    [
      'commit-tree',
      tree,
      ...(parent ? ['-p', parent] : []),
      '-m',
      'record-claim control',
    ],
    {
      GIT_AUTHOR_DATE: stamp,
      GIT_AUTHOR_EMAIL: 'controls@north-star.invalid',
      GIT_AUTHOR_NAME: 'record-claim controls',
      GIT_COMMITTER_DATE: stamp,
      GIT_COMMITTER_EMAIL: 'controls@north-star.invalid',
      GIT_COMMITTER_NAME: 'record-claim controls',
    },
  ).trim();
}
