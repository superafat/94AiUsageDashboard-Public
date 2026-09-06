import http from 'node:http';
import { spawn } from 'node:child_process';
import type { CredentialStore } from './credential-store';

export const FIREBASE_REFRESH_TOKEN_ACCOUNT = 'firebase-refresh-token';
export const LOCAL_LOGIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://www.gstatic.com https://apis.google.com",
  "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://accounts.google.com https://apis.google.com",
  "frame-src https://*.firebaseapp.com https://accounts.google.com https://apis.google.com",
  "img-src 'self' data: https://*.gstatic.com https://*.googleusercontent.com",
  "style-src 'self' 'unsafe-inline'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

export interface AgentAuthConfig {
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    appId: string;
  };
}

export interface FirebaseSession {
  uid: string;
  idToken: string;
  refreshToken: string;
}

export interface AuthenticatedFirebaseContext {
  uid: string;
  idToken: string;
  close: () => Promise<void>;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`missing agent configuration: ${name}`);
  return value;
}

export function loadAgentAuthConfig(env: Record<string, string | undefined>): AgentAuthConfig {
  const projectId = env.FIREBASE_PROJECT_ID ?? env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error('missing agent configuration: FIREBASE_PROJECT_ID');
  return {
    firebase: {
      apiKey: required(env, 'VITE_FIREBASE_API_KEY'),
      authDomain: required(env, 'VITE_FIREBASE_AUTH_DOMAIN'),
      projectId,
      appId: required(env, 'VITE_FIREBASE_APP_ID'),
    },
  };
}

const FIREBASE_SAFE_ERRORS = new Set([
  'INVALID_REFRESH_TOKEN', 'TOKEN_EXPIRED', 'USER_DISABLED', 'USER_NOT_FOUND',
  'INVALID_ID_TOKEN', 'INVALID_CREDENTIAL', 'OPERATION_NOT_ALLOWED',
  'INVALID_API_KEY', 'API_KEY_INVALID', 'TOO_MANY_ATTEMPTS_TRY_LATER',
  'CREDENTIAL_MISMATCH', 'INVALID_GRANT', 'PROJECT_NOT_FOUND',
]);

function firebaseErrorCode(payload: Record<string, unknown>): string {
  const error = payload.error;
  const message = error && typeof error === 'object' && 'message' in error ? error.message : undefined;
  return typeof message === 'string' && FIREBASE_SAFE_ERRORS.has(message) ? message : 'UNKNOWN_ERROR';
}

function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

export function buildFirebaseLoginPage(config: AgentAuthConfig): string {
  const firebaseConfig = jsonForScript(config.firebase);
  return `<!doctype html>
<html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>94AiUsageDashboard 登入</title><style>body{font-family:system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:24px;background:#fffaf3;color:#2d211c}button{min-height:52px;padding:0 20px;border:0;border-radius:12px;background:#b8762e;color:white;font-weight:700;font-size:16px}#status{margin-top:18px;line-height:1.5}</style></head>
<body><h1>AI 額度儀表板</h1><p>請用和手機網站相同的 Google 帳號登入。完成後這台 Mac 就能自動同步額度。</p><button id="signin" autofocus>使用 Google 登入</button><p id="status">等待登入…</p>
<script type="module">
import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js';
import { getAuth, GoogleAuthProvider, signInWithPopup } from 'https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js';
const app=initializeApp(${firebaseConfig}); const auth=getAuth(app); const status=document.querySelector('#status'); const button=document.querySelector('#signin');
const report=async(error)=>{try{await fetch('/diagnostic',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code:String(error?.code??'unknown')})});}catch{}};
button.addEventListener('click',async()=>{try{button.disabled=true; status.textContent='登入中…'; const result=await signInWithPopup(auth,new GoogleAuthProvider()); const credential=GoogleAuthProvider.credentialFromResult(result); if(!credential?.idToken) throw new Error('Google ID token unavailable'); status.textContent='登入成功，正在交給 Mac…'; const response=await fetch('/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uid:result.user.uid,googleIdToken:credential.idToken})}); if(!response.ok){const detail=await response.text().catch(()=> ''); throw new Error(detail||'local handoff failed');} status.textContent='登入完成，可以關閉此頁面。'; button.hidden=true;}catch(error){button.disabled=false; await report(error); status.textContent='登入未完成，請關閉此頁後重新執行設定，並使用相同的 Google 帳號。';}});
</script></body></html>`;
}

export async function exchangeGoogleIdToken(
  config: AgentAuthConfig,
  googleIdToken: string,
  requestUri: string,
  fetchImpl: FetchLike = fetch,
): Promise<FirebaseSession> {
  const postBody = new URLSearchParams({ id_token: googleIdToken, providerId: 'google.com' }).toString();
  const response = await fetchImpl(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${encodeURIComponent(config.firebase.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ postBody, requestUri, returnIdpCredential: true, returnSecureToken: true }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = firebaseErrorCode(payload);
    throw new Error(`Firebase identity exchange failed: ${error.slice(0, 120)}`);
  }
  if (typeof payload.idToken !== 'string' || typeof payload.refreshToken !== 'string' || typeof payload.localId !== 'string') {
    throw new Error('Firebase identity exchange returned an invalid response');
  }
  return { uid: payload.localId, idToken: payload.idToken, refreshToken: payload.refreshToken };
}

export async function refreshFirebaseSession(
  config: AgentAuthConfig,
  refreshToken: string,
  fetchImpl: FetchLike = fetch,
): Promise<FirebaseSession> {
  const response = await fetchImpl(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(config.firebase.apiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
  });
  const payload = await response.json() as Record<string, unknown>;
  if (!response.ok) {
    const error = firebaseErrorCode(payload);
    throw new Error(`Firebase session refresh failed: ${error.slice(0, 120)}`);
  }
  if (typeof payload.id_token !== 'string' || typeof payload.refresh_token !== 'string' || typeof payload.user_id !== 'string') {
    throw new Error('Firebase session refresh returned an invalid response');
  }
  return { uid: payload.user_id, idToken: payload.id_token, refreshToken: payload.refresh_token };
}

async function openBrowser(url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('/usr/bin/open', [url], { stdio: 'ignore' });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error('failed to open browser')));
  });
}

async function readJsonBody(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 32_768) throw new Error('login response too large');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

export async function loginWithGoogle(config: AgentAuthConfig, store: CredentialStore): Promise<string> {
  let complete!: (uid: string) => void;
  let fail!: (error: Error) => void;
  const completion = new Promise<string>((resolve, reject) => { complete = resolve; fail = reject; });
  let finished = false;

  const server = http.createServer(async (request, response) => {
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('login server unavailable');
      const origin = `http://localhost:${address.port}`;
      const url = new URL(request.url ?? '/', origin);
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy': LOCAL_LOGIN_CSP,
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        }).end(buildFirebaseLoginPage(config));
        return;
      }
      if (request.method === 'POST' && url.pathname === '/complete') {
        if (request.headers.origin && request.headers.origin !== origin) throw new Error('invalid login origin');
        const body = await readJsonBody(request);
        if (typeof body.uid !== 'string' || typeof body.googleIdToken !== 'string' || body.googleIdToken.length < 20) {
          throw new Error('invalid login response');
        }
        const session = await exchangeGoogleIdToken(config, body.googleIdToken, `${origin}/`);
        if (session.uid !== body.uid) throw new Error('Firebase user mismatch');
        const verified = await refreshFirebaseSession(config, session.refreshToken);
        if (verified.uid !== body.uid) throw new Error('Firebase refresh verification mismatch');
        await store.set(FIREBASE_REFRESH_TOKEN_ACCOUNT, verified.refreshToken);
        const stored = await store.get(FIREBASE_REFRESH_TOKEN_ACCOUNT);
        if (stored !== verified.refreshToken) throw new Error('Keychain credential round-trip mismatch');
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end('{"ok":true}');
        if (!finished) { finished = true; complete(session.uid); }
        return;
      }
      if (request.method === 'POST' && url.pathname === '/diagnostic') {
        if (request.headers.origin && request.headers.origin !== origin) throw new Error('invalid diagnostic origin');
        const body = await readJsonBody(request);
        const code = typeof body.code === 'string' && /^auth\/[a-z-]{1,70}$/.test(body.code) ? body.code : 'unknown';
        console.error(`Firebase login diagnostic: ${code}`);
        response.writeHead(204, { 'cache-control': 'no-store' }).end();
        return;
      }
      response.writeHead(404).end('Not found');
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Firebase login failed')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
        .replace(/(?:access|refresh|id)[_-]?token\s*[=:]\s*\S+/gi, '[credential redacted]')
        .slice(0, 180);
      console.error(`Firebase login handoff failed: ${message}`);
      response.writeHead(400, { 'content-type': 'application/json', 'cache-control': 'no-store' })
        .end(JSON.stringify({ ok: false, error: message }));
      if (!finished) { finished = true; fail(new Error(message)); }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('login server failed to start');
  const timer = setTimeout(() => {
    if (!finished) { finished = true; fail(new Error('Firebase login timed out')); }
  }, 180_000);
  try {
    await openBrowser(`http://localhost:${address.port}/`);
    return await completion;
  } finally {
    clearTimeout(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

export async function createAuthenticatedFirebaseContext(
  config: AgentAuthConfig,
  store: CredentialStore,
): Promise<AuthenticatedFirebaseContext> {
  const stored = await store.get(FIREBASE_REFRESH_TOKEN_ACCOUNT);
  if (!stored) throw new Error('not logged in; run the login command first');
  const session = await refreshFirebaseSession(config, stored);
  if (session.refreshToken !== stored) await store.set(FIREBASE_REFRESH_TOKEN_ACCOUNT, session.refreshToken);
  return { uid: session.uid, idToken: session.idToken, close: async () => undefined };
}
