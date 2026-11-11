const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { Settings, Year, Group, Member, User, Contribution, Loan, Ledger, Audit } = require('../models');
const calc = require('../lib/calc');
const { requireAdmin, flash, audit } = require('../lib/auth');
const push = require('../lib/push');
const { monthLabel } = require('../lib/i18n');
const rs = (n) => '₹' + Math.round(n).toLocaleString('en-IN');

router.use(requireAdmin);

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const back = (req, res, fallback) => res.redirect(req.get('Referer') || fallback);
const mlabel = (m) => (m ? m.name : '?');

// ---------------- Overview ----------------
router.get('/', async (req, res) => {
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const totals = await calc.yearTotals(year);
  const pending = await calc.pendingList(year, settings);
  const counts = {
    groups: await Group.countDocuments(),
    members: await Member.countDocuments({ status: 'active' }),
  };
  const started = calc.startedMonths(year);
  const lastMonth = started[started.length - 1];
  const paidLast = lastMonth ? await Contribution.countDocuments({ year: year._id, month: lastMonth }) : 0;
  const loans = await Loan.find({ status: 'active' }).populate('borrower');
  const overdue = loans.map((l) => ({ l, st: calc.loanState(l) })).filter((x) => x.st.overdue);
  // Pending grouped by family (one head pays for the family)
  const byFam = new Map();
  for (const p of pending) {
    const g = p.member.group; const k = String(g?._id);
    if (!byFam.has(k)) byFam.set(k, { group: g, items: [], amount: 0, fine: 0 });
    const f = byFam.get(k); f.items.push(p); f.amount += p.amount; f.fine += p.fine;
  }
  const pendingFamilies = [...byFam.values()].sort((a, b) => (a.group?.order || 0) - (b.group?.order || 0));
  const { PayClaim } = require('../models');
  const claims = await PayClaim.find({ status: 'pending' }).populate('group').populate('items.member').sort({ createdAt: 1 });
  const lqCount = await require('../models').LoanRequest.countDocuments({ status: 'waiting' });
  res.render('admin/index', { lqCount, claims, year, totals, pending, pendingFamilies, counts, lastMonth, paidLast, overdue });
});

// ---------------- Groups & members ----------------
router.get('/groups', async (req, res) => {
  const groups = await Group.find().sort({ order: 1, name: 1 });
  const members = await Member.find().sort({ srNo: 1 });
  const users = await User.find({ role: 'user' });
  const userByGroup = Object.fromEntries(users.map((u) => [String(u.group), u]));
  res.render('admin/groups', { groups, members, userByGroup });
});

router.post('/groups', async (req, res) => {
  const { name, nameGu, mobile } = req.body;
  if (!name) return back(req, res, '/admin/groups');
  const maxSr = (await Member.findOne().sort({ srNo: -1 }))?.srNo || 0;
  const maxOrder = (await Group.findOne().sort({ order: -1 }))?.order || 0;
  const g = await Group.create({ name: name.trim(), nameGu: nameGu?.trim(), mobile: mobile?.trim(), order: maxOrder + 1 });
  const head = await Member.create({ srNo: maxSr + 1, name: name.trim(), nameGu: nameGu?.trim(), mobile: mobile?.trim(), group: g._id });
  g.head = head._id; await g.save();
  await audit(req, 'group.create', g.name);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/groups#g' + g._id);
});

router.post('/groups/:id', async (req, res) => {
  const g = await Group.findById(req.params.id);
  if (!g) return res.redirect('/admin/groups');
  g.name = req.body.name?.trim() || g.name;
  g.nameGu = req.body.nameGu?.trim();
  g.mobile = req.body.mobile?.trim();
  g.order = num(req.body.order, g.order);
  await g.save();
  await audit(req, 'group.update', g.name);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/groups#g' + g._id);
});

router.post('/groups/:id/delete', async (req, res) => {
  const count = await Member.countDocuments({ group: req.params.id });
  if (count) { flash(req, 'err', 'Move or delete members first'); return res.redirect('/admin/groups'); }
  const g = await Group.findByIdAndDelete(req.params.id);
  await User.deleteMany({ group: req.params.id, role: 'user' });
  await audit(req, 'group.delete', g?.name);
  flash(req, 'ok', res.locals.t('deleted'));
  res.redirect('/admin/groups');
});

router.post('/groups/:id/members', async (req, res) => {
  const { name, nameGu, mobile } = req.body;
  if (!name) return back(req, res, '/admin/groups');
  const maxSr = (await Member.findOne().sort({ srNo: -1 }))?.srNo || 0;
  const m = await Member.create({ srNo: maxSr + 1, name: name.trim(), nameGu: nameGu?.trim(), mobile: mobile?.trim(), group: req.params.id });
  const g = await Group.findById(req.params.id);
  if (g && !g.head) { g.head = m._id; await g.save(); }
  await audit(req, 'member.create', `${m.name} → ${g?.name}`);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/groups#g' + req.params.id);
});

router.post('/groups/:id/head', async (req, res) => {
  const g = await Group.findById(req.params.id);
  const m = await Member.findOne({ _id: req.body.member, group: req.params.id });
  if (g && m) {
    g.head = m._id; g.name = m.name; g.nameGu = m.nameGu || g.nameGu; if (m.mobile) g.mobile = m.mobile;
    await g.save();
    await audit(req, 'group.head', `${g.name}`);
  }
  res.redirect('/admin/groups#g' + req.params.id);
});

// Create or reset the family login
router.post('/groups/:id/login', async (req, res) => {
  const g = await Group.findById(req.params.id);
  const username = String(req.body.username || g?.mobile || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!g || !username || password.length < 6) { flash(req, 'err', res.locals.t('pwShort')); return res.redirect('/admin/groups#g' + req.params.id); }
  const clash = await User.findOne({ username, group: { $ne: g._id } });
  if (clash) { flash(req, 'err', `Username ${username} already used`); return res.redirect('/admin/groups#g' + g._id); }
  let u = await User.findOne({ group: g._id, role: 'user' });
  const passwordHash = await bcrypt.hash(password, 10);
  if (u) { u.username = username; u.passwordHash = passwordHash; u.mustChangePassword = true; u.active = true; u.displayName = g.name; await u.save(); }
  else u = await User.create({ username, passwordHash, role: 'user', group: g._id, displayName: g.name, mustChangePassword: true });
  await audit(req, 'login.set', `${g.name} (${username})`);
  flash(req, 'ok', `${res.locals.t('saved')}: ${username}`);
  res.redirect('/admin/groups#g' + g._id);
});

router.get('/members/:id', async (req, res) => {
  const member = await Member.findById(req.params.id).populate('group');
  if (!member) return res.redirect('/admin/groups');
  const groups = await Group.find().sort({ order: 1 });
  const year = await calc.getCurrentYear(res.locals.settings);
  const contribs = await Contribution.find({ member: member._id, year: year._id }).sort({ month: 1 });
  const loans = await Loan.find({ $or: [{ borrower: member._id }, { guarantors: member._id }] }).populate('borrower guarantors');
  res.render('admin/member', { member, groups, contribs, loans, year });
});

router.post('/members/:id', async (req, res) => {
  const m = await Member.findById(req.params.id);
  if (!m) return res.redirect('/admin/groups');
  const oldGroup = String(m.group);
  m.name = req.body.name?.trim() || m.name;
  m.nameGu = req.body.nameGu?.trim();
  m.mobile = req.body.mobile?.trim();
  m.srNo = num(req.body.srNo, m.srNo);
  if (['active', 'left', 'deceased'].includes(req.body.status)) m.status = req.body.status;
  if (req.body.group && req.body.group !== oldGroup) m.group = req.body.group;
  await m.save();
  if (String(m.group) !== oldGroup) {
    const og = await Group.findById(oldGroup);
    if (og && String(og.head) === String(m._id)) {
      const next = await Member.findOne({ group: oldGroup }).sort({ srNo: 1 });
      og.head = next ? next._id : undefined; await og.save();
    }
    const ng = await Group.findById(m.group);
    if (ng && !ng.head) { ng.head = m._id; await ng.save(); }
  }
  await audit(req, 'member.update', m.name);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/groups#g' + m.group);
});

router.post('/members/:id/delete', async (req, res) => {
  const m = await Member.findById(req.params.id);
  if (!m) return res.redirect('/admin/groups');
  const used = (await Contribution.countDocuments({ member: m._id })) + (await Loan.countDocuments({ $or: [{ borrower: m._id }, { guarantors: m._id }] }));
  if (used) { flash(req, 'err', 'Member has payments/loans — set status to "Left" instead.'); return res.redirect('/admin/members/' + m._id); }
  await m.deleteOne();
  const g = await Group.findById(m.group);
  if (g && String(g.head) === String(m._id)) { const n = await Member.findOne({ group: g._id }).sort({ srNo: 1 }); g.head = n?._id; await g.save(); }
  await audit(req, 'member.delete', m.name);
  flash(req, 'ok', res.locals.t('deleted'));
  res.redirect('/admin/groups#g' + m.group);
});

// ---------------- Monthly collections ----------------
router.get('/collections', async (req, res) => {
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const started = calc.startedMonths(year);
  const month = year.months.includes(req.query.month) ? req.query.month : (started[started.length - 1] || year.months[0]);
  const groups = await Group.find().sort({ order: 1, name: 1 });
  const members = await Member.find().sort({ srNo: 1 });
  const contribs = await Contribution.find({ year: year._id, month });
  const byMember = Object.fromEntries(contribs.map((c) => [String(c.member), c]));
  const due = calc.dueDateOf(month, settings.dueDay);
  res.render('admin/collections', { year, month, groups, members, byMember, due, today: calc.todayIST() });
});

router.post('/collections', async (req, res) => {
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const month = req.body.month;
  if (!year.months.includes(month)) return res.redirect('/admin/collections');
  let ids = req.body.pay || [];
  if (!Array.isArray(ids)) ids = [ids];
  const bulkDate = calc.parseDate(req.body.paidOn);
  const noLate = req.body.noLateFee === 'on';
  const items = ids.map((id) => ({ member: id, month, paidOn: req.body['date_' + id] ? calc.parseDate(req.body['date_' + id]) : bulkDate, noLate }));
  const created = await require('../lib/payments').record(year, settings, items, req.session.user._id);
  const n = created.length;
  await audit(req, 'collection.add', `${month}: ${n} payments`);
  flash(req, 'ok', `${res.locals.t('saved')} (${n})`);
  res.redirect('/admin/collections?month=' + month);
});

router.post('/contributions/:id', async (req, res) => {
  const c = await Contribution.findById(req.params.id).populate('member');
  if (!c) return back(req, res, '/admin/collections');
  c.paidOn = calc.parseDate(req.body.paidOn);
  c.lateFee = Math.max(0, num(req.body.lateFee, c.lateFee));
  c.note = req.body.note;
  await c.save();
  await audit(req, 'collection.edit', `${mlabel(c.member)} ${c.month} fee=${c.lateFee}`);
  flash(req, 'ok', res.locals.t('saved'));
  back(req, res, '/admin/collections?month=' + c.month);
});

router.post('/contributions/:id/delete', async (req, res) => {
  const c = await Contribution.findByIdAndDelete(req.params.id).populate('member');
  if (c) await audit(req, 'collection.undo', `${mlabel(c.member)} ${c.month}`);
  flash(req, 'ok', res.locals.t('deleted'));
  back(req, res, '/admin/collections');
});

// ---------------- Loans (private) ----------------
const { busyGuarantors } = require('../lib/loans');

router.get('/loans', async (req, res) => {
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const loans = await Loan.find().populate('borrower guarantors').sort({ status: 1, date: -1 });
  const rows = loans.map((l) => ({ l, st: calc.loanState(l) }));
  const members = await Member.find({ status: 'active' }).sort({ srNo: 1 });
  const busy = await busyGuarantors();
  const totals = await calc.yearTotals(year);
  const lq = await require('./loanqueue').queue();
  res.render('admin/loans', { lq, rows, members, busy, totals, today: calc.todayIST() });
});

router.post('/loans', async (req, res) => {
  const settings = res.locals.settings;
  const { t } = res.locals;
  const year = await calc.getCurrentYear(settings);
  const { borrower, g1, g2, reason } = req.body;
  const amount = num(req.body.amount);
  const r = await require('../lib/loans').create({ borrower, g1, g2, amount, reason, date: calc.parseDate(req.body.date), rate: num(req.body.rate, settings.interestRate), ratePeriod: req.body.ratePeriod }, settings, year);
  if (r.err) { flash(req, 'err', t(r.err.key, r.err.vars)); return res.redirect('/admin/loans#new'); }
  const loan = r.loan;
  const b = await Member.findById(borrower);
  const totals = await calc.yearTotals(year);
  await audit(req, 'loan.create', `${b.name} ₹${amount}`);
  flash(req, totals.cash < 0 ? 'warn' : 'ok', totals.cash < 0 ? t('warn_cash') : t('saved')); // cash already includes this loan
  res.redirect('/admin/loans/' + loan._id);
});

router.get('/loans/:id', async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate('borrower guarantors');
  if (!loan) return res.redirect('/admin/loans');
  res.render('admin/loan', { loan, st: calc.loanState(loan), today: calc.todayIST() });
});

router.post('/loans/:id/repay', async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate('borrower');
  const amount = num(req.body.amount);
  if (!loan || amount <= 0) return back(req, res, '/admin/loans');
  loan.repayments.push({ date: calc.parseDate(req.body.date), amount, note: req.body.note, recordedBy: req.session.user._id });
  const st = calc.loanState(loan, calc.parseDate(req.body.date));
  if (st.principal <= 0 && st.interestDue <= 0.5) { loan.status = 'closed'; loan.closedOn = calc.parseDate(req.body.date); }
  await loan.save();
  await audit(req, 'loan.repay', `${mlabel(loan.borrower)} ₹${amount}`);
  // Private: only the borrower's family is told
  const after = calc.loanState(loan);
  await push.toGroups([loan.borrower.group], (t) => ({ title: t('pushRepayTitle'), body: t('pushRepayBody', { a: rs(amount), b: rs(after.totalDue) }), url: '/', tag: 'loan' })).catch(() => {});
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/loans/' + loan._id);
});

router.post('/loans/:id/repayments/:rid/delete', async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate('borrower');
  if (!loan) return res.redirect('/admin/loans');
  const r = loan.repayments.id(req.params.rid);
  if (r) { r.deleteOne(); loan.status = 'active'; loan.closedOn = undefined; await loan.save(); await audit(req, 'loan.repay.undo', `${mlabel(loan.borrower)} ₹${r.amount}`); }
  res.redirect('/admin/loans/' + loan._id);
});

router.post('/loans/:id/status', async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate('borrower');
  if (!loan) return res.redirect('/admin/loans');
  if (req.body.status === 'closed') { loan.status = 'closed'; loan.closedOn = calc.todayIST(); }
  else {
    const busy = await busyGuarantors(loan._id);
    if (loan.guarantors.some((g) => busy.has(String(g)))) { flash(req, 'err', res.locals.t('err_guarantorBusy', { n: '' })); return res.redirect('/admin/loans/' + loan._id); }
    loan.status = 'active'; loan.closedOn = undefined;
  }
  await loan.save();
  await audit(req, 'loan.status', `${mlabel(loan.borrower)} → ${loan.status}`);
  res.redirect('/admin/loans/' + loan._id);
});

router.post('/loans/:id/delete', async (req, res) => {
  const loan = await Loan.findById(req.params.id).populate('borrower');
  if (loan && loan.repayments.length === 0) {
    await loan.deleteOne();
    await audit(req, 'loan.delete', `${mlabel(loan.borrower)} ₹${loan.amount}`);
    flash(req, 'ok', res.locals.t('deleted'));
  }
  res.redirect('/admin/loans');
});

// ---------------- Other income / expense ----------------
router.get('/ledger', async (req, res) => {
  const year = await calc.getCurrentYear(res.locals.settings);
  const entries = await Ledger.find({ year: year._id }).sort({ date: -1 });
  res.render('admin/ledger', { year, entries, today: calc.todayIST() });
});
router.post('/ledger', async (req, res) => {
  const year = await calc.getCurrentYear(res.locals.settings);
  const amount = num(req.body.amount);
  if (amount > 0) {
    await Ledger.create({ year: year._id, date: calc.parseDate(req.body.date), type: req.body.type === 'out' ? 'out' : 'in', category: req.body.category || 'other', amount, note: req.body.note, recordedBy: req.session.user._id });
    await audit(req, 'ledger.add', `${req.body.type} ₹${amount} ${req.body.note || ''}`);
    flash(req, 'ok', res.locals.t('saved'));
  }
  res.redirect('/admin/ledger');
});
router.post('/ledger/:id/delete', async (req, res) => {
  const e = await Ledger.findByIdAndDelete(req.params.id);
  if (e) await audit(req, 'ledger.delete', `${e.type} ₹${e.amount}`);
  res.redirect('/admin/ledger');
});

// ---------------- Logins ----------------
router.get('/users', async (req, res) => {
  const users = await User.find().populate('group member').sort({ role: 1, username: 1 });
  const members = await Member.find({ status: 'active' }).sort({ srNo: 1 });
  res.render('admin/users', { users, members });
});
router.post('/users', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!username || password.length < 6) { flash(req, 'err', res.locals.t('pwShort')); return res.redirect('/admin/users'); }
  if (await User.findOne({ username })) { flash(req, 'err', `Username ${username} already used`); return res.redirect('/admin/users'); }
  const member = req.body.member ? await Member.findById(req.body.member) : null;
  await User.create({ username, passwordHash: await bcrypt.hash(password, 10), role: 'admin', member: member?._id, displayName: member?.name || req.body.displayName || username, mustChangePassword: true });
  await audit(req, 'admin.create', `${username}${member ? ' = ' + member.name : ''}`);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/users');
});
router.post('/users/:id/member', async (req, res) => {
  const u = await User.findById(req.params.id);
  const m = req.body.member ? await Member.findById(req.body.member) : null;
  if (u && u.role === 'admin') {
    u.member = m?._id; u.displayName = m?.name || u.username; await u.save();
    if (String(u._id) === req.session.user._id) req.session.user.displayName = u.displayName;
    await audit(req, 'admin.member', `${u.username} = ${m ? m.name : '-'}`);
    flash(req, 'ok', res.locals.t('saved'));
  }
  res.redirect('/admin/users');
});

router.post('/users/:id/reset', async (req, res) => {
  const u = await User.findById(req.params.id);
  const password = String(req.body.password || '');
  if (!u || password.length < 6) { flash(req, 'err', res.locals.t('pwShort')); return res.redirect('/admin/users'); }
  u.passwordHash = await bcrypt.hash(password, 10); u.mustChangePassword = true; await u.save();
  await audit(req, 'login.reset', u.username);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/users');
});
router.post('/users/:id/toggle', async (req, res) => {
  const u = await User.findById(req.params.id);
  if (u && String(u._id) !== req.session.user._id) { u.active = !u.active; await u.save(); await audit(req, 'login.toggle', `${u.username} → ${u.active}`); }
  res.redirect('/admin/users');
});

// ---------------- Rule book (editable) ----------------
const ORIGINAL_RULES = require('../lib/rules');
router.get('/rules', (req, res) => {
  const s = res.locals.settings;
  res.render('admin/rules', { rules: s.rules && s.rules.length ? s.rules : ORIGINAL_RULES });
});
router.post('/rules', async (req, res) => {
  const arr = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
  const gu = arr(req.body.gu), en = arr(req.body.en);
  const rules = gu.map((g, i) => ({ gu: String(g || '').trim(), en: String(en[i] || '').trim() })).filter((r) => r.gu || r.en);
  if (!rules.length) { flash(req, 'err', res.locals.t('rulesEmpty')); return res.redirect('/admin/rules'); }
  const s = await calc.getSettings();
  s.rules = rules; s.rulesUpdatedAt = new Date(); await s.save();
  await audit(req, 'rules.update', `${rules.length} rules`);
  flash(req, 'ok', res.locals.t('rulesSaved'));
  res.redirect('/rules');
});
router.post('/rules/reset', async (req, res) => {
  const s = await calc.getSettings();
  s.rules = []; s.rulesUpdatedAt = new Date(); await s.save();
  await audit(req, 'rules.reset', 'original printed rules restored');
  flash(req, 'ok', res.locals.t('rulesSaved'));
  res.redirect('/rules');
});

// ---------------- Settings & permissions ----------------
router.get('/settings', (req, res) => res.render('admin/settings'));
router.post('/settings', async (req, res) => {
  const s = await calc.getSettings();
  const b = req.body;
  s.shortName = (b.shortName || '').trim() || s.shortName;
  s.mandalName = b.mandalName || s.mandalName;
  s.mandalNameGu = b.mandalNameGu || s.mandalNameGu;
  s.samajName = b.samajName || s.samajName;
  const upiLib = require('../lib/upi');
  const mid = String(b.mandalUpiId || '').trim();
  if (!mid || upiLib.valid(mid)) s.mandalUpiId = mid || undefined;
  s.mandalUpiName = String(b.mandalUpiName || '').trim() || undefined;
  const mqr = upiLib.cleanQr(b.mandalUpiQr);
  if (mqr) s.mandalUpiQr = mqr;
  if (b.removeMandalQr === 'on') s.mandalUpiQr = undefined;
  s.samajNameGu = b.samajNameGu || s.samajNameGu;
  s.monthlyAmount = num(b.monthlyAmount, s.monthlyAmount);
  s.dueDay = Math.min(28, Math.max(1, num(b.dueDay, s.dueDay)));
  s.lateFeePer100PerDay = num(b.lateFeePer100PerDay, s.lateFeePer100PerDay);
  s.interestRate = num(b.interestRate, s.interestRate);
  s.interestPeriod = b.interestPeriod === 'yearly' ? 'yearly' : 'monthly';
  s.maxLoan = num(b.maxLoan, s.maxLoan);
  s.insuranceAmount = num(b.insuranceAmount, s.insuranceAmount);
  for (const k of Object.keys(s.perm.toObject ? s.perm.toObject() : s.perm)) s.perm[k] = b['perm_' + k] === 'on';
  s.markModified('perm');
  await s.save();
  await audit(req, 'settings.update', `rate=${s.interestRate}/${s.interestPeriod}`);
  flash(req, 'ok', res.locals.t('saved'));
  res.redirect('/admin/settings');
});

// ---------------- Year end ----------------
async function yearSummary(year, settings) {
  const totals = await calc.yearTotals(year);
  const dueCount = calc.dueMonths(year, settings).length || year.months.length;
  const members = await Member.find().populate('group').sort({ srNo: 1 });
  const by = await calc.memberSums(year._id);
  const ledger = await Ledger.find({ year: year._id });
  const ledgerNet = ledger.filter((e) => !['insurance', 'dividend', 'refund'].includes(e.category))
    .reduce((a, e) => a + (e.type === 'in' ? e.amount : -e.amount), 0);
  const pool = Math.max(0, totals.interestIn + totals.fines + ledgerNet);
  const rows = members.map((m) => {
    const s = by[String(m._id)] || { total: 0, count: 0, fines: 0 };
    const eligible = m.status === 'active' && s.count >= dueCount;
    return { id: String(m._id), srNo: m.srNo, name: m.name, nameGu: m.nameGu, group: m.group?.name, groupId: String(m.group?._id || ''), status: m.status, deposited: s.total, count: s.count, missed: Math.max(0, dueCount - s.count), fines: s.fines, eligible };
  }).filter((r) => r.deposited > 0 || r.status === 'active');
  const eligibleTotal = rows.filter((r) => r.eligible).reduce((a, r) => a + r.deposited, 0);
  const monthly = settings.monthlyAmount;
  for (const r of rows) {
    r.dividend = r.eligible && eligibleTotal ? calc.round((pool * r.deposited) / eligibleTotal) : 0;
    r.payout = calc.round(r.deposited + r.dividend);
    // Next year's first-month saving is kept back from the payout (only for active members who have enough)
    r.nextDeduct = r.status === 'active' && r.payout >= monthly ? monthly : 0;
    r.net = calc.round(r.payout - r.nextDeduct);
  }
  // Family-wise settlement (one head receives for the whole family)
  const groups = await Group.find().sort({ order: 1, name: 1 });
  const families = groups.map((g) => {
    const fr = rows.filter((r) => r.groupId === String(g._id));
    const s = (k) => calc.round(fr.reduce((a, r) => a + r[k], 0));
    return { groupId: String(g._id), name: g.name, nameGu: g.nameGu, mobile: g.mobile, count: fr.length,
      deposited: s('deposited'), dividend: s('dividend'), payout: s('payout'), nextDeduct: s('nextDeduct'), net: s('net'), fines: s('fines'),
      adjustedMembers: fr.filter((r) => r.nextDeduct > 0).length };
  }).filter((f) => f.count);
  const sum = (k) => calc.round(families.reduce((a, f) => a + f[k], 0));
  const settle = { deposited: sum('deposited'), dividend: sum('dividend'), payout: sum('payout'), nextDeduct: sum('nextDeduct'), net: sum('net') };
  return { totals, dueCount, pool: calc.round(pool), rows, families, settle, monthly, label: year.label };
}

router.get('/year', async (req, res) => {
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const summary = await yearSummary(year, settings);
  const activeLoans = await Loan.countDocuments({ status: 'active' });
  const pastYears = await Year.find({ status: 'closed' }).sort({ closedAt: -1 });
  const last = year.months[year.months.length - 1];
  const nextStart = calc.buildMonths(last, 2)[1];
  const [y1] = nextStart.split('-').map(Number);
  res.render('admin/year', { year, summary, activeLoans, pastYears, nextStart, nextLabel: `${y1}-${String(y1 + 1).slice(2)}`, today: calc.todayIST() });
});

router.post('/year/close', async (req, res) => {
  const settings = await calc.getSettings();
  const year = await calc.getCurrentYear(settings);
  if (req.body.confirm !== 'CLOSE') { flash(req, 'err', res.locals.t('typeConfirm')); return res.redirect('/admin/year'); }
  if (await Loan.countDocuments({ status: 'active' })) { flash(req, 'err', res.locals.t('activeLoansBlock')); return res.redirect('/admin/year'); }
  const summary = await yearSummary(year, settings);
  year.summary = summary; year.status = 'closed'; year.closedAt = new Date();
  await year.save();
  const start = /^\d{4}-\d{2}$/.test(req.body.start) ? req.body.start : calc.buildMonths(year.months[11], 2)[1];
  const ny = await Year.create({ label: req.body.label || start, startDate: calc.parseDate(req.body.startDate), months: calc.buildMonths(start, 12), openingBalance: num(req.body.openingBalance, 0) });
  settings.currentYear = ny._id; await settings.save();
  // Deduct next year's first month from the payout: record it as already paid in the new year
  let adjusted = 0;
  if (req.body.adjustFirstMonth === 'on') {
    for (const r of summary.rows.filter((x) => x.nextDeduct > 0)) {
      await Contribution.create({ year: ny._id, member: r.id, month: ny.months[0], amount: r.nextDeduct, paidOn: ny.startDate || calc.todayIST(), lateFee: 0, note: 'વર્ષાંત ચુકવણીમાંથી જમા / adjusted from year-end payout', recordedBy: req.session.user._id });
      adjusted++;
    }
  } else {
    summary.families.forEach((f) => { f.net = f.payout; f.nextDeduct = 0; });
    summary.rows.forEach((r) => { r.net = r.payout; r.nextDeduct = 0; });
    for (const k of ['nextDeduct', 'net']) summary.settle[k] = k === 'net' ? summary.settle.payout : 0;
  }
  summary.adjusted = adjusted;
  year.summary = summary; year.markModified('summary'); await year.save();
  await require('./money').createPayouts(year); // one payout slip per family
  await audit(req, 'year.close', `${year.label} → ${ny.label}, first month adjusted for ${adjusted} members`);
  flash(req, 'ok', res.locals.t('yearClosed'));
  res.redirect('/admin/year');
});

router.get('/years/:id', async (req, res) => {
  const year = await Year.findById(req.params.id);
  if (!year || !year.summary) return res.redirect('/admin/year');
  res.render('admin/year-past', { year, summary: year.summary });
});

// ---------------- Audit ----------------
router.get('/audit', async (req, res) => {
  const logs = await Audit.find().sort({ createdAt: -1 }).limit(300);
  res.render('admin/audit', { logs });
});

// Reopen the most recently closed year (undo an accidental close).
// Allowed only while the new year has nothing in it except the automatic first-month deductions.
router.post('/year/reopen', async (req, res) => {
  const { t } = res.locals;
  const { Payout, PayClaim, LoanRequest } = require('../models');
  const settings = await calc.getSettings();
  const cur = await calc.getCurrentYear(settings);
  const last = await Year.findOne({ status: 'closed' }).sort({ closedAt: -1 });
  if (!last || req.body.confirm !== 'REOPEN') { flash(req, 'err', t('reopenTypeConfirm')); return res.redirect('/admin/year'); }
  const AUTO = /adjusted from year-end payout/;
  const contribs = await Contribution.find({ year: cur._id });
  const manual = contribs.filter((c) => !AUTO.test(c.note || '')).length;
  const other = (await Loan.countDocuments({ year: cur._id })) + (await Ledger.countDocuments({ year: cur._id })) + (await PayClaim.countDocuments({ year: cur._id }));
  const paidOut = await Payout.countDocuments({ year: last._id, status: { $ne: 'pending' } });
  if (manual || other || paidOut) { flash(req, 'err', t('reopenBlocked', { a: manual, b: other, c: paidOut })); return res.redirect('/admin/year'); }
  await Contribution.deleteMany({ year: cur._id });
  await Payout.deleteMany({ year: last._id });
  await Year.deleteOne({ _id: cur._id });
  last.status = 'open'; last.closedAt = undefined; last.summary = undefined; await last.save();
  settings.currentYear = last._id; await settings.save();
  await audit(req, 'year.reopen', `${last.label} reopened, ${cur.label} removed`);
  flash(req, 'ok', t('yearReopened', { y: last.label }));
  res.redirect('/admin/year');
});

module.exports = router;
module.exports.yearSummary = yearSummary;
