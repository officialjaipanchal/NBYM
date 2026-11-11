// All money and rule calculations live here so they are easy to audit.
const { Settings, Year, Member, Contribution, Loan, Ledger } = require('../models');

const DAY = 24 * 60 * 60 * 1000;

// Dates are stored as UTC midnight of the calendar day (date-only semantics).
function todayIST() {
  const s = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  return new Date(s + 'T00:00:00Z');
}
function parseDate(str) {
  if (!str) return todayIST();
  const d = new Date(String(str).slice(0, 10) + 'T00:00:00Z');
  return isNaN(d) ? todayIST() : d;
}
function dateInput(d) { return d ? new Date(d).toISOString().slice(0, 10) : ''; }
function daysBetween(a, b) { return Math.round((b - a) / DAY); }

function monthKeyOf(d) { return new Date(d).toISOString().slice(0, 7); }
function buildMonths(startKey, count = 12) {
  let [y, m] = startKey.split('-').map(Number);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}
function dueDateOf(monthKey, dueDay) {
  return new Date(`${monthKey}-${String(dueDay).padStart(2, '0')}T00:00:00Z`);
}
// Months of the year whose due date has already passed (i.e. are payable now)
function dueMonths(year, settings, asOf = todayIST()) {
  return year.months.filter((mk) => dueDateOf(mk, settings.dueDay) < asOf);
}
// Months whose collection window has started (1st of month reached)
function startedMonths(year, asOf = todayIST()) {
  return year.months.filter((mk) => new Date(mk + '-01T00:00:00Z') <= asOf);
}

// Rule 16: Rs 1 per Rs 100 per day after the due date
function lateFeeFor(amount, monthKey, paidOn, settings) {
  const due = dueDateOf(monthKey, settings.dueDay);
  const days = Math.max(0, daysBetween(due, paidOn));
  return Math.round(days * (amount / 100) * settings.lateFeePer100PerDay);
}

// Rule 21 / 10 / 5: simple interest from loan date on outstanding principal.
// Every repayment first clears interest accrued so far, the rest reduces principal,
// so interest from then on is charged on the reduced amount.
function dailyRate(loan) {
  const r = loan.rate / 100;
  return loan.ratePeriod === 'monthly' ? (r * 12) / 365 : r / 365;
}
function loanState(loan, asOf = todayIST()) {
  const reps = [...(loan.repayments || [])].sort((a, b) => a.date - b.date);
  const dr = dailyRate(loan);
  let principal = loan.amount;
  let accrued = 0; // unpaid interest carried
  let last = new Date(loan.date);
  let interestPaid = 0, principalPaid = 0;
  const rows = [];
  for (const r of reps) {
    const d = new Date(r.date);
    const days = Math.max(0, daysBetween(last, d));
    accrued += principal * dr * days;
    const toInterest = Math.min(r.amount, accrued);
    const toPrincipal = Math.min(principal, r.amount - toInterest);
    accrued -= toInterest; principal -= toPrincipal;
    interestPaid += toInterest; principalPaid += toPrincipal;
    rows.push({ _id: r._id, date: r.date, amount: r.amount, note: r.note, toInterest, toPrincipal, extra: r.amount - toInterest - toPrincipal, principalAfter: principal });
    last = d;
  }
  const endDate = loan.status === 'closed' && loan.closedOn ? new Date(loan.closedOn) : asOf;
  const days = Math.max(0, daysBetween(last, endDate));
  const interestDue = loan.status === 'closed' ? 0 : accrued + principal * dr * days;
  // Rule 13: months without any payment since loan date / last payment
  const lastPay = reps.length ? new Date(reps[reps.length - 1].date) : new Date(loan.date);
  const monthsSincePay = Math.floor(daysBetween(lastPay, asOf) / 30);
  return {
    principal: round(principal),
    interestDue: round(interestDue),
    totalDue: round(principal + interestDue),
    interestPaid: round(interestPaid),
    principalPaid: round(principalPaid),
    monthlyInterestNow: round(principal * dr * 30),
    monthsSincePay,
    overdue: loan.status === 'active' && monthsSincePay >= 2,
    rows: rows.map((x) => ({ ...x, toInterest: round(x.toInterest), toPrincipal: round(x.toPrincipal), extra: round(x.extra), principalAfter: round(x.principalAfter) })),
  };
}
function round(n) { return Math.round(n * 100) / 100; }

async function getSettings() {
  let s = await Settings.findOne({ key: 'main' });
  if (!s) s = await Settings.create({ key: 'main' });
  // One-time rename: NBYM = Nandisan Bachat Yojna Mandal (old long name becomes the samaj name)
  if (s.mandalName === 'Shree Vishwakarma Nandisan Panchal Samaj Bachat Mandal') {
    s.mandalName = 'Nandisan Bachat Yojna Mandal'; s.mandalNameGu = 'નાંદીસણ બચત યોજના મંડળ'; await s.save();
  }
  return s;
}
async function getCurrentYear(settings) {
  settings = settings || (await getSettings());
  if (settings.currentYear) {
    const y = await Year.findById(settings.currentYear);
    if (y) return y;
  }
  return Year.findOne({ status: 'open' }).sort({ createdAt: -1 });
}

// Full money picture for a year
async function yearTotals(year) {
  const all = await Contribution.find({ year: year._id }, 'amount lateFee').lean();
  const contrib = { amount: all.reduce((a, c) => a + c.amount, 0), lateFee: all.reduce((a, c) => a + (c.lateFee || 0), 0), months: all };
  const loans = await Loan.find({ year: year._id });
  let lent = 0, principalBack = 0, interestIn = 0, outstanding = 0, interestAccrued = 0, active = 0, overdue = 0;
  for (const l of loans) {
    const st = loanState(l);
    lent += l.amount;
    principalBack += st.principalPaid;
    interestIn += st.interestPaid;
    if (l.status === 'active') { outstanding += st.principal; interestAccrued += st.interestDue; active++; if (st.overdue) overdue++; }
  }
  const ledger = await Ledger.find({ year: year._id });
  const otherIn = ledger.filter((x) => x.type === 'in').reduce((a, x) => a + x.amount, 0);
  const otherOut = ledger.filter((x) => x.type === 'out').reduce((a, x) => a + x.amount, 0);
  const deposits = contrib ? contrib.amount : 0;
  const fines = contrib ? contrib.lateFee : 0;
  const cash = (year.openingBalance || 0) + deposits + fines + interestIn + principalBack - lent + otherIn - otherOut;
  return {
    opening: year.openingBalance || 0,
    deposits, fines, interestIn, lent: round(lent), principalBack: round(principalBack),
    outstanding: round(outstanding), interestAccrued: round(interestAccrued),
    otherIn, otherOut, cash: round(cash), activeLoans: active, overdueLoans: overdue,
    totalAssets: round(cash + outstanding),
    paymentsCount: contrib ? (contrib.months || []).length : 0,
  };
}

// Pending monthly payments for members (optionally restricted to a list of member ids)
async function pendingList(year, settings, memberFilter = null, asOf = todayIST()) {
  const months = startedMonths(year, asOf);
  const q = { status: 'active' };
  if (memberFilter) q._id = { $in: memberFilter };
  const members = await Member.find(q).populate('group').sort({ srNo: 1 });
  const paid = await Contribution.find({ year: year._id, member: { $in: members.map((m) => m._id) } }, 'member month');
  const paidSet = new Set(paid.map((p) => `${p.member}|${p.month}`));
  const out = [];
  for (const m of members) {
    const missing = months.filter((mk) => !paidSet.has(`${m._id}|${mk}`));
    if (!missing.length) continue;
    const items = missing.map((mk) => {
      const due = dueDateOf(mk, settings.dueDay);
      const late = due < asOf;
      return { month: mk, late, fine: late ? lateFeeFor(settings.monthlyAmount, mk, asOf, settings) : 0 };
    });
    out.push({
      member: m,
      months: items,
      amount: items.length * settings.monthlyAmount,
      fine: items.reduce((a, x) => a + x.fine, 0),
      lateCount: items.filter((x) => x.late).length,
    });
  }
  return out;
}

// Per-member totals {memberId: {total, count, fines}} without aggregation (works on any MongoDB-compatible DB)
async function memberSums(yearId) {
  const out = {};
  for (const c of await Contribution.find({ year: yearId }, 'member amount lateFee').lean()) {
    const k = String(c.member); const o = out[k] || (out[k] = { total: 0, count: 0, fines: 0 });
    o.total += c.amount; o.count++; o.fines += c.lateFee || 0;
  }
  return out;
}

module.exports = { memberSums,
  DAY, todayIST, parseDate, dateInput, daysBetween, monthKeyOf, buildMonths, dueDateOf,
  dueMonths, startedMonths, lateFeeFor, loanState, getSettings, getCurrentYear, yearTotals, pendingList, round,
};
