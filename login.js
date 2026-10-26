// SPDX-FileCopyrightText: 2026 Thomas Steiner
// SPDX-License-Identifier: Apache-2.0

// Runs on auth.w3.org/login. With stored credentials the background logs in
// and moves the tab on, so this page only flashes by. Without them, it ticks
// "Remember me", makes sure the server session points at this tab's target
// right before you submit, and hands what you typed (or what the password
// manager filled in) to the background for next time.
(async () => {
  const form = document.querySelector('form[action="/login"]');
  if (!form) return;
  const username = form.querySelector('[name="_username"]');
  const password = form.querySelector('[name="_password"]');
  const remember = form.querySelector('[name="_remember_me"]');

  // A rejected attempt renders the form again with an error: let a person
  // take over, so a stale password does not retry in a loop.
  const error = !!document.querySelector('.note--error');
  const status = banner('Signing you in…');
  const reply = await chrome.runtime.sendMessage({ type: 'login-page', error });
  if (reply?.handled) return;
  status.remove();

  if (remember && !remember.checked) remember.checked = true;

  let primed = false;
  form.addEventListener('submit', async (event) => {
    if (primed) return;
    event.preventDefault();
    // Another tab may have overwritten the target, or the PHP session may
    // have expired while this page sat open. Either way, this puts it back.
    if (reply?.target) {
      await fetch(`/?url=${encodeURIComponent(reply.target)}`, {
        credentials: 'same-origin',
      }).catch(() => {});
    }
    if (reply?.capture && username.value && password.value) {
      await chrome.runtime.sendMessage({
        type: 'credentials',
        username: username.value,
        password: password.value,
      });
    }
    primed = true;
    form.requestSubmit(event.submitter);
  });

  // Nothing stored yet: ask the browser's password manager, through the
  // Credential Management API, for the login it saved for this site.
  if (!reply?.credentials && !error && 'PasswordCredential' in window) {
    try {
      const saved = await navigator.credentials.get({
        password: true,
        mediation: 'optional',
      });
      if (saved?.password) {
        username.value = saved.id;
        password.value = saved.password;
        form.requestSubmit();
      }
    } catch {}
  }

  function banner(text) {
    const note = document.createElement('p');
    note.textContent = text;
    note.className = 'l-box note';
    note.setAttribute('role', 'status');
    form.before(note);
    return note;
  }
})();
