import { isIP, SocketAddress } from 'node:net';
import { getDomain } from 'tldts';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type pg from 'pg';
import type { IncomingMessage, ServerResponse } from 'node:http';
export interface StaffRealm {
  readonly tenantId: string;
  readonly environmentId: string;
  readonly identityOrigin: string;
  readonly erpOrigin: string;
  readonly rpId: string;
}

export class StaffAccessRefused extends Error {
  constructor() {
    super('Staff access could not be verified.');
  }
}

export function secret(): string {
  return randomBytes(32).toString('base64url');
}
export function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
export function csrf(handle: string): string {
  return createHmac('sha256', handle)
    .update('staff-browser-post/v1')
    .digest('base64url');
}
export function check(value: unknown): asserts value {
  if (!value) throw new StaffAccessRefused();
}
export function opaque(value: unknown): string {
  check(typeof value === 'string' && /^[a-zA-Z0-9_-]{43}$/u.test(value));
  return value;
}
export async function assertPilotDatabase(
  pool: pg.Pool,
  role: string,
  r: StaffRealm,
) {
  const { rows } = await pool.query<{ safe: boolean }>(
    `SELECT current_user=$1 AND session_user=$1 AND
    NOT (rolsuper OR rolbypassrls OR rolinherit OR rolcreaterole OR rolcreatedb OR rolreplication)
    AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname='north_star_fixture_proof_issuer')
    AND NOT EXISTS (SELECT FROM pg_roles r WHERE (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole
      OR r.rolname IN ('north_star_identity','north_star_activation_verifier','north_star_workflow_verifier','north_star_module_materializer'))
      AND r.rolname <> current_user AND pg_has_role(current_user,r.oid,'MEMBER'))
    AND NOT EXISTS (SELECT FROM pg_roles accessible WHERE EXISTS (
      SELECT FROM pg_roles caller WHERE caller.rolname IN ('north_star_runtime','north_star_workflow_worker')
        AND pg_has_role(caller.oid,accessible.oid,'MEMBER'))
      AND (accessible.rolname IN ('north_star_identity','north_star_activation_verifier','north_star_workflow_verifier')
        OR has_any_column_privilege(accessible.oid,'platform.release_approvals','INSERT')
        OR has_any_column_privilege(accessible.oid,'platform.release_activation_verification_receipts','INSERT')
        OR has_any_column_privilege(accessible.oid,'platform.release_activation_swap_receipts','INSERT')
        OR has_any_column_privilege(accessible.oid,'platform.active_release_pointers','UPDATE')
        OR has_function_privilege(accessible.oid,'platform.workflow_decide_approval(uuid,integer,bigint,text,text)','EXECUTE')))
    AS safe FROM pg_roles WHERE rolname=current_user`,
    [role],
  );
  check(rows[0]?.safe);
  check(
    (
      await pool.query(
        'SELECT platform.staff_realm_configured($1,$2,$3,$4,$5) AS configured',
        [r.tenantId, r.environmentId, r.rpId, r.identityOrigin, r.erpOrigin],
      )
    ).rows[0]?.configured,
  );
}

export function validateRealm(realm: StaffRealm) {
  const erp = new URL(realm.erpOrigin),
    id = new URL(realm.identityOrigin);
  for (const [url, origin] of [
    [erp, realm.erpOrigin],
    [id, realm.identityOrigin],
  ] as const)
    check(url.origin === origin && url.protocol === 'https:');
  check(
    erp.hostname !== id.hostname &&
      (id.hostname === realm.rpId || id.hostname.endsWith('.' + realm.rpId)),
  );
  check(
    realm.rpId === 'localhost' ||
      getDomain(realm.rpId, { allowPrivateDomains: true }) === realm.rpId,
  );
}
export function cookieValue(
  header: string | readonly string[] | undefined,
  name: string,
) {
  if (typeof header !== 'string') return undefined;
  const items = header
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.startsWith(name + '='));
  return items.length === 1 &&
    /^[\w-]{43}$/u.test(items[0]!.slice(name.length + 1))
    ? items[0]!.slice(name.length + 1)
    : undefined;
}
export function cookie(name: string, value: string, maxAge: number) {
  return (
    name +
    '=' +
    value +
    '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' +
    String(maxAge)
  );
}
function canonicalAddress(address: unknown) {
  check(typeof address === 'string' && !address.includes('%'));
  const version = isIP(address);
  check(version);
  if (version === 4) return address;
  const canonical = new SocketAddress({ address, family: 'ipv6' }).address;
  return canonical.startsWith('::ffff:') && isIP(canonical.slice(7)) === 4
    ? canonical.slice(7)
    : canonical;
}

export function clientAddress(trustedIngress: readonly string[]) {
  const ingress = new Set(trustedIngress.map(canonicalAddress));
  return (req: IncomingMessage) => {
    const peer = canonicalAddress(req.socket.remoteAddress);
    return ingress.has(peer)
      ? canonicalAddress(req.headers['x-real-ip'])
      : peer;
  };
}

export function attemptBucket(
  key: Buffer,
  category: string,
  identifier: string,
) {
  return createHmac('sha256', key)
    .update(category)
    .update('\0')
    .update(identifier)
    .digest();
}

export function sameOriginPost(req: IncomingMessage, origin: string) {
  check(req.method === 'POST' && req.headers.host === new URL(origin).host);
  const source = req.headers.origin,
    site = req.headers['sec-fetch-site'];
  check(
    (source === origin || (!source && site === 'same-origin')) &&
      (!site || site === 'same-origin'),
  );
}
export function secureResponse(
  res: ServerResponse,
  formRedirectOrigin?: string,
) {
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader(
    'content-security-policy',
    "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" +
      (formRedirectOrigin ? ' ' + formRedirectOrigin : ''),
  );
}
export async function readJson(req: IncomingMessage) {
  check(req.headers['content-type']?.split(';')[0] === 'application/json');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const part = Buffer.from(chunk);
    bytes += part.length;
    check(bytes <= 65536);
    chunks.push(part);
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  check(typeof body === 'object' && body !== null && !Array.isArray(body));
  return body as Record<string, unknown>;
}
export function json(res: ServerResponse, value: unknown) {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
}
