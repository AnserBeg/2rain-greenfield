import type { IncomingMessage, ServerResponse } from 'node:http';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { StaffIdentity } from './staff-identity.js';
import {
  StaffAccessRefused,
  clientAddress,
  check,
  cookie,
  cookieValue,
  csrf,
  json,
  opaque,
  readJson,
  sameOriginPost,
  secret,
  secureResponse,
  validateRealm,
} from './staff-protocol.js';

const flowCookie = '__Host-identity-flow',
  idCookie = '__Host-identity-session';
const script = `
const form=document.querySelector('form');
const status=document.querySelector('[role=status]');
let reviewed;
let fragment=new URLSearchParams();
const takeFragment=()=>{
  if(!location.hash)return;
  fragment=new URLSearchParams(location.hash.slice(1));
  history.replaceState(null,'',location.pathname);
  status.replaceChildren();
};
takeFragment();
window.addEventListener('hashchange',takeFragment);
const post=async(path,body)=>{
  const res=await fetch(path,{method:'POST',credentials:'same-origin',redirect:'error',
    headers:{'content-type':'application/json','x-erp-csrf':document.querySelector('meta[name=csrf]').content},body:JSON.stringify(body)});
  if(!res.ok) throw new Error('Unable to verify this request. Open the page again to retry.');
  return res.json();
};
form.addEventListener('submit',async event=>{
  event.preventDefault();
  takeFragment();status.replaceChildren();
  const button=event.submitter;button.disabled=true;
  try {
    const action=button.value;
    if(action==='signout'||action==='signout-everywhere'){
      await post('/signout',{everywhere:action==='signout-everywhere'});
      status.textContent='Signed out.';return;
    }
    const fields=Object.fromEntries(new FormData(form));
    if(action==='choices'){
      const choices=await post('/choices',{});
      if(!choices.length){status.textContent='No decisions available.';return;}
      for(const choice of choices){
        const pick=document.createElement('button');pick.type='button';
        pick.textContent=choice.kind+' · '+choice.label;
        pick.addEventListener('click',()=>{form.elements.kind.value=choice.kind;
          form.elements.targets.value=choice.target;form.elements.company.value=choice.company||'';
          reviewed=undefined;document.querySelector('#terms').replaceChildren();status.replaceChildren();});
        status.append(pick);
      }
      return;
    }
    if(action==='review'||action==='decision'){
      const choice={kind:fields.kind,company:fields.company?.trim()||null,
        targets:fields.targets.trim().split(/[\\s,]+/)};
      if(action==='review'){
        reviewed=undefined;
        const result=await post('/review',choice);
        const preview=document.querySelector('#terms');
        preview.replaceChildren();
        const terms=result.terms;
        const paragraph=(parent,label,value)=>{
          const title=document.createElement('dt'),detail=document.createElement('dd');
          title.textContent=label;
          detail.textContent=typeof value==='object'?JSON.stringify(value,null,2):String(value);
          parent.append(title,detail);
        };
        const scope=document.createElement('dl');
        paragraph(scope,'Tenant',terms.tenant);paragraph(scope,'Environment',terms.environment);
        paragraph(scope,'Company',terms.company||'All companies');preview.append(scope);
        for(const item of terms.targets){
          const heading=document.createElement('h2'),facts=document.createElement('dl');
          heading.textContent=terms.kind==='retry'?'Retry suspended workflow':terms.kind==='customize'?'Approve customization':'Approve release';
          preview.append(heading,facts);
          if(item.diff)paragraph(facts,'Proposed changes',item.diff);
          for(const [key,value] of Object.entries(item)){
            if(key!=='diff' && value!==null)paragraph(facts,key.replace(/([a-z])([A-Z])/g,'$1 $2'),value);
          }
        }
        reviewed={...choice,reviewed:result.digest};
        document.querySelector('[value=decision]').disabled=false;
        return;
      }
      if(!reviewed || JSON.stringify(choice)!==JSON.stringify({kind:reviewed.kind,company:reviewed.company,targets:reviewed.targets}))
        throw new Error('Review the selected decisions again.');
      Object.assign(fields,reviewed);
    }
    const invite=action==='decision'?null:fragment.get('invite');
    const options=await post('/begin',{...fields,action,invite,binding:fragment.get('binding')});
    const credential=invite
      ? await navigator.credentials.create({publicKey:PublicKeyCredential.parseCreationOptionsFromJSON(options)})
      : await navigator.credentials.get({publicKey:PublicKeyCredential.parseRequestOptionsFromJSON(options)});
    const result=await post('/finish',{credential:credential.toJSON()});
    if(result.proof){reviewed=undefined;status.textContent='Confirmed. Decision reference '+result.proof;return;}
    if(result.handoff){location.replace(document.body.dataset.erp+'/auth/callback#'+result.handoff);return;}
    if(result.enrolled){status.textContent='Passkey enrolled. ';const a=document.createElement('a');a.href=document.body.dataset.erp;a.textContent='Sign in to the ERP';status.append(a);return;}
    status.textContent=result.invite?'Hand this one-use enrollment link to the verified person.':'Account updated.';
    if(result.invite){const out=document.createElement('input');out.readOnly=true;out.setAttribute('aria-label','Enrollment link');
      out.value=location.origin+'/enroll#invite='+result.invite;status.append(out);}
    if(result.subject) status.append(document.createTextNode(' Staff ID '+result.subject));
  }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
});`;
const style =
  'body{margin:3rem auto;padding:0 1rem;max-width:32rem;font:1rem/1.5 system-ui}label,input,button{display:block}input,button{box-sizing:border-box;min-height:44px;width:100%;margin:.4rem 0 1rem}button{font:inherit}dt{font-weight:600}dd{margin:0 0 .6rem;white-space:pre-wrap;overflow-wrap:anywhere}textarea,select{width:100%;font:inherit}';
const pages: Record<string, [string, string]> = {
  '/': [
    'Staff sign-in',
    '<button value="signin">Sign in with a passkey</button>',
  ],
  '/enroll': [
    'Enroll your passkey',
    '<button value="enroll">Create a passkey</button>',
  ],
  '/decisions': [
    'Review a decision',
    '<button value="choices" formnovalidate>Find pending decisions</button><label>Decision<select name="kind"><option value="release">Approve release</option><option value="customize">Approve customization</option><option value="retry">Retry workflow</option></select></label><label>Preparation IDs or suspended run IDs<textarea name="targets" required></textarea></label><label>Company ID for workflow Retry<input name="company"></label><button value="review">Review terms</button><section id="terms" aria-live="polite"></section><button value="decision" disabled>Confirm with passkey</button>',
  ],
  '/account': [
    'Manage sign-in',
    '<button value="spare">Enroll a spare passkey</button><label>Lost credential ID<input name="subject"></label><button value="revoke-key">Revoke lost passkey</button><button value="signout">Sign out</button><button value="signout-everywhere">Sign out everywhere</button><a href="/staff">Manage staff</a> <a href="/decisions">Review a decision</a>',
  ],
  '/staff': [
    'Manage staff',
    '<label>Staff name<input name="name" maxlength="120"></label><label>Verified recovery contact<input name="contact" maxlength="200"></label><button value="invite">Invite staff member</button><label>Staff ID<input name="subject"></label><label>Reason and attended notice reference<input name="reason" maxlength="200"></label><button value="recover">Recover staff account</button><button value="deactivate">Deactivate staff account</button>',
  ],
};

export function identityHandler(
  identity: StaffIdentity,
  trustedIngress: readonly string[] = [],
) {
  const sourceOf = clientAddress(trustedIngress);
  const r = identity.realm;
  validateRealm(r);
  return async (req: IncomingMessage, res: ServerResponse) => {
    secureResponse(res);
    try {
      check(req.headers.host === new URL(r.identityOrigin).host);
      const url = new URL(req.url ?? '/', r.identityOrigin);
      check(url.origin === r.identityOrigin && !url.search);
      if (req.method === 'GET') {
        if (url.pathname === '/staff.js' || url.pathname === '/staff.css') {
          const js = url.pathname.endsWith('.js');
          res.setHeader('content-type', js ? 'text/javascript' : 'text/css');
          res.end(js ? script : style);
          return;
        }
        const page = Object.hasOwn(pages, url.pathname)
          ? pages[url.pathname]
          : undefined;
        if (!page) {
          res.statusCode = 404;
          res.end();
          return;
        }
        let details = '';
        if (
          url.pathname === '/account' ||
          url.pathname === '/staff' ||
          url.pathname === '/decisions'
        ) {
          const session = cookieValue(req.headers.cookie, idCookie);
          check(session);
          const account = await identity.account(
            session,
            req.headers['sec-fetch-user'] === '?1',
          );
          if (url.pathname === '/staff') check(account.owner);
          details =
            '<p>Staff ID ' +
            account.principal +
            '</p><p>Enrolled passkey references: ' +
            account.keys.join(', ') +
            '</p>' +
            account.recovery
              .map(
                (row) =>
                  '<p>Account recovery for ' +
                  row.subject_id +
                  ' on ' +
                  row.occurred_at.toISOString() +
                  '</p>',
              )
              .join('');
        }
        const flow = secret();
        const cookies = [cookie(flowCookie, flow, 300)];
        const previous = cookieValue(req.headers.cookie, idCookie);
        if (url.pathname === '/' && previous) {
          try {
            await identity.account(previous);
          } catch (error) {
            if (!(error instanceof StaffAccessRefused)) throw error;
            cookies.push(cookie(idCookie, '', 0));
          }
        }
        res.setHeader('set-cookie', cookies);
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="csrf" content="' +
            csrf(flow) +
            '"><title>' +
            page[0] +
            ' · 2rain</title><link rel="stylesheet" href="/staff.css"><script defer src="/staff.js"></script></head><body data-erp="' +
            r.erpOrigin +
            '"><main><h1>' +
            page[0] +
            '</h1>' +
            details +
            '<form>' +
            page[1] +
            '</form><p role="status"></p></main></body></html>',
        );
        return;
      }
      if (
        req.method === 'POST' &&
        ['/exchange', '/end-session'].includes(url.pathname)
      ) {
        // Backchannel only. The browser verifier stays on the ERP host.
        check(!req.headers.origin && !req.headers['sec-fetch-site']);
        const input = await readJson(req);
        if (url.pathname === '/end-session') {
          await identity.signout(
            opaque(input.session),
            input.everywhere === true,
            'erp',
          );
          json(res, { done: true });
          return;
        }
        json(res, {
          session: await identity.redeem(
            opaque(input.handoff),
            opaque(input.verifier),
            input.oldErp ? opaque(input.oldErp) : undefined,
          ),
        });
        return;
      }
      sameOriginPost(req, r.identityOrigin);
      const flow = cookieValue(req.headers.cookie, flowCookie);
      check(flow && req.headers['x-erp-csrf'] === csrf(flow));
      if (['/begin', '/finish', '/review', '/choices'].includes(url.pathname)) {
        await identity.spend('source', sourceOf(req), 30);
      }
      const input = await readJson(req);
      if (url.pathname === '/review' || url.pathname === '/choices') {
        const identityCookie = cookieValue(req.headers.cookie, idCookie);
        check(identityCookie);
        json(
          res,
          url.pathname === '/choices'
            ? await identity.choices(identityCookie)
            : await identity.review(input, identityCookie),
        );
        return;
      }
      if (url.pathname === '/begin') {
        json(
          res,
          await identity.begin(
            flow,
            input,
            cookieValue(req.headers.cookie, idCookie),
          ),
        );
        return;
      }
      const previous = cookieValue(req.headers.cookie, idCookie);
      if (url.pathname === '/finish') {
        const result = await identity.finish(
          flow,
          input.credential as
            AuthenticationResponseJSON | RegistrationResponseJSON,
          previous,
        );
        if ('identity' in result && result.identity) {
          res.setHeader('set-cookie', [
            cookie(idCookie, result.identity, 43200),
            cookie(flowCookie, '', 0),
          ]);
          json(res, { handoff: result.handoff });
          return;
        }
        json(res, result);
        return;
      }
      if (url.pathname === '/signout') {
        check(previous);
        await identity.signout(previous, input.everywhere === true);
        res.setHeader('set-cookie', [
          cookie(idCookie, '', 0),
          cookie(flowCookie, '', 0),
        ]);
        json(res, { done: true });
        return;
      }
      res.statusCode = 404;
      res.end();
    } catch {
      res.statusCode = 403;
      json(res, { message: 'Staff access could not be verified.' });
    }
  };
}
