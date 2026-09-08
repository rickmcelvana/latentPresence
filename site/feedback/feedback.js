document.getElementById('feedback-form').addEventListener('submit', async (e) => {
  e.preventDefault();

  const form = e.target;
  const status = document.getElementById('form-status');
  const submitBtn = form.querySelector('button[type="submit"]');

  const payload = {
    // Which product this report is about. Must stay in step with `normalize_source`
    // in the feedback API; anything else lands as 'unknown' and is unactionable.
    source: 'presence',
    kind: form.kind.value,
    message: form.message.value,
    email: form.email.value || null,
    _hp: form._hp.value,
    user_agent: navigator.userAgent,
    screen_width: window.innerWidth,
    screen_height: window.innerHeight,
  };

  if (!payload.message.trim()) {
    status.textContent = 'Please describe what happened before sending.';
    status.className = 'form-status error';
    return;
  }

  submitBtn.disabled = true;
  status.textContent = '';
  status.className = 'form-status';

  try {
    const res = await fetch('/api/feedback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.status === 429) {
      status.textContent = "You've sent a few of these recently -- give it a bit and try again.";
      status.className = 'form-status error';
    } else if (res.ok) {
      status.textContent = 'Thanks -- got it. We read every report.';
      status.className = 'form-status success';
      form.reset();
    } else {
      status.textContent = 'Something went wrong sending that. Please try again in a moment.';
      status.className = 'form-status error';
    }
  } catch {
    status.textContent = 'Could not reach the server. Check your connection and try again.';
    status.className = 'form-status error';
  } finally {
    submitBtn.disabled = false;
  }
});
