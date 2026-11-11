const mongoose = require('mongoose');
const { Schema, Types } = mongoose;
const ObjectId = Types.ObjectId;

// ---------- Settings (single document) ----------
const SettingsSchema = new Schema({
  key: { type: String, default: 'main', unique: true },
  mandalName: { type: String, default: 'Nandisan Bachat Yojna Mandal' },
  samajName: { type: String, default: 'Shree Vishwakarma Nandisan Panchal Samaj' },
  samajNameGu: { type: String, default: 'શ્રી વિશ્વકર્મા નાંદીસણ પંચાલ સમાજ' },
  shortName: { type: String, default: 'NBYM' },
  mandalNameGu: { type: String, default: 'નાંદીસણ બચત યોજના મંડળ' },
  monthlyAmount: { type: Number, default: 500 },      // Rule 2
  dueDay: { type: Number, default: 10 },               // Rule 2: 1st to 10th
  lateFeePer100PerDay: { type: Number, default: 1 },   // Rule 16
  interestRate: { type: Number, default: 1 },          // Rule 21
  interestPeriod: { type: String, enum: ['monthly', 'yearly'], default: 'monthly' },
  maxLoan: { type: Number, default: 25000 },           // Rule 11
  insuranceAmount: { type: Number, default: 100 },     // Rule 22
  currentYear: { type: Schema.Types.ObjectId, ref: 'Year' },
  mandalUpiId: String,   // where members pay the monthly saving
  mandalUpiName: String,
  mandalUpiQr: String,
  vapidPublic: String,   // web-push keys, created automatically on first use
  vapidPrivate: String,
  autoReminders: { type: Boolean, default: true },
  reminderDays: { type: [Number], default: [8, 11] }, // days of month for automatic payment reminders
  remindersSentOn: String, // YYYY-MM-DD guard so the cron sends once per day
  rules: [{ gu: String, en: String, _id: false }], // editable rule book (empty = original printed rules)
  rulesUpdatedAt: Date,
  // What a normal (group) user is allowed to see
  perm: {
    showBalance: { type: Boolean, default: true },
    showPending: { type: Boolean, default: true },
    showPendingFines: { type: Boolean, default: false },
    showAllMembers: { type: Boolean, default: false },
    showTotalLent: { type: Boolean, default: true },
    showRules: { type: Boolean, default: true },
  },
});

// ---------- Accounting year (Diwali to Diwali, Rule 6) ----------
const YearSchema = new Schema({
  label: String,                 // e.g. 2026-27
  startDate: Date,               // Besta Varsh (Gujarati New Year) day
  months: [String],              // ['2025-11', ... '2026-10']
  status: { type: String, enum: ['open', 'closed'], default: 'open' },
  openingBalance: { type: Number, default: 0 },
  closedAt: Date,
  summary: Schema.Types.Mixed,   // snapshot written at year close
}, { timestamps: true });

// ---------- Group (one head + family; one login per group) ----------
const GroupSchema = new Schema({
  name: { type: String, required: true },
  nameGu: String,
  mobile: String,
  head: { type: Schema.Types.ObjectId, ref: 'Member' },
  order: { type: Number, default: 0 },
  upiId: String,     // family's UPI ID for year-end payouts
  upiName: String,   // name on the UPI account
  upiQr: String,     // QR image (data URL, resized on the phone)
}, { timestamps: true });

// ---------- Member (each pays 500 separately, Rule 3) ----------
const MemberSchema = new Schema({
  srNo: Number,
  name: { type: String, required: true },
  nameGu: String,
  mobile: String,
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  status: { type: String, enum: ['active', 'left', 'deceased'], default: 'active' },
}, { timestamps: true });

// ---------- Login user ----------
const UserSchema = new Schema({
  username: { type: String, required: true, unique: true, trim: true, lowercase: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'user'], default: 'user' },
  group: { type: Schema.Types.ObjectId, ref: 'Group' },
  member: { type: Schema.Types.ObjectId, ref: 'Member' }, // which mandal member this admin is
  displayName: String,
  mustChangePassword: { type: Boolean, default: true },
  active: { type: Boolean, default: true },
  lastLogin: Date,
}, { timestamps: true });

// ---------- Monthly 500 contribution ----------
const ContributionSchema = new Schema({
  year: { type: Schema.Types.ObjectId, ref: 'Year', required: true },
  member: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  month: { type: String, required: true }, // YYYY-MM
  amount: { type: Number, required: true },
  paidOn: { type: Date, required: true },
  lateFee: { type: Number, default: 0 },
  note: String,
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
ContributionSchema.index({ year: 1, member: 1, month: 1 }, { unique: true });

// ---------- Loan (PRIVATE: admin + borrower + 2 guarantors only) ----------
const RepaymentSchema = new Schema({
  date: { type: Date, required: true },
  amount: { type: Number, required: true },
  note: String,
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
});
const LoanSchema = new Schema({
  year: { type: Schema.Types.ObjectId, ref: 'Year', required: true },
  borrower: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  guarantors: [{ type: Schema.Types.ObjectId, ref: 'Member' }],
  amount: { type: Number, required: true },
  date: { type: Date, required: true },
  rate: { type: Number, required: true },
  ratePeriod: { type: String, enum: ['monthly', 'yearly'], required: true },
  reason: String,
  status: { type: String, enum: ['active', 'closed'], default: 'active' },
  closedOn: Date,
  repayments: [RepaymentSchema],
}, { timestamps: true });

// ---------- Other income / expense (insurance collection, expenses, etc.) ----------
const LedgerSchema = new Schema({
  year: { type: Schema.Types.ObjectId, ref: 'Year', required: true },
  date: { type: Date, required: true },
  type: { type: String, enum: ['in', 'out'], required: true },
  category: { type: String, default: 'other' }, // insurance | expense | dividend | refund | other
  amount: { type: Number, required: true },
  note: String,
  recordedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

// ---------- Rule 22: death help fund (separate from mandal money) ----------
// When a member dies, every other member gives Rs 100; the collected amount goes to the family.
const SahayPaymentSchema = new Schema({
  member: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  amount: { type: Number, required: true },
  paidOn: { type: Date, required: true },
});
const SahaySchema = new Schema({
  deceased: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  dateOfDeath: { type: Date, required: true },
  amountPerMember: { type: Number, required: true },
  contributors: [{ type: Schema.Types.ObjectId, ref: 'Member' }], // members expected to give
  payments: [SahayPaymentSchema],
  recipient: { type: Schema.Types.ObjectId, ref: 'Member' }, // family member who receives
  recipientName: String,
  recipientMobile: String,
  status: { type: String, enum: ['collecting', 'given'], default: 'collecting' },
  givenOn: Date,
  givenAmount: Number,
  note: String,
}, { timestamps: true });

// ---------- Phone notification subscriptions (web push) ----------
const PushSubSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group' },
  role: String,
  lang: { type: String, default: 'gu' },
  endpoint: { type: String, required: true, unique: true },
  keys: { p256dh: String, auth: String },
  ua: String,
}, { timestamps: true });

// ---------- "I have paid" claims from families (admin approves) ----------
const PayClaimSchema = new Schema({
  year: { type: Schema.Types.ObjectId, ref: 'Year', required: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  items: [{ member: { type: Schema.Types.ObjectId, ref: 'Member' }, month: String, _id: false }],
  amount: Number,
  paidOn: Date,
  ref: String,   // UPI reference / UTR
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  decidedAt: Date,
  reason: String,
}, { timestamps: true });

// ---------- Year-end payout to each family (savings + interest − next month) ----------
const PayoutSchema = new Schema({
  year: { type: Schema.Types.ObjectId, ref: 'Year', required: true },
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  deposited: Number, dividend: Number, payout: Number, nextDeduct: Number, net: Number,
  rows: [{ name: String, nameGu: String, deposited: Number, dividend: Number, nextDeduct: Number, net: Number, eligible: Boolean, _id: false }],
  status: { type: String, enum: ['pending', 'paid', 'received'], default: 'pending' },
  paidOn: Date, method: String, ref: String, paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
  receivedOn: Date, receivedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });
PayoutSchema.index({ year: 1, group: 1 }, { unique: true });

// ---------- Loan request queue (first come, first served — Rule 8) ----------
const LoanRequestSchema = new Schema({
  group: { type: Schema.Types.ObjectId, ref: 'Group', required: true },
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  borrower: { type: Schema.Types.ObjectId, ref: 'Member', required: true },
  amount: { type: Number, required: true },
  reason: String,
  guarantors: [{
    member: { type: Schema.Types.ObjectId, ref: 'Member' },
    status: { type: String, enum: ['asked', 'accepted', 'declined'], default: 'asked' },
    at: Date, _id: false,
  }],
  status: { type: String, enum: ['waiting', 'approved', 'rejected', 'cancelled'], default: 'waiting' },
  decidedAt: Date, decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  note: String,
  loan: { type: Schema.Types.ObjectId, ref: 'Loan' },
}, { timestamps: true }); // createdAt = place in the queue

// ---------- Audit log ----------
const AuditSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  username: String,
  action: String,
  details: String,
}, { timestamps: true });

module.exports = {
  ObjectId,
  Settings: mongoose.model('Settings', SettingsSchema),
  Year: mongoose.model('Year', YearSchema),
  Group: mongoose.model('Group', GroupSchema),
  Member: mongoose.model('Member', MemberSchema),
  User: mongoose.model('User', UserSchema),
  Contribution: mongoose.model('Contribution', ContributionSchema),
  Loan: mongoose.model('Loan', LoanSchema),
  Ledger: mongoose.model('Ledger', LedgerSchema),
  Audit: mongoose.model('Audit', AuditSchema),
  Sahay: mongoose.model('Sahay', SahaySchema),
  PushSub: mongoose.model('PushSub', PushSubSchema),
  PayClaim: mongoose.model('PayClaim', PayClaimSchema),
  Payout: mongoose.model('Payout', PayoutSchema),
  LoanRequest: mongoose.model('LoanRequest', LoanRequestSchema),
};
