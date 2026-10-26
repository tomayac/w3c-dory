// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

import { clearCredentials, setCredentials } from './credentials.js';

const ERRORS = {
  'no-credentials': 'No credentials stored.',
  'bad-credentials': 'W3C rejected the stored password.',
  'second-factor':
    'Your account asks for a second factor, so log in by hand when it expires.',
  'rate-limited': 'Too many logins for now. Trying again in a few hours.',
  network: 'Could not reach auth.w3.org.',
};

const $ = (selector) => document.querySelector(selector);
const when = (time) =>
  new Date(time).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });

async function render() {
  const s = await chrome.runtime.sendMessage({ type: 'status' });
  const rows = [
    ['Logged in as', s.token ? s.token.user : 'Not logged in'],
    ['Session ends', s.token ? when(s.token.expires) : '–'],
    ['Automatic login', s.loggedOut ? 'Paused, since you logged out' : 'On'],
  ];
  if (s.last) {
    rows.push([
      'Last attempt',
      `${when(s.last.time)}: ${s.last.ok ? 'OK' : (ERRORS[s.last.error] ?? s.last.error)}`,
      !s.last.ok,
    ]);
  }
  $('#status').replaceChildren(
    ...rows.flatMap(([term, value, bad]) => {
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = term;
      dd.textContent = value;
      dd.classList.toggle('error', !!bad);
      return [dt, dd];
    }),
  );
  $('#stored').textContent = s.username
    ? `Stored login: ${s.username}`
    : 'No login stored yet. Enter it here, or just log in on the W3C site once.';
  $('#capture').checked = s.capture ?? true;
}

$('#credentials').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  await setCredentials({
    username: form.username.value,
    password: form.password.value,
  });
  form.reset();
  await chrome.runtime.sendMessage({ type: 'renew' });
  render();
});

$('#forget').addEventListener('click', async () => {
  await clearCredentials();
  render();
});

$('#renew').addEventListener('click', async () => {
  $('#renew').disabled = true;
  await chrome.runtime.sendMessage({ type: 'renew' });
  $('#renew').disabled = false;
  render();
});

$('#capture').addEventListener('change', (event) =>
  chrome.storage.local.set({ capture: event.target.checked }),
);

render();
