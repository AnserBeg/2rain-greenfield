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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
  'RECORD_LEDGER_ID_DUPLICATE',
  'RECORD_LEDGER_TABLE_ABSENT',
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
  readonly ledgerRows: number;
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

export interface RecordClaimInput {
  readonly records: readonly MarkdownDocument[];
  readonly ledger: MarkdownDocument;
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
// GFM allows a fence up to three spaces of indentation and any run of three or
// more backticks. The exact `^```` form missed both, so a malformed block in a
// four-backtick or indented fence was not a block at all and escaped every
// validity assertion. Fence syntax is a CLOSED grammar, unlike the English the
// retired Family B readers tried to parse, so widening it here terminates.
const DECLARATION_FENCE =
  /^ {0,3}(`{3,})record-claim[^\S\n]*\n([\s\S]*?)^ {0,3}\1`*[^\S\n]*$/gmu;
/**
 * The ledger packet table, identified STRUCTURALLY by its normalized header.
 * It was a literal source regex until review measured that a second table
 * headed `**ID**` normalized to the same thing for one reader and was invisible
 * to the other — two incompatible definitions of one table. There is now one
 * definition and one reader, so they cannot disagree.
 */
const PACKET_TABLE_SIGNATURE = 'id|packet|stage|tier|status|sha|evidence';
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

  const ledgerIds = readLedgerIds(input.ledger, findings);

  return {
    declaredPackets,
    findings,
    ledgerRows: ledgerIds.size,
    pathsObserved,
    recordsScanned: input.records.length,
    symbolsObserved,
  };
}

// ---------------------------------------------------------------------------
// Family A — claim fidelity
// ---------------------------------------------------------------------------

function declarationBodies(text: string): string[] {
  return [...text.matchAll(DECLARATION_FENCE)].map((match) => match[2] ?? '');
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

  // PROVENANCE, and the claim is exactly as wide as the observation. Filename
  // equality proves only that a record and a block agree with each other; both
  // are in the same file and a copy-and-edit changes both at once. The `Packet:`
  // trailer on the declared head is written at commit time and cannot be altered
  // without moving the SHA the block names, so it is an authority independent of
  // the record. What it establishes is that THE HEAD attests the range under one
  // name and that the head fixes the ancestry — NOT that every commit in the
  // range was authored under it. Review round 3 narrowed this correctly.
  const trailer = packetTrailer(git.readCommitMessage(head) ?? '');
  if (trailer !== block.packet) {
    findings.push({
      code: 'RECORD_CLAIM_RANGE_UNOWNED',
      subject: `${block.packet}:${block.head.slice(0, 7)}`,
      message: trailer
        ? `is claimed by \`${block.packet}\` but its declared head attests \`Packet: ${trailer}\`, so the range is attested to another packet`
        : `is claimed by \`${block.packet}\` but its declared head carries no single \`Packet:\` trailer — zero or contradictory attestations are an authority for no packet`,
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

/**
 * The packet a commit message attests, from its `Packet:` trailer — and only
 * when it attests exactly one. First-match extraction accepted a commit
 * carrying two contradictory trailers, which is an authority for neither.
 */
function packetTrailer(message: string): string | undefined {
  const trailers = [...message.matchAll(/^Packet:[ \t]*(\S+)[ \t]*$/gmu)].map(
    (match) => match[1],
  );
  return new Set(trailers).size === 1 ? trailers[0] : undefined;
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
): ReadonlySet<string> {
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  const lines = ledger.text.split('\n');
  let inPacketTable = false;
  let headerSeen = false;

  for (const [index, line] of lines.entries()) {
    if (!line.startsWith('|')) {
      inPacketTable = false;
      continue;
    }
    // The packet table is recognised STRUCTURALLY, by the normalized header its
    // signature pins. A literal source regex admitted `| ID |` and rejected
    // `| **ID** |`, which gave two readers two different ideas of one table.
    if (isSeparatorRow(lines[index + 1] ?? '')) {
      inPacketTable = signature(splitRow(line)) === PACKET_TABLE_SIGNATURE;
      headerSeen ||= inPacketTable;
      continue;
    }
    if (!inPacketTable || isSeparatorRow(line)) {
      continue;
    }
    const id = stripMarkdown(splitRow(line)[0] ?? '');
    if (id.length === 0) {
      continue;
    }
    if (ids.has(id) && !duplicates.has(id)) {
      duplicates.add(id);
      findings.push({
        code: 'RECORD_LEDGER_ID_DUPLICATE',
        subject: id,
        message:
          'appears more than once in the ledger packet table; one packet, one row, and the accepted SHA is immutable once recorded',
      });
    }
    ids.add(id);
  }

  if (!headerSeen || ids.size === 0) {
    findings.push({
      code: 'RECORD_LEDGER_TABLE_ABSENT',
      subject: ledger.path,
      message: headerSeen
        ? 'the packet table carries no rows, so id uniqueness read zero input'
        : `no table matching the packet-table signature (${PACKET_TABLE_SIGNATURE.split('|').join(' | ')}) was found, so id uniqueness read zero input`,
    });
  }
  return ids;
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

export function collectRepositoryInput(root: string): RecordClaimInput {
  const read = (path: string): MarkdownDocument => ({
    path,
    text: readFileSync(resolve(root, path), 'utf8'),
  });
  return {
    git: createGitReader(root),
    ledger: read('docs/execution/ledger.md'),
    // RECURSIVE. A record moved into a subdirectory was invisible to a flat
    // scan while other records remained, which kept RECORD_CLAIM_NO_RECORDS
    // green on a tree that had lost declarations.
    records: listMarkdown(root, 'docs/execution/packets', 'recursive').map(
      read,
    ),
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

function signature(header: readonly string[]): string {
  return header.map((cell) => stripMarkdown(cell).toLowerCase()).join('|');
}

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

export function formatReport(report: RecordClaimReport): string {
  if (report.findings.length === 0) {
    return `records: OK (${report.recordsScanned} record(s), ${report.declaredPackets.length} declaring: ${report.pathsObserved} claimed path(s) and ${report.symbolsObserved} claimed symbol(s) observed in their frozen trees; ${report.ledgerRows} ledger row(s), ids unique)`;
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
