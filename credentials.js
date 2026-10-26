// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// The W3C login, kept in `chrome.storage.local` so the background can log in
// again before the session runs out. The username stays readable so the
// options page can show it; the password is sealed with an AES-GCM key that
// is non-extractable and lives in this extension's IndexedDB, so the password
// never sits on disk in plain text next to its key material.

const DB_NAME = 'dory';
const STORE = 'keys';
const KEY_ID = 'credentials';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idb(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function getKey() {
  const db = await openDb();
  let key = await idb(db, 'readonly', (s) => s.get(KEY_ID));
  if (!key) {
    key = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
    await idb(db, 'readwrite', (s) => s.put(key, KEY_ID));
  }
  db.close();
  return key;
}

const toBase64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromBase64 = (text) =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

export async function setCredentials({ username, password }) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await getKey(),
    new TextEncoder().encode(password),
  );
  await chrome.storage.local.set({
    credentials: { username, iv: toBase64(iv), password: toBase64(sealed) },
  });
}

export async function getCredentials() {
  const { credentials } = await chrome.storage.local.get('credentials');
  if (!credentials) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(credentials.iv) },
      await getKey(),
      fromBase64(credentials.password),
    );
    return {
      username: credentials.username,
      password: new TextDecoder().decode(plain),
    };
  } catch {
    // The key is gone (site data cleared), so the sealed password is useless.
    await clearCredentials();
    return null;
  }
}

export async function getUsername() {
  const { credentials } = await chrome.storage.local.get('credentials');
  return credentials?.username ?? null;
}

export async function clearCredentials() {
  await chrome.storage.local.remove('credentials');
}
