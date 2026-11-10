(() => {
  const $ = (id) => document.getElementById(id);
  const tbody = $('members-body');
  const dialog = $('member-dialog');
  const form = $('member-form');
  const formError = $('form-error');
  const feeBox = $('f-fee');
  const feeStatus = $('f-fee-status');

  const state = {
    members: [],
    month: null, // month being viewed, 'YYYY-MM'
    currentMonth: null, // current calendar month (from server, gym time zone)
    today: null,
  };
  let editing = null; // member being edited, or null when adding
  let loadSeq = 0;

  // ---------- API ----------
  async function api(path, options = {}) {
    const res = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    });
    if (res.status === 401) {
      window.location.replace('/');
      throw new Error('Session expired');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  // ---------- Helpers ----------
  function fmtDate(s) {
    if (!s) return '';
    const [y, m, d] = s.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  function fmtMonth(ym) {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  }

  function fmtMobile(n) {
    return /^\d{10}$/.test(n) ? `${n.slice(0, 5)} ${n.slice(5)}` : n;
  }

  function cleanMobile(v) {
    return v.replace(/[\s()-]/g, '').replace(/^(\+?91|0)(?=\d{10}$)/, '');
  }

  function shiftMonth(ym, delta) {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else if (v !== false && v != null) node.setAttribute(k, v);
    }
    for (const c of children) if (c != null) node.append(c);
    return node;
  }

  let toastTimer;
  function toast(msg, isError = false) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.toggle('toast-error', isError);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 3000);
  }

  function upsert(m) {
    const i = state.members.findIndex((x) => x.id === m.id);
    const belongs = m.join_date.slice(0, 7) <= state.month;
    if (i === -1 && belongs) state.members.unshift(m);
    else if (i !== -1 && belongs) state.members[i] = m;
    else if (i !== -1) state.members.splice(i, 1);
    render();
  }

  // ---------- Render ----------
  function renderMonthBar() {
    const isCurrent = state.month === state.currentMonth;
    $('month-label').textContent = fmtMonth(state.month);
    $('download-pdf').href = `/api/reports/fees.pdf?month=${state.month}`; // report for the month on screen
    $('next-month').disabled = isCurrent;
    $('prev-month').disabled = state.month <= state.feesStartMonth;
    $('this-month').hidden = isCurrent;
    document.querySelector('.month-bar').classList.toggle('past-month', !isCurrent);
    $('fees-th').textContent = `Fees · ${fmtMonth(state.month).split(' ')[0]}`;
    $('stat-paid').previousElementSibling.textContent = isCurrent ? 'Paid this month' : 'Paid';
    $('stat-unpaid').previousElementSibling.textContent = isCurrent ? 'Pending this month' : 'Pending';
  }

  // ---------- Search (matches any field) ----------
  // Status words are pulled out of the query first, so "paid" never matches "not paid".
  // Order matters: longer phrases are checked before the shorter words inside them.
  const STATUS_TERMS = [
    [/\bnot\s*paid\b|\bunpaid\b|\bpending\b/, (m) => !m.fee_paid],
    [/\bnot\s*coming\b|\babsent\b/, (m) => !m.attending],
    [/\bno\s*dues?\b|\bpaid\s*up\b/, (m) => !(m.dues > 0)],
    [/\bmonths?\s*dues?\b|\bdues?\b/, (m) => m.dues > 0],
    [/\bpaid\b|\breceived\b/, (m) => m.fee_paid],
    [/\bcoming\b|\bpresent\b/, (m) => m.attending],
  ];

  const compact = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const searchCache = new WeakMap(); // member object -> searchable text

  function searchText(m) {
    let text = searchCache.get(m);
    if (text) return text;
    const [y, mo, d] = m.join_date.split('-');
    const joined = new Date(Number(y), Number(mo) - 1, Number(d));
    const parts = [
      m.name,
      m.card_no,
      compact(m.card_no), // "E-123" also findable as "e123"
      m.mobile,
      fmtMobile(m.mobile),
      `age ${m.age}`,
      // Joining date in the formats people type
      m.join_date,
      `${d}/${mo}/${y}`,
      `${Number(d)}/${Number(mo)}/${y}`,
      `${d}-${mo}-${y}`,
      `${d}.${mo}.${y}`,
      `${d}${mo}${y}`,
      `${y}${mo}${d}`,
      fmtDate(m.join_date),
      joined.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' }),
      m.fee_paid_on ? `${m.fee_paid_on} ${fmtDate(m.fee_paid_on)}` : '',
    ];
    text = ` ${parts.join(' | ').toLowerCase()} `;
    searchCache.set(m, text);
    return text;
  }

  function parseSearch(raw) {
    let text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
    const checks = [];
    if (!text) return { checks, tokens: [] };

    // "3 months due" -> exactly 3 months due
    const dueCount = text.match(/\b(\d+)\s*months?\s*dues?\b/);
    if (dueCount) {
      checks.push((m) => m.dues === Number(dueCount[1]));
      text = text.replace(dueCount[0], ' ');
    }
    for (const [re, check] of STATUS_TERMS) {
      if (re.test(text)) {
        checks.push(check);
        text = text.replace(new RegExp(re.source, 'g'), ' ');
      }
    }
    text = text.replace(/\s+/g, ' ').trim();

    // Phone-style input ("+91 98765 43210", "98765-43210") -> one digit string without +91 / 0 prefix.
    if (/^[\d\s+()-]+$/.test(text) && text.replace(/\D/g, '').length >= 5) {
      return { checks, tokens: [cleanMobile(text.replace(/[^\d+]/g, ''))] };
    }
    // Card-number style input ("E 45", "e-45", "e45") -> one token, so the number isn't matched against ages etc.
    if (/^[a-z]{1,2}[\s-]*\d+$/.test(text)) {
      return { checks, tokens: [compact(text)] };
    }
    // Otherwise every word must match some field, in any order ("kumar ravi" finds "Ravi Kumar").
    return { checks, tokens: text.split(' ').filter(Boolean) };
  }

  function matchesSearch(m, search) {
    if (!search.checks.every((check) => check(m))) return false;
    if (!search.tokens.length) return true;
    const text = searchText(m);
    return search.tokens.every((t) => text.includes(t) || (compact(t) && text.includes(compact(t))));
  }

  function render() {
    const { members } = state;
    const search = parseSearch($('search').value);
    const fee = $('filter-fee').value;
    const att = $('filter-att').value;

    $('stat-total').textContent = members.length;
    $('stat-paid').textContent = members.filter((m) => m.fee_paid).length;
    $('stat-unpaid').textContent = members.filter((m) => !m.fee_paid).length;
    $('stat-coming').textContent = members.filter((m) => m.attending).length;

    const list = members.filter((m) => {
      if (!matchesSearch(m, search)) return false;
      if (fee === 'paid' && !m.fee_paid) return false;
      if (fee === 'unpaid' && m.fee_paid) return false;
      if (fee === 'dues' && !(m.dues > 0)) return false;
      if (att === 'coming' && !m.attending) return false;
      if (att === 'not' && m.attending) return false;
      return true;
    });

    tbody.replaceChildren(...list.map(rowFor));
    $('loading').hidden = true;
    const empty = $('empty');
    empty.hidden = list.length > 0;
    empty.textContent = members.length
      ? 'No members match your search or filters.'
      : state.month === state.currentMonth
        ? 'No members yet. Click “+ Add member” to add the first one.'
        : `No members had joined by ${fmtMonth(state.month)}.`;
  }

  function rowFor(m) {
    const feeCheckbox = el('input', {
      type: 'checkbox',
      checked: m.fee_paid,
      disabled: m.fee_paid, // paid is final — cannot be unticked
      'aria-label': `Fees received from ${m.name} for ${fmtMonth(state.month)}`,
      onchange: (e) => markPaid(m, e.target),
    });

    const feeCell = el(
      'td',
      { 'data-label': 'Fees' },
      el(
        'div',
        { class: 'fee-cell' },
        el('label', { class: 'check check-inline' }, feeCheckbox, el('span', { text: 'Received' })),
        el('span', { class: `badge ${m.fee_paid ? 'badge-paid' : 'badge-unpaid'}`, text: m.fee_paid ? 'Paid' : 'Not paid' })
      ),
      m.fee_paid ? el('div', { class: 'sub', text: `on ${fmtDate(m.fee_paid_on)}` }) : null,
      el('button', {
        type: 'button',
        class: `dues-link ${m.dues > 0 ? 'has-dues' : 'no-dues'}`,
        text: m.dues > 0 ? `${m.dues} month${m.dues > 1 ? 's' : ''} due` : 'No dues',
        title: 'Open fee history',
        onclick: () => openHistory(m),
      })
    );

    const attBtn = el('button', {
      type: 'button',
      class: `pill ${m.attending ? 'pill-on' : 'pill-off'}`,
      'aria-pressed': String(m.attending),
      title: 'Click to change',
      text: m.attending ? 'Coming' : 'Not coming',
      onclick: (e) => toggleAttendance(m, e.currentTarget),
    });

    return el(
      'tr',
      {},
      el('td', { 'data-label': 'Card no.', class: 'card-no', text: m.card_no }),
      el('td', { 'data-label': 'Name', class: 'name', text: m.name }),
      el(
        'td',
        { 'data-label': 'Mobile', class: 'mobile' },
        m.mobile ? el('a', { href: `tel:+91${m.mobile}`, text: fmtMobile(m.mobile) }) : el('span', { class: 'sub', text: '—' })
      ),
      el('td', { 'data-label': 'Age', text: String(m.age) }),
      el('td', { 'data-label': 'Joined', text: fmtDate(m.join_date) }),
      feeCell,
      el('td', { 'data-label': 'Attendance' }, attBtn),
      el(
        'td',
        { class: 'actions' },
        el('button', { type: 'button', class: 'icon-btn', text: 'History', onclick: () => openHistory(m) }),
        el('button', { type: 'button', class: 'icon-btn', text: 'Edit', onclick: () => openDialog(m) }),
        el('button', { type: 'button', class: 'icon-btn danger', text: 'Delete', onclick: () => removeMember(m) })
      )
    );
  }

  // ---------- Actions ----------
  async function load(month) {
    const seq = ++loadSeq;
    $('loading').hidden = false;
    $('loading').textContent = 'Loading…';
    try {
      const data = await api(`/api/members${month ? `?month=${month}` : ''}`);
      if (seq !== loadSeq) return; // a newer month was requested meanwhile
      Object.assign(state, {
        members: data.members,
        month: data.month,
        currentMonth: data.currentMonth,
        today: data.today,
        feesStartMonth: data.feesStartMonth,
      });
      renderMonthBar();
      render();
    } catch (err) {
      if (seq === loadSeq) $('loading').textContent = err.message;
    }
  }

  async function recordPayment(memberId, month, confirmation) {
    return api(`/api/members/${memberId}/payments`, {
      method: 'POST',
      body: JSON.stringify({ month, confirm: confirmation.word, paid_on: confirmation.paidOn }),
    });
  }

  // ---------- "Type RECEIVED" confirmation ----------
  const payDialog = $('pay-dialog');
  const payInput = $('pay-input');
  const payDate = $('pay-date');
  const payOk = $('pay-ok');
  let payResolve = null;

  const isReceived = (v) => v.trim().toLowerCase() === 'received';
  const payValid = () =>
    isReceived(payInput.value) && /^\d{4}-\d{2}-\d{2}$/.test(payDate.value) && payDate.value <= payDate.max && payDate.value >= payDate.min;

  // Asks for the date received + typed RECEIVED.
  // Resolves with { word, paidOn } when confirmed, or null if cancelled.
  function askReceived(name, month, joinDate) {
    $('pay-name').textContent = name;
    $('pay-month').textContent = `Fees for ${fmtMonth(month)}`;
    payDate.max = state.today;
    payDate.min = joinDate || '2000-01-01';
    // Current month: assume received today. Past months: admin picks the real date.
    payDate.value = month === state.currentMonth ? state.today : '';
    payInput.value = '';
    payInput.classList.remove('match');
    payOk.disabled = true;
    payDialog.showModal();
    (payDate.value ? payInput : payDate).focus();
    return new Promise((resolve) => (payResolve = resolve));
  }

  function finishPay(value) {
    const resolve = payResolve;
    payResolve = null;
    if (payDialog.open) payDialog.close();
    if (resolve) resolve(value);
  }

  function updatePayState() {
    payInput.classList.toggle('match', isReceived(payInput.value));
    payOk.disabled = !payValid();
  }
  payInput.addEventListener('input', updatePayState);
  payDate.addEventListener('input', updatePayState);
  $('pay-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (payValid()) finishPay({ word: payInput.value.trim(), paidOn: payDate.value });
  });
  $('pay-cancel').addEventListener('click', () => finishPay(null));
  payDialog.addEventListener('close', () => finishPay(null)); // Esc key

  async function markPaid(m, box) {
    const monthName = fmtMonth(state.month);
    box.checked = false; // stays unticked until the server confirms
    const confirmation = await askReceived(m.name, state.month, m.join_date);
    if (!confirmation) return;
    box.disabled = true;
    try {
      upsert(await recordPayment(m.id, state.month, confirmation));
      toast(`${monthName} fees received from ${m.name}`);
    } catch (err) {
      box.checked = false;
      box.disabled = false;
      toast(err.message, true);
    }
  }

  // ---------- Fee history (all months for one member) ----------
  const historyDialog = $('history-dialog');
  let historyMember = null;

  function monthsBetween(from, to) {
    const out = [];
    for (let m = from; m <= to; m = shiftMonth(m, 1)) out.push(m);
    return out;
  }

  async function openHistory(m) {
    historyMember = m;
    $('history-title').textContent = m.name;
    $('history-sub').textContent = `${m.card_no} · joined ${fmtDate(m.join_date)}`;
    $('history-summary').textContent = 'Loading…';
    $('history-grid').replaceChildren();
    if (!historyDialog.open) historyDialog.showModal();
    try {
      renderHistory(await api(`/api/members/${m.id}/payments`));
    } catch (err) {
      $('history-summary').textContent = err.message;
    }
  }

  function renderHistory(data) {
    historyMember = data.member;
    const paid = new Map(data.payments.map((p) => [p.month, p.paid_on]));
    const months = monthsBetween(data.firstMonth, data.currentMonth);
    const due = months.filter((mo) => !paid.has(mo)).length;

    $('history-summary').textContent = months.length
      ? `${months.length - due} of ${months.length} months paid` + (due ? ` · ${due} due` : ' · all paid up')
      : 'No fee months yet.';
    $('history-summary').classList.toggle('has-dues', due > 0);

    const cells = months.map((mo) => {
      const paidOn = paid.get(mo);
      return el(
        'div',
        { class: `hcell ${paidOn ? 'hcell-paid' : 'hcell-due'}` },
        el('div', { class: 'hcell-month', text: fmtMonth(mo) }),
        paidOn
          ? el('div', {}, el('span', { class: 'badge badge-paid', text: 'Paid' }), el('div', { class: 'sub', text: `on ${fmtDate(paidOn)}` }))
          : el(
              'div',
              {},
              el('span', { class: 'badge badge-unpaid', text: 'Not paid' }),
              el('button', {
                type: 'button',
                class: 'btn btn-primary btn-sm hcell-btn',
                text: 'Mark received',
                onclick: () => markPaidFromHistory(mo),
              })
            )
      );
    });
    $('history-grid').replaceChildren(...cells);
  }

  async function markPaidFromHistory(month) {
    const m = historyMember;
    const confirmation = await askReceived(m.name, month, m.join_date);
    if (!confirmation) return;
    try {
      await recordPayment(m.id, month, confirmation);
      toast(`${fmtMonth(month)} fees received from ${m.name}`);
      await openHistory(m);
      load(state.month); // refresh list counts and dues
    } catch (err) {
      toast(err.message, true);
    }
  }

  $('history-close').addEventListener('click', () => historyDialog.close());

  async function toggleAttendance(m, btn) {
    btn.disabled = true;
    try {
      upsert(
        await api(`/api/members/${m.id}/attendance?month=${state.month}`, {
          method: 'PATCH',
          body: JSON.stringify({ attending: !m.attending }),
        })
      );
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  }

  async function removeMember(m) {
    if (!confirm(`Delete ${m.name} (${m.card_no})?\n\nThis also deletes their full fee history and cannot be undone.`)) return;
    try {
      await api(`/api/members/${m.id}`, { method: 'DELETE' });
      state.members = state.members.filter((x) => x.id !== m.id);
      render();
      toast(`${m.name} deleted`);
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- Dialog ----------
  function setFeeStatus() {
    feeStatus.textContent = feeBox.checked ? 'Paid' : 'Not paid';
    feeStatus.className = `badge ${feeBox.checked ? 'badge-paid' : 'badge-unpaid'}`;
  }

  function openDialog(m = null) {
    editing = m;
    $('dialog-title').textContent = m ? 'Edit member' : 'Add member';
    form.reset();
    formError.hidden = true;
    form.name.value = m ? m.name : '';
    form.age.value = m ? m.age : '';
    form.mobile.value = m ? fmtMobile(m.mobile) : '';
    form.card_no.value = m ? m.card_no : '';
    form.join_date.value = m ? m.join_date : state.today;
    form.join_date.max = state.today;
    form.querySelector(`input[name="attending"][value="${m ? m.attending : true}"]`).checked = true;

    $('fee-legend').textContent = `Fees for ${fmtMonth(state.month)}`;
    const alreadyPaid = Boolean(m && m.fee_paid);
    feeBox.checked = alreadyPaid;
    feeBox.disabled = alreadyPaid;
    $('fee-note').textContent = alreadyPaid
      ? `Paid on ${fmtDate(m.fee_paid_on)}. Locked — paid status cannot be changed.`
      : 'You will be asked to type RECEIVED. Once paid, it cannot be changed back.';
    setFeeStatus();

    dialog.showModal();
    form.name.focus();
  }

  feeBox.addEventListener('change', setFeeStatus);
  $('cancel-btn').addEventListener('click', () => dialog.close());
  $('add-btn').addEventListener('click', () => openDialog());
  form.card_no.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    e.target.value = e.target.value.toUpperCase();
    e.target.setSelectionRange(pos, pos);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    formError.hidden = true;
    const payload = {
      name: form.name.value.trim(),
      age: Number(form.age.value),
      mobile: cleanMobile(form.mobile.value.trim()),
      card_no: form.card_no.value.trim().toUpperCase(),
      join_date: form.join_date.value,
      attending: form.querySelector('input[name="attending"]:checked').value === 'true',
    };
    if (!payload.name || !payload.mobile || !form.age.value || !payload.card_no || !payload.join_date) {
      formError.textContent = 'Please fill in name, mobile number, age, card number and date of joining.';
      formError.hidden = false;
      return;
    }
    if (!/^[6-9]\d{9}$/.test(payload.mobile)) {
      formError.textContent = 'Enter a valid 10-digit mobile number (e.g. 98765 43210).';
      formError.hidden = false;
      form.mobile.focus();
      return;
    }
    const wantsPayment = feeBox.checked && !feeBox.disabled;
    if (wantsPayment && payload.join_date.slice(0, 7) > state.month) {
      formError.textContent = `Joined after ${fmtMonth(state.month)}, so fees can't be marked for that month.`;
      formError.hidden = false;
      return;
    }

    let confirmWord = null;
    if (wantsPayment) {
      confirmWord = await askReceived(payload.name, state.month, payload.join_date);
      if (!confirmWord) return; // cancelled — nothing saved, form stays open
    }

    const saveBtn = $('save-btn');
    saveBtn.disabled = true;
    try {
      let saved = editing
        ? await api(`/api/members/${editing.id}?month=${state.month}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await api('/api/members', { method: 'POST', body: JSON.stringify(payload) });
      editing = saved; // so a retry after a failed payment edits instead of re-creating
      if (wantsPayment) {
        try {
          saved = await recordPayment(saved.id, state.month, confirmWord);
        } catch (err) {
          upsert(saved);
          throw new Error(`Member saved, but fees could not be marked: ${err.message}`);
        }
      }
      if (state.month !== state.currentMonth && !wantsPayment) {
        // Server returns current-month status for new members; reload to show the viewed month.
        await load(state.month);
      } else {
        upsert(saved);
      }
      dialog.close();
      toast(`${saved.name} saved${wantsPayment ? ` · ${fmtMonth(state.month)} fees received` : ''}`);
    } catch (err) {
      formError.textContent = err.message;
      formError.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });

  // ---------- Month navigation ----------
  $('prev-month').addEventListener('click', () => {
    if (state.month > state.feesStartMonth) load(shiftMonth(state.month, -1));
  });
  $('next-month').addEventListener('click', () => {
    if (state.month < state.currentMonth) load(shiftMonth(state.month, 1));
  });
  $('this-month').addEventListener('click', () => load());

  // Roll over to the new month automatically if the dashboard is left open past midnight on the 1st.
  setInterval(async () => {
    if (document.hidden || !state.currentMonth) return;
    const viewingCurrent = state.month === state.currentMonth;
    const before = state.currentMonth;
    if (viewingCurrent) await load();
    if (state.currentMonth !== before) toast(`New month: ${fmtMonth(state.currentMonth)} — all fees start as not paid`);
  }, 10 * 60 * 1000);

  // ---------- Toolbar / logout ----------
  ['search', 'filter-fee', 'filter-att'].forEach((id) => $(id).addEventListener('input', render));

  $('logout-btn').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: '{}' }); } catch {}
    window.location.replace('/');
  });

  load();
})();
