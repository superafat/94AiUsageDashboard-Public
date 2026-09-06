import { describe, expect, it } from 'vitest';
import { buildFirebaseLoginPage, exchangeGoogleIdToken, loadAgentAuthConfig, LOCAL_LOGIN_CSP, refreshFirebaseSession } from './auth';

describe('agent Firebase auth helpers', () => {
  const config = loadAgentAuthConfig({
    VITE_FIREBASE_API_KEY: 'public-api-key',
    VITE_FIREBASE_AUTH_DOMAIN: 'demo.firebaseapp.com',
    FIREBASE_PROJECT_ID: 'demo',
    VITE_FIREBASE_APP_ID: 'app-id',
  });

  it('requires only Firebase public config and no separate Desktop OAuth client', () => {
    expect(config.firebase.projectId).toBe('demo');
    expect(JSON.stringify(config)).not.toMatch(/googleClient|clientSecret|refreshToken/i);
  });

  it('builds a localhost Firebase Google sign-in page without embedding credentials', () => {
    const html = buildFirebaseLoginPage(config);
    expect(html).toContain('signInWithPopup');
    expect(html).toContain("fetch('/complete'");
    expect(html).toContain('credentialFromResult');
    expect(html).toContain('googleIdToken');
    expect(html).toContain('demo.firebaseapp.com');
    expect(html).not.toMatch(/refresh[_-]?token\s*[:=]\s*["'][A-Za-z0-9]/i);
  });


  it('exchanges a short-lived Google ID token for Firebase credentials', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({
        idToken: 'firebase-id-token', refreshToken: 'firebase-refresh-token', localId: 'alice', expiresIn: '3600',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const session = await exchangeGoogleIdToken(config, 'google-id-token', 'http://localhost:54321', fakeFetch);
    expect(session).toEqual({ uid: 'alice', idToken: 'firebase-id-token', refreshToken: 'firebase-refresh-token' });
    expect(calls[0]?.url).toContain('identitytoolkit.googleapis.com/v1/accounts:signInWithIdp');
    expect(calls[0]?.body).toContain('google.com');
    expect(calls[0]?.body).toContain('google-id-token');
  });

  it('refreshes a Firebase session with the secure token endpoint and accepts rotation', async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? '') });
      return new Response(JSON.stringify({
        id_token: 'firebase-id-token', refresh_token: 'rotated-refresh', user_id: 'alice', expires_in: '3600',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const session = await refreshFirebaseSession(config, 'stored-refresh', fakeFetch);
    expect(session).toEqual({ uid: 'alice', idToken: 'firebase-id-token', refreshToken: 'rotated-refresh' });
    expect(calls[0]?.url).toContain('securetoken.googleapis.com');
    expect(calls[0]?.body).toContain('grant_type=refresh_token');
    expect(calls[0]?.body).toContain('refresh_token=stored-refresh');
  });


  it('surfaces only the Firebase refresh error code on failure', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'INVALID_REFRESH_TOKEN' } }), {
      status: 400, headers: { 'content-type': 'application/json' },
    });
    await expect(refreshFirebaseSession(config, 'secret-refresh-value', fakeFetch)).rejects.toThrow('INVALID_REFRESH_TOKEN');
  });


  it('keeps localhost login CSP narrow while allowing Firebase popup helpers', () => {
    expect(LOCAL_LOGIN_CSP).toContain("default-src 'self'");
    expect(LOCAL_LOGIN_CSP).toContain('https://www.gstatic.com');
    expect(LOCAL_LOGIN_CSP).toContain('https://apis.google.com');
    expect(LOCAL_LOGIN_CSP).toContain('https://*.firebaseapp.com');
    expect(LOCAL_LOGIN_CSP).toContain("object-src 'none'");
  });

  it('uses popup sign-in so localhost does not depend on cross-origin redirect storage', () => {
    const html = buildFirebaseLoginPage(config);
    expect(html).toContain('signInWithPopup');
    expect(html).toContain('credentialFromResult');
    expect(html).not.toContain('signInWithRedirect');
    expect(html).not.toContain('getRedirectResult');
  });

  it('never includes raw credentials from Firebase error payloads in thrown errors', async () => {
    const fakeFetch = async () => new Response(JSON.stringify({ error: { message: 'invalid token private-credential-value' } }), { status: 400 });
    await expect(refreshFirebaseSession(config, 'secret-refresh', fakeFetch)).rejects.toThrow('UNKNOWN_ERROR');
    await expect(exchangeGoogleIdToken(config, 'short-google-id', 'http://localhost:1234/', fakeFetch)).rejects.toThrow('UNKNOWN_ERROR');
  });

  it('does not send raw error messages or stacks to the diagnostic endpoint', () => {
    const html = buildFirebaseLoginPage(config);
    expect(html).not.toContain('stack:');
    expect(html).not.toContain('message:String(error');
    expect(html).not.toContain('console.error(error)');
  });

});
