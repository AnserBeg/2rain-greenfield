// Observes what a packet record CLAIMS against what the git tree CONTAINS, and
// checks the narrative record layer for the staleness classes that no gate has
// ever read.
//
// WHY THIS EXISTS. Two failures, one harness.
//
// (1) `ux-picker` round 3 froze `56762ce` with a commit message describing work
//     the commit did not contain: `surface-contract.ts` was byte-identical at
//     base and head because a drift probe's `git checkout -- <path>` had reverted
//     the round's implementation along with the mutation. Nothing went red,
//     because the PREVIOUS round's implementation passes the same suites. A
//     reviewer found it by reading `git show --stat`; nothing in the repository
//     could find it at all.
//
// (2) Program review R1 (2026-08-20) measured that the programme has gated
//     process rules three times — check-review-record.sh, check-origin-sync.sh,
//     check-parked-work.sh — and the record layer zero times.
//
// WHAT IT OBSERVES, AND WHAT IT CANNOT. Every CLAIM-FIDELITY assertion — the
// declared paths and symbols — reads the FROZEN TREE through git plumbing
// (`git diff`, `git show`), because the failure being closed is precisely a
// working tree that disagrees with the commit. Symbol presence is decided by
// parsing the blob at the declared head into a TypeScript AST and reading its
// declarations, not by matching a string: a name that appears only in a comment
// or a string literal declares nothing and must not satisfy a claim.
//
// The DECLARATIONS THEMSELVES, and every record-staleness input, are read from
// the checkout. That is deliberate — the subject is the current record layer —
// but it means this gate is a live reader of `docs/**`, which the exclusion
// list below calls non-executable. See the packet record: that contradiction is
// real, was measured, and is the orchestrator's to settle.
//
// It cannot prove that the record claims ENOUGH. The declaration block is
// written by the packet author, so a packet that declares nothing is checked
// against nothing. This gate closes "the commit does not contain what the record
// claims"; it does not close "the record claims too little". See the packet
// record for the full statement of limits.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, relative, resolve, sep } from 'node:path';

import ts from 'typescript';

/** Every way this gate can fail. One code, one assertion, one committed control. */
export const RECORD_CLAIM_CODES = [
  'RECORD_CLAIM_RANGE_UNOWNED',
  'RECORD_CLAIM_PATH_UNCHANGED',
  'RECORD_CLAIM_SYMBOL_ABSENT',
  'RECORD_CLAIM_SYMBOL_FILE_ABSENT',
  'RECORD_CLAIM_PATH_UNDECLARED',
  'RECORD_CLAIM_PACKET_MISMATCH',
  'RECORD_CLAIM_PACKET_DUPLICATED',
  'RECORD_CLAIM_BLOCK_UNPARSABLE',
  'RECORD_CLAIM_BLOCK_INVALID',
  'RECORD_CLAIM_BLOCK_DUPLICATED',
  'RECORD_CLAIM_COMMIT_UNRESOLVABLE',
  'RECORD_CLAIM_NO_RECORDS',
  'RECORD_CLAIM_NO_DECLARATIONS',
  'RECORD_ADR_RATIFICATION_STALE',
  'RECORD_ADR_PACKET_UNRESOLVED',
  'RECORD_ADR_NONE_SCANNED',
  'RECORD_MANIFEST_PIN_STALE',
  'RECORD_MANIFEST_OWNING_TABLE_STALE',
  'RECORD_LEDGER_ID_DUPLICATE',
  'RECORD_LEDGER_TABLE_ABSENT',
  'RECORD_LEDGER_COLUMN_ABSENT',
  'RECORD_ROUTING_UNRESOLVED',
] as const;

export type RecordClaimCode = (typeof RECORD_CLAIM_CODES)[number];

export interface RecordClaimFinding {
  readonly code: RecordClaimCode;
  readonly subject: string;
  readonly message: string;
}

export interface RecordClaimReport {
  readonly findings: readonly RecordClaimFinding[];
  /** Records carrying a well-formed declaration block. */
  readonly declaredPackets: readonly string[];
  readonly recordsScanned: number;
  readonly adrsScanned: number;
  readonly ledgerRows: number;
  readonly routingsResolved: number;
  /** Claimed paths whose difference from base was observed. */
  readonly pathsObserved: number;
  /** Claimed symbols resolved in the frozen tree. */
  readonly symbolsObserved: number;
}

export interface MarkdownDocument {
  readonly path: string;
  readonly text: string;
}

export interface GitReader {
  /** Full SHA for a revision, or undefined when it does not resolve. */
  resolveCommit(revision: string): string | undefined;
  isAncestor(ancestor: string, descendant: string): boolean;
  /** True when `path` differs between the two commits. Reads commits, never the working tree. */
  pathDiffers(base: string, head: string, path: string): boolean;
  /** Executable paths changed between the two commits, per git-workflow's exclusion list. */
  executablePathsChanged(base: string, head: string): readonly string[];
  /** File content at a commit, or undefined when the commit has no such blob. */
  readBlob(commit: string, path: string): string | undefined;
  /** A commit's full message, for the `Packet:` trailer that owns its range. */
  readCommitMessage(commit: string): string | undefined;
}

/**
 * The pinned known-absence set. An ADR whose governing status is `proposed` but
 * whose named packet cannot be resolved to a ledger row is not checkable by
 * RECORD_ADR_RATIFICATION_STALE, so it is pinned here with its reason rather
 * than skipped silently. The pin is a two-way ratchet: a NEW unresolvable ADR
 * fails, and a pin that has become resolvable fails too.
 */
export interface RecordClaimManifest {
  readonly schemaVersion: string;
  readonly unresolvableRatifications: readonly {
    readonly adr: string;
    readonly reason: string;
  }[];
  /**
   * The tables whose rows OWN work, by exact header signature. A routing may
   * resolve against these and nothing else: admitting every id-shaped first
   * cell let a colour table's `blue` own a finding. Declared rather than
   * inferred, and ratcheted both ways — a signature matching no table in the
   * tree fails, so the list cannot rot into a permanent allowlist.
   */
  readonly owningTables: readonly {
    readonly header: readonly string[];
    readonly reason: string;
  }[];
}

export interface RecordClaimInput {
  readonly records: readonly MarkdownDocument[];
  readonly adrs: readonly MarkdownDocument[];
  readonly ledger: MarkdownDocument;
  /** Documents whose table rows supply resolvable row ids. */
  readonly rowIdSources: readonly MarkdownDocument[];
  /** Documents scanned for `routed to \`<id>\`` references. */
  readonly routingSources: readonly MarkdownDocument[];
  readonly manifest: RecordClaimManifest;
  /**
   * What a repository-relative path IS. A routing may name a document; a
   * DIRECTORY is not one, and answering with a bare boolean put that
   * distinction in the wiring where no control could reach it.
   */
  readonly pathKind: (candidate: string) => 'file' | 'directory' | 'absent';
  readonly git: GitReader;
}

/**
 * git-workflow's identical-tree exclusion list, verbatim, used here for exactly
 * one purpose: deciding which changed paths a declaration block must declare.
 *
 * Its stated premise — that these paths "are never executed" — is FALSE of this
 * gate, and this gate is what made it false. Measured: a docs-only commit that
 * repoints a declared head to forty zeroes leaves `git diff --name-only` under
 * this pathspec empty while `test:architecture` reds. The premise is not
 * repaired here; it is recorded in the packet record as a scope finding, and
 * changing `git-workflow` is the orchestrator's edit.
 */
export const NON_EXECUTABLE_PATHSPEC = [
  ':!docs',
  ':!.agents',
  ':!CLAUDE.md',
  ':!AGENTS.md',
  ':!learnings.md',
] as const;

const FULL_SHA = /^[0-9a-f]{40}$/u;
const ROW_ID = '[A-Za-z0-9][A-Za-z0-9._-]*';
const DECLARATION_FENCE =
  /^```record-claim[^\S\n]*\n([\s\S]*?)^```[^\S\n]*$/gmu;
const ROUTED_TO = /routed to `([^`\n]+)`/giu;
const LEDGER_HEADER = /^\|\s*ID\s*\|\s*Packet\s*\|/u;
const SYMBOL_RESOLVABLE_SUFFIX = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|jsx)$/u;
const BLOCK_KEYS = [
  'schemaVersion',
  'packet',
  'base',
  'head',
  'changedPaths',
  'symbols',
] as const;
const BLOCK_SCHEMA_VERSION = 'northstar.record-claim/v1';

/**
 * A GFM table delimiter row. Outer pipes are OPTIONAL in GFM, so a header whose
 * delimiter omits one was not recognised and the header's own first cell was
 * harvested as a tracked row id.
 */
function isSeparatorRow(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('-') || !trimmed.includes('|')) {
    return false;
  }
  const cells = trimmed.replace(/^\|/u, '').replace(/\|$/u, '').split('|');
  return (
    cells.length > 0 && cells.every((cell) => /^\s*:?-+:?\s*$/u.test(cell))
  );
}

interface DeclarationBlock {
  readonly packet: string;
  readonly base: string;
  readonly head: string;
  readonly changedPaths: readonly string[];
  readonly symbols: readonly { readonly path: string; readonly name: string }[];
}

export function verifyRecordClaims(input: RecordClaimInput): RecordClaimReport {
  const findings: RecordClaimFinding[] = [];
  const declaredPackets: string[] = [];
  let pathsObserved = 0;
  let symbolsObserved = 0;

  if (input.records.length === 0) {
    findings.push({
      code: 'RECORD_CLAIM_NO_RECORDS',
      subject: 'docs/execution/packets',
      message:
        'no packet records were discovered, so every claim-fidelity assertion read zero input',
    });
  }

  // Counted separately from `declaredPackets`: "nobody declared anything" and
  // "a declaration was present and rejected" are different facts, and folding
  // them together would make every malformed-block control red twice.
  let blocksPresent = 0;
  const declaringRecord = new Map<string, string>();
  for (const record of input.records) {
    blocksPresent += countDeclarationFences(record.text);
    const block = parseDeclarationBlock(record, findings);
    if (!block) {
      continue;
    }
    // The `packet` field must IDENTIFY the record, or it is decorative: a block
    // copied verbatim into another record resolves against the original's
    // commits and reports success for a packet that did no work. Found by
    // review, reproduced by copying this packet's own block into a second file.
    const stem = basename(record.path).replace(/\.md$/u, '');
    if (block.packet !== stem) {
      findings.push({
        code: 'RECORD_CLAIM_PACKET_MISMATCH',
        subject: record.path,
        message: `declares packet \`${block.packet}\` but the record is \`${stem}\`; a block copied from another record certifies that record's commits, not this one's`,
      });
      continue;
    }
    const alreadyDeclaredBy = declaringRecord.get(block.packet);
    if (alreadyDeclaredBy !== undefined) {
      findings.push({
        code: 'RECORD_CLAIM_PACKET_DUPLICATED',
        subject: block.packet,
        message: `is declared by both ${alreadyDeclaredBy} and ${record.path}; one packet, one declaration`,
      });
      continue;
    }
    declaringRecord.set(block.packet, record.path);
    declaredPackets.push(block.packet);
    const observed = observeClaims(record.path, block, input.git, findings);
    pathsObserved += observed.paths;
    symbolsObserved += observed.symbols;
  }

  if (input.records.length > 0 && blocksPresent === 0) {
    findings.push({
      code: 'RECORD_CLAIM_NO_DECLARATIONS',
      subject: 'docs/execution/packets',
      message: `${input.records.length} packet record(s) were scanned and not one carries a \`${BLOCK_SCHEMA_VERSION}\` block, so the claim-fidelity family asserts nothing`,
    });
  }

  const ledgerRows = readLedgerIds(input.ledger, findings);
  const { ids: rowIds, matched } = collectRowIds(
    input.rowIdSources,
    input.manifest.owningTables,
  );
  for (const { header, reason } of input.manifest.owningTables) {
    if (matched.has(signature(header))) {
      continue;
    }
    findings.push({
      code: 'RECORD_MANIFEST_OWNING_TABLE_STALE',
      subject: `| ${header.join(' | ')} |`,
      message: `is declared an owning table (${reason}) and matches no table in the tree; re-derive it rather than keeping a list that has stopped describing the records`,
    });
  }
  checkRatifications(input, ledgerRows, findings);
  const routingsResolved = checkRoutings(input, rowIds, findings);

  return {
    adrsScanned: input.adrs.length,
    declaredPackets,
    findings,
    ledgerRows: ledgerRows.size,
    pathsObserved,
    recordsScanned: input.records.length,
    routingsResolved,
    symbolsObserved,
  };
}

// ---------------------------------------------------------------------------
// Family A — claim fidelity
// ---------------------------------------------------------------------------

function declarationBodies(text: string): string[] {
  return [...text.matchAll(DECLARATION_FENCE)].map((match) => match[1] ?? '');
}

function countDeclarationFences(text: string): number {
  return declarationBodies(text).length;
}

function parseDeclarationBlock(
  record: MarkdownDocument,
  findings: RecordClaimFinding[],
): DeclarationBlock | undefined {
  const bodies = declarationBodies(record.text);
  if (bodies.length === 0) {
    return undefined;
  }
  if (bodies.length > 1) {
    findings.push({
      code: 'RECORD_CLAIM_BLOCK_DUPLICATED',
      subject: record.path,
      message: `carries ${bodies.length} declaration blocks; exactly one record may declare exactly one set of claims`,
    });
    return undefined;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(bodies[0] ?? '');
  } catch (error) {
    findings.push({
      code: 'RECORD_CLAIM_BLOCK_UNPARSABLE',
      subject: record.path,
      message: `declaration block is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return undefined;
  }

  const invalid = (message: string): undefined => {
    findings.push({
      code: 'RECORD_CLAIM_BLOCK_INVALID',
      subject: record.path,
      message,
    });
    return undefined;
  };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid('declaration block is not a JSON object');
  }
  const block = raw as Record<string, unknown>;
  const unknown = Object.keys(block).filter(
    (key) => !(BLOCK_KEYS as readonly string[]).includes(key),
  );
  if (unknown.length > 0) {
    return invalid(
      `declaration block carries unknown key(s): ${unknown.join(', ')}`,
    );
  }
  if (block.schemaVersion !== BLOCK_SCHEMA_VERSION) {
    return invalid(
      `declaration block schemaVersion must be "${BLOCK_SCHEMA_VERSION}", received ${JSON.stringify(block.schemaVersion)}`,
    );
  }
  if (typeof block.packet !== 'string' || block.packet.length === 0) {
    return invalid('declaration block has no packet name');
  }
  for (const key of ['base', 'head'] as const) {
    const value = block[key];
    if (typeof value !== 'string' || !FULL_SHA.test(value)) {
      return invalid(
        `declaration block ${key} must be a full 40-character SHA, received ${JSON.stringify(value)}`,
      );
    }
  }
  const changedPaths = block.changedPaths;
  if (
    !Array.isArray(changedPaths) ||
    changedPaths.length === 0 ||
    !changedPaths.every(
      (entry) => typeof entry === 'string' && isRepositoryPath(entry),
    )
  ) {
    return invalid(
      'declaration block changedPaths must be a non-empty array of repository-relative paths',
    );
  }
  if (new Set(changedPaths as string[]).size !== changedPaths.length) {
    return invalid('declaration block changedPaths repeats a path');
  }
  const symbols = block.symbols;
  if (!Array.isArray(symbols)) {
    return invalid('declaration block symbols must be an array');
  }
  for (const entry of symbols) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return invalid('declaration block symbols entry is not an object');
    }
    const symbol = entry as Record<string, unknown>;
    const keys = Object.keys(symbol).sort().join(',');
    if (keys !== 'name,path') {
      return invalid(
        `declaration block symbols entry must carry exactly {path, name}, received {${keys}}`,
      );
    }
    if (typeof symbol.path !== 'string' || !isRepositoryPath(symbol.path)) {
      return invalid(
        'declaration block symbols entry has no repository-relative path',
      );
    }
    if (!SYMBOL_RESOLVABLE_SUFFIX.test(symbol.path)) {
      return invalid(
        `symbol resolution is observable only in TypeScript/JavaScript sources; ${symbol.path} is claimed by path alone`,
      );
    }
    if (
      typeof symbol.name !== 'string' ||
      !/^[A-Za-z_$][\w$]*$/u.test(symbol.name)
    ) {
      return invalid(
        `declaration block symbols entry has no identifier name, received ${JSON.stringify(symbol.name)}`,
      );
    }
  }

  return {
    base: block.base as string,
    changedPaths: changedPaths as readonly string[],
    head: block.head as string,
    packet: block.packet,
    symbols: symbols as readonly { path: string; name: string }[],
  };
}

function observeClaims(
  recordPath: string,
  block: DeclarationBlock,
  git: GitReader,
  findings: RecordClaimFinding[],
): { paths: number; symbols: number } {
  const base = git.resolveCommit(block.base);
  const head = git.resolveCommit(block.head);
  if (!base || !head) {
    findings.push({
      code: 'RECORD_CLAIM_COMMIT_UNRESOLVABLE',
      subject: recordPath,
      message: `declared ${base ? 'head' : 'base'} ${base ? block.head : block.base} does not resolve to a commit in this repository`,
    });
    return { paths: 0, symbols: 0 };
  }
  if (!git.isAncestor(base, head)) {
    findings.push({
      code: 'RECORD_CLAIM_COMMIT_UNRESOLVABLE',
      subject: recordPath,
      message: `declared base ${block.base.slice(0, 7)} is not an ancestor of declared head ${block.head.slice(0, 7)}, so the range is not the packet's own work`,
    });
    return { paths: 0, symbols: 0 };
  }

  // PROVENANCE. Filename equality proves only that a record and a block agree
  // with each other; both are in the same file and a copy-and-edit changes both
  // at once. The `Packet:` trailer on the declared head is written at commit
  // time, lives in the object database, and cannot be altered without moving
  // the SHA the block names — so it is an authority independent of the record.
  // `check-review-record.sh` already reads this same trailer.
  const trailer = packetTrailer(git.readCommitMessage(head) ?? '');
  if (trailer !== block.packet) {
    findings.push({
      code: 'RECORD_CLAIM_RANGE_UNOWNED',
      subject: `${block.packet}:${block.head.slice(0, 7)}`,
      message: trailer
        ? `is claimed by \`${block.packet}\` but its declared head carries \`Packet: ${trailer}\`, so the range belongs to another packet`
        : `is claimed by \`${block.packet}\` but its declared head carries no \`Packet:\` trailer, so nothing outside the record says which packet owns the range`,
    });
    return { paths: 0, symbols: 0 };
  }

  let paths = 0;
  for (const path of block.changedPaths) {
    if (git.pathDiffers(base, head, path)) {
      paths += 1;
      continue;
    }
    findings.push({
      code: 'RECORD_CLAIM_PATH_UNCHANGED',
      subject: `${block.packet}:${path}`,
      message: `is claimed as changed work but is byte-identical between ${block.base.slice(0, 7)} and ${block.head.slice(0, 7)} — this is the ux-picker r3 failure`,
    });
  }

  const declared = new Set(block.changedPaths);
  for (const changed of git.executablePathsChanged(base, head)) {
    if (declared.has(changed)) {
      continue;
    }
    findings.push({
      code: 'RECORD_CLAIM_PATH_UNDECLARED',
      subject: `${block.packet}:${changed}`,
      message: `changed between ${block.base.slice(0, 7)} and ${block.head.slice(0, 7)} and the record declares no claim over it`,
    });
  }

  let symbols = 0;
  for (const symbol of block.symbols) {
    const source = git.readBlob(head, symbol.path);
    // Two independent ways a symbol claim can be false, so two diagnostics and
    // two controls. They were one code until review measured that deleting the
    // missing-blob branch alone reded nothing: a claim over a file the head
    // DELETED passed every other assertion, because deletion is a real change
    // and the path was declared.
    if (source === undefined) {
      findings.push({
        code: 'RECORD_CLAIM_SYMBOL_FILE_ABSENT',
        subject: `${block.packet}:${symbol.path}#${symbol.name}`,
        message: `is claimed but ${symbol.path} does not exist at ${block.head.slice(0, 7)}`,
      });
      continue;
    }
    if (declaredNames(symbol.path, source).has(symbol.name)) {
      symbols += 1;
      continue;
    }
    findings.push({
      code: 'RECORD_CLAIM_SYMBOL_ABSENT',
      subject: `${block.packet}:${symbol.path}#${symbol.name}`,
      message: `is claimed but nothing at ${block.head.slice(0, 7)}:${symbol.path} declares it (a name in a comment or a string literal declares nothing)`,
    });
  }

  return { paths, symbols };
}

/** The packet a commit message claims, from its `Packet:` trailer. */
function packetTrailer(message: string): string | undefined {
  return /^Packet:[ \t]*(\S+)[ \t]*$/mu.exec(message)?.[1];
}

/**
 * Top-level names a module DECLARES, read from the TypeScript AST rather than
 * matched in the text. A comment, a string literal, or a call that merely
 * mentions the name produces no declaration and cannot satisfy a claim.
 */
export function declaredNames(
  fileName: string,
  source: string,
): ReadonlySet<string> {
  const parsed = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const names = new Set<string>();

  const addBindingName = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) {
      names.add(name.text);
      return;
    }
    for (const element of name.elements) {
      if (ts.isBindingElement(element)) {
        addBindingName(element.name);
      }
    }
  };

  for (const statement of parsed.statements) {
    if (
      (ts.isFunctionDeclaration(statement) ||
        ts.isClassDeclaration(statement)) &&
      statement.name
    ) {
      names.add(statement.name.text);
    } else if (
      ts.isInterfaceDeclaration(statement) ||
      ts.isTypeAliasDeclaration(statement) ||
      ts.isEnumDeclaration(statement)
    ) {
      names.add(statement.name.text);
    } else if (
      ts.isModuleDeclaration(statement) &&
      ts.isIdentifier(statement.name)
    ) {
      names.add(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        addBindingName(declaration.name);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) {
        names.add(element.name.text);
      }
    }
  }

  return names;
}

// ---------------------------------------------------------------------------
// Family B — record staleness
// ---------------------------------------------------------------------------

function readLedgerIds(
  ledger: MarkdownDocument,
  findings: RecordClaimFinding[],
): ReadonlyMap<string, string> {
  const rows = new Map<string, string>();
  const duplicates = new Set<string>();
  const lines = ledger.text.split('\n');
  let inPacketTable = false;
  let headerSeen = false;
  let statusIndex = -1;

  for (const line of lines) {
    if (LEDGER_HEADER.test(line)) {
      inPacketTable = true;
      headerSeen = true;
      // The Status column is LOCATED, never assumed at a fixed index. It was a
      // hardcoded 4 until review measured that an escaped pipe in an earlier
      // cell shifts every later column, so a stale ratification read the Tier
      // cell, found no `accepted`, and passed.
      statusIndex = splitRow(line).findIndex(
        (cell) => stripMarkdown(cell).toLowerCase() === 'status',
      );
      if (statusIndex === -1) {
        findings.push({
          code: 'RECORD_LEDGER_COLUMN_ABSENT',
          subject: ledger.path,
          message:
            'the packet table header carries no Status column, so every ratification lookup would read some other cell',
        });
      }
      continue;
    }
    if (!line.startsWith('|')) {
      inPacketTable = false;
      continue;
    }
    if (!inPacketTable || statusIndex === -1 || isSeparatorRow(line)) {
      continue;
    }
    const cells = splitRow(line);
    const id = stripMarkdown(cells[0] ?? '');
    const status = stripMarkdown(cells[statusIndex] ?? '');
    if (id.length === 0) {
      continue;
    }
    if (rows.has(id) && !duplicates.has(id)) {
      duplicates.add(id);
      findings.push({
        code: 'RECORD_LEDGER_ID_DUPLICATE',
        subject: id,
        message:
          'appears more than once in the ledger packet table; one packet, one row, and the accepted SHA is immutable once recorded',
      });
    }
    if (!rows.has(id)) {
      rows.set(id, status);
    }
  }

  // Guarded on `statusIndex` so this never co-fires with COLUMN_ABSENT: a table
  // whose Status column is missing already has its own diagnostic, and two
  // codes for one broken tree destroys attribution.
  if (!headerSeen || (statusIndex !== -1 && rows.size === 0)) {
    findings.push({
      code: 'RECORD_LEDGER_TABLE_ABSENT',
      subject: ledger.path,
      message: headerSeen
        ? 'the packet table carries no rows, so ledger-id uniqueness and every ratification lookup read zero input'
        : 'no packet table was found, so ledger-id uniqueness and every ratification lookup read zero input',
    });
  }
  return rows;
}

function checkRatifications(
  input: RecordClaimInput,
  ledgerRows: ReadonlyMap<string, string>,
  findings: RecordClaimFinding[],
): void {
  if (input.adrs.length === 0) {
    findings.push({
      code: 'RECORD_ADR_NONE_SCANNED',
      subject: 'docs/decisions',
      message:
        'no decision records were discovered, so the stale-ratification assertion read zero input',
    });
    return;
  }

  const pinned = new Map(
    input.manifest.unresolvableRatifications.map(({ adr, reason }) => [
      adr,
      reason,
    ]),
  );
  const observedUnresolvable = new Set<string>();

  for (const adr of input.adrs) {
    const status = statusParagraph(adr.text);
    if (!status || !/^proposed\b/iu.test(status)) {
      continue;
    }
    const packet = namedPacket(status, ledgerRows);
    if (!packet) {
      observedUnresolvable.add(basename(adr.path));
      if (!pinned.has(basename(adr.path))) {
        findings.push({
          code: 'RECORD_ADR_PACKET_UNRESOLVED',
          subject: adr.path,
          message: `is proposed but names no packet resolvable to a ledger row, so its ratification cannot be checked: "${truncate(status)}"`,
        });
      }
      continue;
    }
    if (ledgerRows.get(packet)?.startsWith('accepted')) {
      findings.push({
        code: 'RECORD_ADR_RATIFICATION_STALE',
        subject: adr.path,
        message: `is still \`proposed\` on packet \`${packet}\`, which the ledger records as accepted — the ADR's own status line disagrees with the ledger that governs it`,
      });
    }
  }

  for (const [adr, reason] of pinned) {
    if (observedUnresolvable.has(adr)) {
      continue;
    }
    findings.push({
      code: 'RECORD_MANIFEST_PIN_STALE',
      subject: adr,
      message: `is pinned as unresolvable (${reason}) and is no longer observed that way; re-derive the pin rather than keeping it`,
    });
  }
}

function checkRoutings(
  input: RecordClaimInput,
  rowIds: ReadonlySet<string>,
  findings: RecordClaimFinding[],
): number {
  let resolved = 0;
  for (const source of input.routingSources) {
    for (const match of source.text.matchAll(ROUTED_TO)) {
      const target = stripMarkdown(match[1] ?? '');
      if (target.length === 0) {
        continue;
      }
      // A directory is not a document. `routed to `docs/execution`` resolved
      // until this compared the KIND rather than mere existence.
      const namesDocument = [
        target,
        join('docs/execution', target),
        join('docs/decisions', target),
      ].some((candidate) => input.pathKind(candidate) === 'file');
      if (rowIds.has(target) || namesDocument) {
        resolved += 1;
        continue;
      }
      findings.push({
        code: 'RECORD_ROUTING_UNRESOLVED',
        subject: `${source.path}: ${target}`,
        message:
          'is routed to a destination that is neither a tracked row nor a document in this repository — a recorded finding with no owning row is a disposition with no executing gate',
      });
    }
  }
  return resolved;
}

function collectRowIds(
  sources: readonly MarkdownDocument[],
  owningTables: readonly { readonly header: readonly string[] }[],
): { ids: ReadonlySet<string>; matched: ReadonlySet<string> } {
  const rowStart = new RegExp(`^\\|\\s*\\**\`?(${ROW_ID})\`?\\**\\s*\\|`, 'u');
  const wanted = new Map(
    owningTables.map(({ header }) => [signature(header), signature(header)]),
  );
  const ids = new Set<string>();
  const matched = new Set<string>();

  for (const source of sources) {
    const lines = source.text.split('\n');
    // Only rows UNDER a declared owning header count. A header row is itself
    // never a tracked row: its first cell is a column name, and `ID` resolved a
    // routing against the ledger's own header until this excluded it.
    let inOwningTable = false;
    for (const [index, line] of lines.entries()) {
      if (!line.startsWith('|')) {
        inOwningTable = false;
        continue;
      }
      if (isSeparatorRow(lines[index + 1] ?? '')) {
        const key = signature(splitRow(line).map(stripMarkdown));
        inOwningTable = wanted.has(key);
        if (inOwningTable) {
          matched.add(key);
        }
        continue;
      }
      if (!inOwningTable || isSeparatorRow(line)) {
        continue;
      }
      const id = rowStart.exec(line)?.[1];
      if (id) {
        ids.add(id);
      }
    }
  }
  return { ids, matched };
}

function signature(header: readonly string[]): string {
  return header.map((cell) => stripMarkdown(cell).toLowerCase()).join('|');
}

/**
 * The ADR's governing status, from the `Status:` line to the end of its
 * paragraph. Reading the whole paragraph matters: several statuses wrap, and
 * ADR-0050 and ADR-0055 QUOTE the stale wording they corrected, so a check
 * keyed to the phrase rather than to the governing state flags both.
 */
function statusParagraph(text: string): string | undefined {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^\s*Status:/u.test(line));
  if (start === -1) {
    return undefined;
  }
  const paragraph: string[] = [];
  for (let index = start; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (index > start && line.trim().length === 0) {
      break;
    }
    paragraph.push(line);
  }
  return stripMarkdown(paragraph.join(' ').replace(/^\s*Status:/u, ''));
}

/**
 * The packet a proposed ADR is conditional on. Anchors are tried in order and
 * the first candidate that resolves to a ledger row wins; a candidate that
 * resolves to nothing is not a packet name, which is how "proposed by the
 * orchestrator" avoids naming `the` as its packet.
 */
function namedPacket(
  status: string,
  ledgerRows: ReadonlyMap<string, string>,
): string | undefined {
  // The EXPLICIT ratification condition outranks provenance. It was the other
  // way round until review measured a status reading "proposed by packet A;
  // ratified when B is accepted" with A planned and B accepted: the reader
  // bound to A, and the condition the ADR actually states was never tested.
  const ratification = new RegExp(
    `ratified when (${ROW_ID}) is accepted`,
    'iu',
  ).exec(status)?.[1];
  if (ratification) {
    // Present but unresolved stays UNRESOLVED. Falling through to provenance
    // let a typo in the explicit target silently substitute a different packet
    // for the condition the ADR actually states — measured, with the
    // provenance packet `planned` and the real one `accepted`.
    return ledgerRows.has(ratification) ? ratification : undefined;
  }
  const provenance = [
    new RegExp(`proposed by packet (${ROW_ID})`, 'iu'),
    new RegExp(`proposed \\(packet (${ROW_ID})`, 'iu'),
    new RegExp(`proposed by (${ROW_ID})`, 'iu'),
  ];
  const resolved = new Set<string>();
  for (const anchor of provenance) {
    const candidate = anchor.exec(status)?.[1];
    if (candidate && ledgerRows.has(candidate)) {
      resolved.add(candidate);
    }
  }
  return [...resolved][0];
}

// ---------------------------------------------------------------------------
// Repository binding
// ---------------------------------------------------------------------------

export function createGitReader(root: string): GitReader {
  const run = (
    args: readonly string[],
  ): { status: number | null; stdout: string } => {
    const result = spawnSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return { status: result.status, stdout: result.stdout ?? '' };
  };

  return {
    executablePathsChanged(base, head) {
      // `--no-renames` is load-bearing, not decoration. Rename detection is on
      // by default, and it reports a pure rename as the DESTINATION path only —
      // so a packet that renamed an executable file away would leave the
      // vacated path changed, undeclared, and unreported. Measured, not
      // assumed: without this flag `a.ts -> b.ts` prints `b.ts` alone.
      const result = run([
        'diff',
        '--no-renames',
        '--name-only',
        base,
        head,
        '--',
        '.',
        ...NON_EXECUTABLE_PATHSPEC,
      ]);
      if (result.status !== 0) {
        throw new Error(`git diff --name-only ${base}..${head} failed`);
      }
      return result.stdout.split('\n').filter((line) => line.length > 0);
    },
    isAncestor(ancestor, descendant) {
      return (
        run(['merge-base', '--is-ancestor', ancestor, descendant]).status === 0
      );
    },
    pathDiffers(base, head, path) {
      // `--quiet` exits 0 for no difference and 1 for a difference, so the exit
      // status IS the observation. Nothing here reads the working tree.
      const result = run(['diff', '--quiet', base, head, '--', path]);
      if (result.status !== 0 && result.status !== 1) {
        throw new Error(`git diff --quiet ${base}..${head} -- ${path} failed`);
      }
      return result.status === 1;
    },
    readBlob(commit, path) {
      const result = run(['show', `${commit}:${path}`]);
      return result.status === 0 ? result.stdout : undefined;
    },
    readCommitMessage(commit) {
      const result = run(['log', '-1', '--format=%B', commit]);
      return result.status === 0 ? result.stdout : undefined;
    },
    resolveCommit(revision) {
      const result = run([
        'rev-parse',
        '--verify',
        '--quiet',
        `${revision}^{commit}`,
      ]);
      const sha = result.stdout.trim();
      return result.status === 0 && FULL_SHA.test(sha) ? sha : undefined;
    },
  };
}

export function repositoryRoot(): string {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error('record-claim-fidelity must run inside a git repository');
  }
  return result.stdout.trim();
}

export const MANIFEST_PATH =
  'test/architecture/record-claim-fidelity.manifest.json';

export function collectRepositoryInput(root: string): RecordClaimInput {
  const read = (path: string): MarkdownDocument => ({
    path,
    text: readFileSync(resolve(root, path), 'utf8'),
  });
  const markdownIn = (
    directory: string,
    depth: 'flat' | 'recursive',
  ): MarkdownDocument[] => listMarkdown(root, directory, depth).map(read);

  const ledger = read('docs/execution/ledger.md');
  const records = markdownIn('docs/execution/packets', 'flat');
  const adrs = markdownIn('docs/decisions', 'flat').filter(
    ({ path }) => !path.endsWith('ADR-TEMPLATE.md'),
  );

  return {
    adrs,
    git: createGitReader(root),
    ledger,
    manifest: JSON.parse(
      readFileSync(resolve(root, MANIFEST_PATH), 'utf8'),
    ) as RecordClaimManifest,
    pathKind: (candidate) => {
      if (
        !isRepositoryPath(candidate) ||
        !existsSync(resolve(root, candidate))
      ) {
        return 'absent';
      }
      return statSync(resolve(root, candidate)).isFile() ? 'file' : 'directory';
    },
    records,
    // Every narrative document, recursively: routings are recorded in program
    // reviews, rulings and debates as readily as in the queue.
    routingSources: markdownIn('docs', 'recursive'),
    rowIdSources: markdownIn('docs/execution', 'recursive'),
  };
}

function listMarkdown(
  root: string,
  directory: string,
  depth: 'flat' | 'recursive',
): string[] {
  const absolute = resolve(root, directory);
  if (!existsSync(absolute)) {
    return [];
  }
  const found: string[] = [];
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(absolute, entry.name);
    if (entry.isFile() && entry.name.endsWith('.md')) {
      found.push(relative(root, child).split(sep).join('/'));
    } else if (entry.isDirectory() && depth === 'recursive') {
      found.push(...listMarkdown(root, relative(root, child), depth));
    }
  }
  return found.sort();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRepositoryPath(candidate: string): boolean {
  return (
    candidate.length > 0 &&
    !candidate.startsWith('/') &&
    !candidate.includes('\\') &&
    !candidate.split('/').includes('..') &&
    !candidate.split('/').includes('.')
  );
}

/**
 * Markdown table cells, split on UNESCAPED pipes only. `\\|` is a literal pipe
 * inside a cell and does not open the next column; splitting on every `|`
 * shifts every later column by one, which is how a stale ratification read the
 * Tier cell and passed.
 */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let backslashes = 0;
  for (const character of line) {
    if (character === '\\') {
      backslashes += 1;
      current += character;
      continue;
    }
    // PARITY. `\\|` is an escaped pipe; `\\\\|` is an escaped BACKSLASH followed
    // by a real delimiter. Counting only the immediately preceding character
    // merged two cells and moved the Status column, which review measured.
    if (character === '|' && backslashes % 2 === 1) {
      current = `${current.slice(0, -1)}|`;
      backslashes = 0;
      continue;
    }
    backslashes = 0;
    if (character === '|') {
      cells.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  cells.push(current);
  return cells.slice(1, -1);
}

function stripMarkdown(cell: string): string {
  return cell
    .replaceAll('`', '')
    .replaceAll('*', '')
    .replace(/\s+/gu, ' ')
    .trim();
}

function basename(path: string): string {
  return path.split('/').at(-1) ?? path;
}

function truncate(value: string): string {
  return value.length > 120 ? `${value.slice(0, 117)}...` : value;
}

export function formatReport(report: RecordClaimReport): string {
  if (report.findings.length === 0) {
    return `records: OK (${report.recordsScanned} record(s), ${report.declaredPackets.length} declaring: ${report.pathsObserved} claimed path(s) and ${report.symbolsObserved} claimed symbol(s) observed in their frozen trees; ${report.adrsScanned} ADR(s) against ${report.ledgerRows} ledger row(s); ${report.routingsResolved} routing(s) resolved)`;
  }
  const lines = ['records: FAIL', ''];
  for (const finding of report.findings) {
    lines.push(`  ${finding.code}  ${finding.subject}`);
    lines.push(`      ${finding.message}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI — `scripts/check-records.sh` is the operator-facing entry point
// ---------------------------------------------------------------------------

async function main(argv: readonly string[]): Promise<number> {
  const root = repositoryRoot();
  if (argv.includes('--self-test')) {
    const { runRecordClaimControls } =
      await import('./record-claim-fidelity-controls.js');
    const results = runRecordClaimControls(root);
    for (const result of results) {
      process.stdout.write(
        `  ${result.passed ? 'red as required' : 'DID NOT RED   '}  ${result.code}  ${result.title}\n`,
      );
    }
    const failed = results.filter(({ passed }) => !passed);
    if (failed.length > 0) {
      process.stderr.write(
        `check-records self-test: FAIL (${failed.length} of ${results.length} control(s) did not red)\n`,
      );
      return 1;
    }
    process.stdout.write(
      `check-records self-test: OK (${results.length} controls, one per assertion)\n`,
    );
    return 0;
  }

  const report = verifyRecordClaims(collectRepositoryInput(root));
  const text = formatReport(report);
  if (report.findings.length === 0) {
    process.stdout.write(`${text}\n`);
    return 0;
  }
  process.stderr.write(`${text}\n`);
  return 1;
}

// `import.meta` is unavailable under this project's CommonJS emit, so the entry
// point is recognised by the path node was launched with.
const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  resolve(entryPoint).endsWith(`${sep}record-claim-fidelity.ts`)
) {
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
