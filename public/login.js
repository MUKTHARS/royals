(() => {
  const form = document.getElementById('login-form');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');
  const pw = document.getElementById('password');
  const toggle = document.getElementById('toggle-pw');

  toggle.addEventListener('click', () => {
    const show = pw.type === 'password';
    pw.type = show ? 'text' : 'password';
    toggle.textContent = show ? 'Hide' : 'Show';
    toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.hidden = true;
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email || !password) {
      errorEl.textContent = 'Enter your email and password.';
      errorEl.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        window.location.replace('/dashboard');
        return;
      }
      const data = await res.json().catch(() => ({}));
      errorEl.textContent = data.error || 'Sign in failed.';
      errorEl.hidden = false;
      form.password.value = '';
      form.password.focus();
    } catch {
      errorEl.textContent = 'Network error. Check your connection.';
      errorEl.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign in';
    }
  });
})();
