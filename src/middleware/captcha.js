function createCaptchaChallenge(req) {
  const left = Math.floor(Math.random() * 8) + 2;
  const right = Math.floor(Math.random() * 8) + 1;
  const op = Math.random() < 0.5 ? '+' : '-';
  const answer = op === '+' ? left + right : left - right;

  req.session.captcha = {
    answer: String(answer),
    createdAt: Date.now(),
  };

  return `${left} ${op} ${right} = ?`;
}

function validateCaptcha(req, value) {
  const expected = req.session?.captcha?.answer;
  if (!expected) return false;
  const provided = String(value || '').trim();
  return provided === expected;
}

module.exports = {
  createCaptchaChallenge,
  validateCaptcha,
};

