// NetWatch — 2FA TOTP setup & management

// 2FA TOTP management
// ══════════════════════════════════════════════════════════════════════════════

async function load2FAStatus() {
  try {
    const r = await fetch('/api/2fa/status');
    const d = await r.json();
    const enabled = d.enabled;
    document.getElementById('fa2StatusBadge').textContent = enabled ? '🟢 Включена' : '🔴 Отключена';
    document.getElementById('fa2StatusBadge').style.color = enabled ? 'var(--green)' : 'var(--red)';
    document.getElementById('fa2Disabled').style.display = enabled ? 'none' : 'block';
    document.getElementById('fa2Enabled').style.display  = enabled ? 'block' : 'none';
    document.getElementById('fa2Setup').style.display    = 'none';
  } catch(e) {}
}

async function fa2StartSetup() {
  const r = await fetch('/api/2fa/setup', {method: 'POST'});
  const d = await r.json();
  if (!d.secret) return;
  document.getElementById('fa2SecretDisplay').textContent = d.secret;
  document.getElementById('fa2Disabled').style.display = 'none';
  document.getElementById('fa2Setup').style.display    = 'block';
  document.getElementById('fa2ConfirmCode').value = '';
  document.getElementById('fa2SetupStatus').textContent = '';
  // Draw QR code on canvas
  _drawQR(d.uri, document.getElementById('fa2QrCanvas'));
  document.getElementById('fa2ConfirmCode').focus();
}

async function fa2Confirm() {
  const code = document.getElementById('fa2ConfirmCode').value.trim();
  const st   = document.getElementById('fa2SetupStatus');
  if (code.length !== 6) { st.textContent = 'Введите 6-значний код'; st.style.color = 'var(--red)'; return; }
  st.textContent = '⟳ Проверяем...'; st.style.color = 'var(--muted)';
  const r = await fetch('/api/2fa/confirm', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code})
  });
  const d = await r.json();
  if (d.ok) {
    st.style.color = 'var(--green)';
    st.textContent = '✅ 2FA успішно увімкнено!';
    setTimeout(() => load2FAStatus(), 1500);
  } else {
    st.style.color = 'var(--red)';
    st.textContent = '❌ ' + (d.error || 'Невірний код');
    document.getElementById('fa2ConfirmCode').value = '';
    document.getElementById('fa2ConfirmCode').focus();
  }
}

function fa2CancelSetup() {
  document.getElementById('fa2Setup').style.display    = 'none';
  document.getElementById('fa2Disabled').style.display = 'block';
}

async function fa2Disable() {
  const code = document.getElementById('fa2DisableCode').value.trim();
  const st   = document.getElementById('fa2DisableStatus');
  st.textContent = '⟳ Проверяем...'; st.style.color = 'var(--muted)';
  const r = await fetch('/api/2fa/disable', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({code})
  });
  const d = await r.json();
  if (d.ok) {
    st.style.color = 'var(--green)';
    st.textContent = '✅ 2FA відключена';
    setTimeout(() => load2FAStatus(), 1200);
  } else {
    st.style.color = 'var(--red)';
    st.textContent = '❌ ' + (d.error || 'Помилка');
    document.getElementById('fa2DisableCode').value = '';
  }
}

// 2FA status loaded in _loadSettingsAll below

// ── QR code renderer (pure Canvas, no libs) ──────────────────────────────────
// Minimal QR encoder for otpauth:// URIs using a CDN-free approach:
// We render the URI as a data matrix via the open qr-code-styling approach.
// Since we can't use external libs, we use a simple workaround:
// Render the URI as a Google Charts API URL (works offline via canvas img)
// OR use the goqr.me service as fallback img.
function _drawQR(uri, canvas) {
  const ctx  = canvas.getContext('2d');
  const size = canvas.width;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  // Use a public QR API (internet required) via img element
  const img = new Image();
  const encoded = encodeURIComponent(uri);
  // Try Google Charts API (still works for QR generation)
  img.src = `https://chart.googleapis.com/chart?cht=qr&chs=${size}x${size}&chl=${encoded}&choe=UTF-8`;
  img.onload = () => {
    ctx.drawImage(img, 0, 0, size, size);
  };
  img.onerror = () => {
    // Fallback: show text if QR API unavailable
    ctx.fillStyle = '#111827';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#4a5568';
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillText('QR недоступен.', size/2, size/2 - 10);
    ctx.fillText('Введите секрет вручную.', size/2, size/2 + 10);
  };
}

// ══════════════════════════════════════════════════════════════════════════════
