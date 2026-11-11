require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const mongoose = require('mongoose');
const { makeT, monthLabel, dateLabel } = require('./src/lib/i18n');
const calc = require('./src/lib/calc');

const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'bachat_mandal';
const PORT = process.env.PORT || 3000;
if (!MONGODB_URI) { console.error('MONGODB_URI missing in .env'); process.exit(1); }

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1);
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: MONGODB_URI, dbName: DB_NAME, collectionName: 'sessions', autoRemove: process.env.SESSION_AUTO_REMOVE || 'native' }),
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 30 },
}));

// View helpers available in every template
app.use(async (req, res, next) => {
  const lang = req.session.lang || 'gu';
  const t = makeT(lang);
  res.locals.lang = lang;
  res.locals.t = t;
  res.locals.path = req.path;
  res.locals.me = req.session.user || null;
  res.locals.money = (n) => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
  res.locals.ml = (k, s) => monthLabel(lang, k, s);
  res.locals.dl = dateLabel;
  res.locals.di = calc.dateInput;
  res.locals.mname = (m) => (!m ? '' : lang === 'gu' && m.nameGu ? m.nameGu : m.name);
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  try {
    res.locals.settings = await calc.getSettings();
    if (req.session.user) {
      const { User } = require('./src/models');
      res.locals.admins = await User.find({ role: 'admin', active: true }).populate('member');
    } else res.locals.admins = [];
  } catch (e) { return next(e); }
  next();
});

app.use(require('./src/routes/auth'));
app.use(require('./src/routes/sahay'));
app.use('/admin', require('./src/routes/admin'));
app.use(require('./src/routes/user'));

app.use((req, res) => res.status(404).render('message', { title: '404', text: 'Page not found' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('message', { title: 'Error', text: err.message });
});

mongoose.connect(MONGODB_URI, { dbName: DB_NAME }).then(() => {
  app.listen(PORT, () => console.log(`Bachat Mandal running on http://localhost:${PORT}`));
}).catch((e) => { console.error('MongoDB connection failed:', e.message); process.exit(1); });
