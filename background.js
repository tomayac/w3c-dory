// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// How W3C login works (observed October 2026):
//
// - A protected page redirects to `https://auth.w3.org/?url=<target>`, which
//   stores `<target>` in a PHP session (`PHPSESSID`, a session cookie on
//   auth.w3.org) and redirects to `/login`. After a successful POST to
//   `/login`, the server reads the target back from that session. If the
//   session is gone by then (idle timeout, browser restart, restored tab), or
//   another tab started a login in between, you land on the "You are logged
//   in" page and the target is lost.
// - The login itself is the `w3csess` cookie on `.w3.org`: hex of
//   `<user>:<unix expiry>:<32-byte MAC>`. The expiry is 28 days after login
//   and is signed into the value, so extending the cookie's lifetime does
//   nothing. The server never re-issues it. Without "Remember me" the cookie
//   is also a session cookie and dies with the browser.
//
// So: log in again in the background before the signed expiry, and make sure
// the server session holds the right target at the moment you submit.

import { getCredentials, getUsername, setCredentials } from './credentials.js';

const AUTH = 'https://auth.w3.org';
const COOKIE = 'w3csess';
// Returns the account as JSON when logged in, `[]` when not.
const PROBE = 'https://www.w3.org/account/user-menu/';
const RENEW_BEFORE = 7 * 24 * 3600 * 1000;
const targetKey = (tabId) => `target:${tabId}`;

// ── The session token ───────────────────────────────────────────────────

function parseToken(value) {
  if (!/^([0-9a-f]{2})+$/i.test(value ?? '')) return null;
  const text = value.replace(/../g, (h) =>
    String.fromCharCode(parseInt(h, 16)),
  );
  const [user, expiry] = text.split(':');
  const expires = Number(expiry) * 1000;
  return Number.isFinite(expires) ? { user, expires } : null;
}

async function getToken() {
  const cookie = await chrome.cookies.get({
    url: 'https://www.w3.org/',
    name: COOKIE,
  });
  return cookie && parseToken(cookie.value);
}

// ── Logging in from the background ──────────────────────────────────────

let pending = null;

// One login at a time: a burst of tabs hitting the login page shares it.
function renew(reason) {
  pending ??= login(reason).finally(() => (pending = null));
  return pending;
}

async function login(reason) {
  const credentials = await getCredentials();
  if (!credentials) return finish({ ok: false, error: 'no-credentials' });
  // While a valid token is around, auth.w3.org skips the login and never
  // issues a fresh one, so set it aside and put it back if the login fails.
  const old = await chrome.cookies.get({
    url: 'https://www.w3.org/',
    name: COOKIE,
  });
  if (old)
    await chrome.cookies.remove({ url: 'https://www.w3.org/', name: COOKIE });
  const result = await attempt(credentials);
  if (!result.ok && old && !(await getToken())) await restore(old);
  return finish({ ...result, reason });
}

async function attempt({ username, password }) {
  try {
    // Prime the server session with a target, as a protected page would.
    await fetch(`${AUTH}/?url=${encodeURIComponent(PROBE)}`, {
      credentials: 'include',
    });
    const response = await fetch(`${AUTH}/login`, {
      method: 'POST',
      credentials: 'include',
      body: new URLSearchParams({
        _username: username,
        _password: password,
        _remember_me: 'on',
      }),
    });
    if (response.status === 429) return { ok: false, error: 'rate-limited' };
    if (response.url === PROBE) {
      const account = await response.json();
      if (account?.email) return { ok: true };
    }
    // Back on the login form means the server rejected the password; anywhere
    // else on auth.w3.org is a second-factor prompt only a person can answer.
    const error = new URL(response.url).pathname.startsWith('/login')
      ? 'bad-credentials'
      : 'second-factor';
    return { ok: false, error, at: response.url };
  } catch (e) {
    return { ok: false, error: 'network', detail: String(e) };
  }
}

function restore(cookie) {
  return chrome.cookies.set({
    url: 'https://www.w3.org/',
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    storeId: cookie.storeId,
    expirationDate: cookie.expirationDate,
  });
}

async function finish(result) {
  const last = { ...result, time: Date.now() };
  await chrome.storage.local.set({ last });
  chrome.action.setBadgeText({ text: result.ok ? '' : '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#b00020' });
  return last;
}

async function mayAutoLogin() {
  const { loggedOut, last } = await chrome.storage.local.get([
    'loggedOut',
    'last',
  ]);
  // After a rejected password, wait for new credentials to avoid a lockout.
  return !loggedOut && last?.error !== 'bad-credentials';
}

async function check() {
  if (!(await getUsername()) || !(await mayAutoLogin())) return;
  const token = await getToken();
  if (!token || token.expires - Date.now() < RENEW_BEFORE) {
    await renew(token ? 'expiring' : 'missing');
  }
}

chrome.alarms.onAlarm.addListener((a) => a.name === 'check' && check());
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('check', { periodInMinutes: 6 * 60 });
  check();
});
chrome.runtime.onStartup.addListener(check);

// A login without "Remember me" leaves a session cookie that dies with the
// browser. Give it the lifetime the server signed into it anyway.
chrome.cookies.onChanged.addListener(({ cookie, removed }) => {
  if (removed || cookie.name !== COOKIE || !cookie.session) return;
  const token = parseToken(cookie.value);
  if (!token) return;
  chrome.cookies.set({
    url: `https://${cookie.domain.replace(/^\./, '')}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: cookie.sameSite,
    storeId: cookie.storeId,
    expirationDate: token.expires / 1000,
  });
});

// ── Remembering where you wanted to go ──────────────────────────────────

// A tab heads for `auth.w3.org/`, by redirect, link, or button: note where it
// was going. The `url` parameter is not always there: the "Log in to
// subscribe" button on event pages is a GET form, and submitting one replaces
// the query in its `action`, so it arrives as a bare `auth.w3.org/?`. The
// header's "Sign in" link on the login page points back at the login page.
// In both cases the page the tab is leaving is the better guess.
chrome.webRequest.onBeforeRequest.addListener(
  async (d) => {
    if (d.tabId < 0 || d.method !== 'GET') return;
    if (new URL(d.url).pathname !== '/') return;
    let target = new URL(d.url).searchParams.get('url');
    if (!isTarget(target)) {
      const tab = await chrome.tabs.get(d.tabId).catch(() => null);
      target = tab?.url;
    }
    if (isTarget(target)) {
      await chrome.storage.session.set({ [targetKey(d.tabId)]: target });
    }
  },
  { urls: [`${AUTH}/*`], types: ['main_frame'] },
);

function isTarget(url) {
  if (!URL.canParse(url ?? '')) return false;
  const { protocol, hostname, origin } = new URL(url);
  return (
    protocol === 'https:' && /(^|\.)w3\.org$/.test(hostname) && origin !== AUTH
  );
}

chrome.webRequest.onBeforeRedirect.addListener(
  async (d) => {
    if (d.tabId < 0) return;
    const to = new URL(d.redirectUrl);
    if (to.origin !== AUTH) return;
    const target = to.searchParams.get('url');

    // The login went through, but the server forgot the target.
    const lost =
      d.method === 'POST' &&
      !target &&
      (to.pathname === '/' || to.pathname === '/loggedin');
    if (lost) {
      const k = targetKey(d.tabId);
      const { [k]: saved } = await chrome.storage.session.get(k);
      if (saved) chrome.tabs.update(d.tabId, { url: saved });
    }
  },
  { urls: ['https://*.w3.org/*'], types: ['main_frame'] },
);

// Once the tab is somewhere other than the auth pages, the trip is over.
chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0 && new URL(d.url).origin !== AUTH) {
    chrome.storage.session.remove(targetKey(d.tabId));
  }
});
chrome.tabs.onRemoved.addListener((tabId) =>
  chrome.storage.session.remove(targetKey(tabId)),
);

// An explicit logout pauses automatic logins until you log in by hand again.
// Logins that come from a tab are yours; the background's own have no tab.
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.method !== 'POST' || d.tabId < 0) return;
    const { pathname } = new URL(d.url);
    if (pathname === '/logout') chrome.storage.local.set({ loggedOut: true });
    if (pathname === '/login') chrome.storage.local.set({ loggedOut: false });
  },
  { urls: [`${AUTH}/login*`, `${AUTH}/logout*`] },
);

// ── Messages from the login page and the options page ───────────────────

async function onLoginPage(tabId, { error }) {
  const k = targetKey(tabId);
  const { [k]: target } = await chrome.storage.session.get(k);
  const { capture = true } = await chrome.storage.local.get('capture');
  const credentials = !!(await getCredentials());
  if (error || !credentials || !(await mayAutoLogin())) {
    return { handled: false, target, credentials, capture };
  }
  const result = await renew('login-page');
  if (!result.ok) return { handled: false, target, credentials, capture };
  chrome.tabs.update(tabId, { url: target ?? `${AUTH}/loggedin` });
  return { handled: true, target };
}

async function onMessage(message, sender) {
  switch (message.type) {
    case 'login-page':
      return onLoginPage(sender.tab.id, message);
    case 'credentials': {
      const { capture = true } = await chrome.storage.local.get('capture');
      if (!capture) return;
      await setCredentials(message);
      // The page reports its own outcome: forget a stale rejection.
      await chrome.storage.local.remove('last');
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    case 'renew':
      await chrome.storage.local.remove('last');
      await chrome.storage.local.set({ loggedOut: false });
      return renew('manual');
    case 'status': {
      const { credentials, ...state } = await chrome.storage.local.get();
      return {
        token: await getToken(),
        username: credentials?.username,
        ...state,
      };
    }
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  onMessage(message, sender).then(sendResponse);
  return true;
});

chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
