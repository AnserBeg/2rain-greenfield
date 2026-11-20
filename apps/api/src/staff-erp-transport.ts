import type { Pool } from 'pg';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  check,
  attemptBucket,
  clientAddress,
  cookie,
  cookieValue,
  csrf,
  digest,
  json,
  opaque,
  readJson,
  sameOriginPost,
  secret,
  secureResponse,
  validateRealm,
  type StaffRealm,
} from './staff-protocol.js';

const flowCookie = '__Host-erp-flow';
const loginCookie = '__Host-erp-login';
export const sessionCookie = '__Host-erp-session';
const callbackScript = `const handoff=location.hash.slice(1);history.replaceState(null,'','/auth/callback');
fetch('/auth/callback',{method:'POST',credentials:'same-origin',redirect:'error',headers:{'content-type':'application/json','x-erp-csrf':document.querySelector('meta[name=csrf]').content},body:JSON.stringify({handoff})})
.then(res=>{if(!res.ok)throw new Error();location.replace('/');}).catch(()=>{document.body.textContent='Sign-in expired. ';const a=document.createElement('a');a.href='/auth/signin';a.textContent='Sign in again';document.body.append(a);});`;

async function backchannel(
  r: StaffRealm,
  path: '/exchange' | '/end-session',
  body: Record<string, unknown>,
  ca?: Buffer,
): Promise<Record<string, unknown>> {
  const result = await new Promise<string>((resolve, reject) => {
    const req = httpsRequest(
      new URL(path, r.identityOrigin),
      {
        method: 'POST',
        ca,
        signal: AbortSignal.timeout(5000),
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let value = '';
        res.setEncoding('utf8');
        res.on('data', (text: string) => {
          value += text;
          if (value.length > 1024) res.destroy(new Error('handoff refused'));
        });
        res.on('error', reject);
        res.on('end', () =>
          res.statusCode === 200
            ? resolve(value)
            : reject(new Error('handoff refused')),
        );
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  return JSON.parse(result) as Record<string, unknown>;
}
async function csrfForm(req: IncomingMessage, handle: string) {
  check(
    req.headers['content-type']?.split(';')[0] ===
      'application/x-www-form-urlencoded',
  );
  let payload = '';
  for await (const part of req) {
    payload += String(part);
    check(payload.length <= 512);
  }
  const form = new URLSearchParams(payload);
  check(form.get('_csrf') === csrf(handle));
  return form;
}
export function erpTransport(
  r: StaffRealm,
  pool: Pool,
  rateKey: Buffer,
  trustedIngress: readonly string[] = [],
  ca?: Buffer,
) {
  validateRealm(r);
  check(rateKey.length >= 32);
  const sourceOf = clientAddress(trustedIngress);
  return async (req: IncomingMessage, res: ServerResponse) => {
    secureResponse(res);
    check(req.headers.host === new URL(r.erpOrigin).host);
    const url = new URL(req.url ?? '/', r.erpOrigin);
    check(url.origin === r.erpOrigin);
    const handle = cookieValue(req.headers.cookie, sessionCookie);
    if (req.method === 'GET' && url.pathname === '/auth/callback.js') {
      res.setHeader('content-type', 'text/javascript');
      res.end(callbackScript);
      return null;
    }
    if (url.pathname === '/auth/callback') {
      const verifier = cookieValue(req.headers.cookie, loginCookie);
      check(verifier);
      if (req.method === 'GET') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><title>Signing in</title><meta name="csrf" content="' +
            csrf(verifier) +
            '"><body><script src="/auth/callback.js"></script></body>',
        );
        return null;
      }
      sameOriginPost(req, r.erpOrigin);
      check(req.headers['x-erp-csrf'] === csrf(verifier));
      const input = await readJson(req);
      const session = opaque(
        (
          await backchannel(
            r,
            '/exchange',
            { handoff: opaque(input.handoff), verifier, oldErp: handle },
            ca,
          )
        ).session,
      );
      res.setHeader('set-cookie', [
        cookie(sessionCookie, session, 43200),
        cookie(loginCookie, '', 0),
      ]);
      json(res, { done: true });
      return null;
    }
    if (
      req.method === 'GET' &&
      (url.pathname === '/auth/signin' || (!handle && url.pathname === '/'))
    ) {
      const flow = cookieValue(req.headers.cookie, flowCookie) ?? secret();
      res.setHeader('set-cookie', cookie(flowCookie, flow, 300));
      // The same-origin form may follow its POST redirect to the fixed identity origin.
      secureResponse(res, r.identityOrigin);
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(
        '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Staff sign-in</title></head><body><main><h1>Staff sign-in</h1><form method="post" action="/auth/signin"><input type="hidden" name="_csrf" value="' +
          csrf(flow) +
          '"><button>Continue to staff sign-in</button></form></main></body></html>',
      );
      return null;
    }
    if (url.pathname === '/auth/signin') {
      sameOriginPost(req, r.erpOrigin);
      const flow = cookieValue(req.headers.cookie, flowCookie);
      check(flow);
      await csrfForm(req, flow);
      const bucket = attemptBucket(rateKey, 'erp-login', sourceOf(req));
      const verifier = secret();
      const binding = digest(verifier);
      const { rows } = await pool.query<{ keep: boolean }>(
        'SELECT platform.staff_start_login($1,$2,$3,$4,$5) AS keep',
        [
          r.tenantId,
          r.environmentId,
          binding,
          handle ? digest(handle) : null,
          bucket,
        ],
      );
      const cookies = [
        cookie(loginCookie, verifier, 300),
        cookie(flowCookie, '', 0),
      ];
      if (handle && !rows[0]?.keep) cookies.push(cookie(sessionCookie, '', 0));
      res.setHeader('set-cookie', cookies);
      res.writeHead(303, {
        location:
          r.identityOrigin + '/#binding=' + binding.toString('base64url'),
      });
      res.end();
      return null;
    }
    check(handle);
    if (req.method !== 'GET') sameOriginPost(req, r.erpOrigin);
    if (req.method === 'POST' && url.pathname === '/auth/signout') {
      const form = await csrfForm(req, handle);
      await backchannel(
        r,
        '/end-session',
        { session: handle, everywhere: form.get('everywhere') === 'true' },
        ca,
      );
      res.setHeader('set-cookie', cookie(sessionCookie, '', 0));
      res.writeHead(303, { location: '/auth/signin' });
      res.end();
      return null;
    }
    return { csrf: csrf(handle), identityOrigin: r.identityOrigin };
  };
}
