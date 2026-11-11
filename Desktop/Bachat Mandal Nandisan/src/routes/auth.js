const router = require('express').Router();
const bcrypt = require('bcryptjs');
const { User } = require('../models');
const { requireLogin, flash, audit } = require('../lib/auth');

router.get('/lang/:l', (req, res) => {
  req.session.lang = req.params.l === 'en' ? 'en' : 'gu';
  res.redirect(req.get('Referer') || '/');
});

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null, username: '' });
});

router.post('/login', async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase();
  const user = await User.findOne({ username, active: true });
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.passwordHash));
  if (!ok) return res.status(401).render('login', { error: res.locals.t('badLogin'), username });
  user.lastLogin = new Date();
  await user.save();
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.lang = res.locals.lang;
    req.session.user = {
      _id: String(user._id), username: user.username, role: user.role,
      group: user.group ? String(user.group) : null, displayName: user.displayName,
      mustChangePassword: user.mustChangePassword,
    };
    audit(req, 'login');
    res.redirect(user.role === 'admin' ? '/admin' : '/');
  });
});

router.post('/logout', (req, res) => {
  const lang = req.session.lang;
  req.session.regenerate(() => { req.session.lang = lang; res.redirect('/login'); });
});

router.get('/change-password', requireLogin, (req, res) => res.render('change-password', { error: null }));
router.post('/change-password', requireLogin, async (req, res) => {
  const { t } = res.locals;
  const { current, password, confirm } = req.body;
  const user = await User.findById(req.session.user._id);
  if (!user || !(await bcrypt.compare(String(current || ''), user.passwordHash))) return res.render('change-password', { error: t('badLogin') });
  if (!password || password.length < 6) return res.render('change-password', { error: t('pwShort') });
  if (password !== confirm) return res.render('change-password', { error: t('pwMismatch') });
  user.passwordHash = await bcrypt.hash(password, 10);
  user.mustChangePassword = false;
  await user.save();
  req.session.user.mustChangePassword = false;
  await audit(req, 'change-password');
  flash(req, 'ok', t('pwChanged'));
  res.redirect(user.role === 'admin' ? '/admin' : '/');
});

module.exports = router;
