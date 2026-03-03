function requireUser(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/konto/login');
  }
  return next();
}

module.exports = { requireUser };

