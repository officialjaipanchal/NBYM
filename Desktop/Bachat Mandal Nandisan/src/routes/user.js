const router = require('express').Router();
const { Group, Member, Contribution, Loan, Year } = require('../models');
const calc = require('../lib/calc');
const { requireLogin } = require('../lib/auth');
const RULES = require('../lib/rules');

function denied(res) { return res.status(403).render('message', { title: '403', text: res.locals.t('noAccess') }); }
const isAdmin = (req) => req.session.user?.role === 'admin';

// Group dashboard for normal users
router.get('/', requireLogin, async (req, res) => {
  if (isAdmin(req)) return res.redirect('/admin');
  const settings = res.locals.settings;
  const year = await calc.getCurrentYear(settings);
  const group = await Group.findById(req.session.user.group);
  if (!group || !year) return res.render('message', { title: '—', text: 'No family linked to this login. Please contact admin.' });

  const members = await Member.find({ group: group._id }).sort({ srNo: 1 });
  const ids = members.map((m) => m._id);
  const contribs = await Contribution.find({ year: year._id, member: { $in: ids } });
  const paid = {};
  for (const c of contribs) paid[`${c.member}|${c.month}`] = c;
  const familyTotal = contribs.reduce((a, c) => a + c.amount, 0);
  const familyFines = contribs.reduce((a, c) => a + (c.lateFee || 0), 0);

  // Loans: only where a family member is the borrower or a guarantor (privacy rule)
  const loans = await Loan.find({ $or: [{ borrower: { $in: ids } }, { guarantors: { $in: ids } }] })
    .populate('borrower guarantors').sort({ date: -1 });
  const idSet = new Set(ids.map(String));
  const myLoans = [], guaranteeLoans = [];
  for (const l of loans) {
    const item = { loan: l, st: calc.loanState(l) };
    if (idSet.has(String(l.borrower._id))) myLoans.push(item); else guaranteeLoans.push(item);
  }

  const totals = (settings.perm.showBalance || settings.perm.showTotalLent) ? await calc.yearTotals(year) : null;
  const myPending = await calc.pendingList(year, settings, ids);
  const allPending = settings.perm.showPending ? await calc.pendingList(year, settings) : null;

  const { Sahay } = require('../models');
  const openSahay = await Sahay.find({ status: 'collecting' }).populate('deceased');
  const sahayDue = openSahay.map((s) => {
    const paid = new Set(s.payments.map((p) => String(p.member)));
    const owe = members.filter((m) => s.contributors.some((c) => String(c) === String(m._id)) && !paid.has(String(m._id)));
    return { s, owe, amount: owe.length * s.amountPerMember };
  }).filter((x) => x.owe.length);
  const lastYear = await Year.findOne({ status: 'closed' }).sort({ closedAt: -1 });
  const settlement = lastYear?.summary?.families?.find((f) => f.groupId === String(group._id));
  const settlementRows = settlement ? lastYear.summary.rows.filter((r) => r.groupId === String(group._id)) : [];
  const { PayClaim, Payout } = require('../models');
  const upi = require('../lib/upi');
  const myClaims = await PayClaim.find({ group: group._id, $or: [{ status: 'pending' }, { status: 'rejected', decidedAt: { $gte: new Date(Date.now() - 7 * 864e5) } }] }).sort({ createdAt: -1 });
  const claimedKeys = new Set(myClaims.filter((c) => c.status === 'pending').flatMap((c) => c.items.map((i) => `${i.member}|${i.month}`)));
  const payout = lastYear ? await Payout.findOne({ year: lastYear._id, group: group._id }) : null;
  const dueTotal = myPending.reduce((a, p) => a + p.amount + p.fine, 0);
  const payLink = upi.link(settings.mandalUpiId, settings.mandalUpiName || settings.shortName || 'NBYM', dueTotal, `NBYM ${group.name}`.slice(0, 50));
  const { LoanRequest } = require('../models');
  const q = await require('./loanqueue').queue();
  const myRequests = await LoanRequest.find({ group: group._id, $or: [{ status: 'waiting' }, { decidedAt: { $gte: new Date(Date.now() - 14 * 864e5) } }] }).populate('borrower guarantors.member').sort({ createdAt: -1 });
  const qpos = (r) => q.findIndex((x) => String(x._id) === String(r._id)) + 1;
  const guarAsks = q.filter((r) => r.guarantors.some((g) => g.member && String(g.member.group) === String(group._id) && g.status === 'asked'));
  const allActive = await Member.find({ status: 'active' }).sort({ srNo: 1 });
  const busyG = await require('../lib/loans').busyGuarantors();
  res.render('dashboard', { myRequests, qpos, qlen: q.length, guarAsks, allActive, busyG, sahayDue, lastYear, settlement, settlementRows, myClaims, claimedKeys, payout, dueTotal, payLink,
    group, members, year, paid, familyTotal, familyFines, myLoans, guaranteeLoans, totals, myPending,
    allPendingCount: allPending ? allPending.length : null,
    started: new Set(calc.startedMonths(year)),
  });
});

router.get('/pending', requireLogin, async (req, res) => {
  const settings = res.locals.settings;
  if (!isAdmin(req) && !settings.perm.showPending) return denied(res);
  const year = await calc.getCurrentYear(settings);
  const list = await calc.pendingList(year, settings);
  const showFines = isAdmin(req) || settings.perm.showPendingFines;
  res.render('pending', { year, list, showFines });
});

router.get('/members', requireLogin, async (req, res) => {
  const settings = res.locals.settings;
  if (!isAdmin(req) && !settings.perm.showAllMembers) return denied(res);
  const year = await calc.getCurrentYear(settings);
  const groups = await Group.find().sort({ order: 1, name: 1 });
  const members = await Member.find().sort({ srNo: 1 });
  const byMember = await calc.memberSums(year._id);
  res.render('members', { year, groups, members, byMember });
});

router.get('/rules', requireLogin, (req, res) => {
  if (!isAdmin(req) && !res.locals.settings.perm.showRules) return denied(res);
  const s = res.locals.settings;
  res.render('rules', { rules: s.rules && s.rules.length ? s.rules : RULES, updatedAt: s.rulesUpdatedAt });
});

module.exports = router;
