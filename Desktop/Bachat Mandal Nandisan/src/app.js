require('dotenv').config();
// The Express app. Used by server.js (local / VPS) and api/index.js (Vercel serverless).
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const { makeT, monthLabel, dateLabel } = require('./lib/i18n');
const calc = require('./lib/calc');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'bachat_mandal';

// One shared connection, reused across serverless invocations
let conn = global.__nbymConn;
function connectDB() {
  if (!MONGODB_URI) return Promise.reject(Object.assign(new Error('MONGODB_URI is not set'), { setup: 'env' }));
  if (!conn) conn = global.__nbymConn = mongoose.connect(MONGODB_URI, { dbName: DB_NAME, serverSelectionTimeoutMS: 10000 }).catch((e) => { conn = global.__nbymConn = null; throw e; });
  return conn;
}

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true, limit: '1mb' })); // QR images are posted as small data URLs
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use((req, res, next) => connectDB().then(() => next(), (e) => { e.setup = e.setup || 'db'; next(e); }));

// Sessions are created only after the database is connected (avoids crashes on Vercel when the DB is unreachable)
let sessionMw = null;
app.use((req, res, next) => {
  if (!sessionMw) sessionMw = session({
    secret: process.env.SESSION_SECRET || 'change-this-secret',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({ client: mongoose.connection.getClient(), dbName: DB_NAME, collectionName: 'sessions', autoRemove: process.env.SESSION_AUTO_REMOVE || 'native' }),
    cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 30 },
  });
  sessionMw(req, res, next);
});

// View helpers available in every template
app.use(async (req, res, next) => {
  const lang = req.session.lang || 'gu';
  const t = makeT(lang);
  res.locals.lang = lang;
  res.locals.t = t;
  res.locals.path = req.path;
  res.locals.me = req.session.user || null;
  res.locals.money = (n) => { const v = Math.round(Number(n) || 0); return (v < 0 ? '−' : '') + '₹' + Math.abs(v).toLocaleString('en-IN'); };
  res.locals.ml = (k, s) => monthLabel(lang, k, s);
  res.locals.dl = dateLabel;
  res.locals.di = calc.dateInput;
  res.locals.mname = (m) => (!m ? '' : lang === 'gu' && m.nameGu ? m.nameGu : m.name);
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  try {
    res.locals.settings = await calc.getSettings();
    if (req.session.user) {
      const { User } = require('./models');
      res.locals.admins = await User.find({ role: 'admin', active: true }).populate({ path: 'member', populate: { path: 'group' } });
    } else res.locals.admins = [];
  } catch (e) { return next(e); }
  next();
});

app.use(require('./routes/auth'));
app.use(require('./routes/push'));
app.use(require('./routes/money'));
app.use(require('./routes/loanqueue'));
app.use(require('./routes/sahay'));
app.use('/admin', require('./routes/admin'));
app.use(require('./routes/user'));

app.use((req, res) => res.status(404).render('message', { title: '404', text: 'Page not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  if (err.setup || !res.locals.t) {
    // Setup problem: explain plainly (no database, so the normal page layout can't load)
    const hint = err.setup === 'env'
      ? 'MONGODB_URI is not set. In Vercel: Project → Settings → Environment Variables → add MONGODB_URI (and DB_NAME, SESSION_SECRET, COOKIE_SECURE=true), then Redeploy.'
      : 'Cannot connect to MongoDB Atlas. In Atlas: Security → Network Access → Add IP Address → 0.0.0.0/0 (Allow access from anywhere), wait until it is Active, then reload. Also check the cluster is not paused and the password in MONGODB_URI is correct.';
    const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
    return res.status(503).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>NBYM · setup</title>
<body style="font:16px/1.6 system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#22252d">
<h2 style="color:#1d2b4f">NBYM: the app can't start yet</h2><p><b>${esc(hint)}</b></p>
<p style="color:#6b6f7b">Technical detail: ${esc(err.message)}</p></body>`);
  }
  res.status(500).render('message', { title: 'Error', text: err.message });
});

module.exports = app;
module.exports.connectDB = connectDB;
