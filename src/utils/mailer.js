const nodemailer = require('nodemailer');

let transporter = null;

function toBool(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') return true;
  if (normalized === 'false' || normalized === '0') return false;
  return fallback;
}

function getMailConfig() {
  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 465);
  const secure = toBool(process.env.SMTP_SECURE, port === 465);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.MAIL_FROM || user;
  const to = process.env.MAIL_TO;

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    to,
    enabled: Boolean(host && user && pass && from && to),
  };
}

function getTransporter(config) {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
    tls: {
      rejectUnauthorized: toBool(process.env.SMTP_TLS_REJECT_UNAUTHORIZED, true),
    },
  });

  return transporter;
}

async function sendContactNotification(data) {
  const config = getMailConfig();
  if (!config.enabled) {
    return { sent: false, skipped: true, reason: 'missing_mail_config' };
  }

  const transport = getTransporter(config);
  const subject = data.subject ? `[Kontakt] ${data.subject}` : '[Kontakt] Neue Anfrage';
  const textLines = [
    'Neue Kontaktanfrage eingegangen.',
    '',
    `Name: ${data.name || '-'}`,
    `E-Mail: ${data.email || '-'}`,
    `Telefon: ${data.phone || '-'}`,
    `Quelle: ${data.sourcePage || '-'}`,
    '',
    'Nachricht:',
    data.message || '-',
  ];

  const htmlMessage = String(data.message || '-').replace(/\n/g, '<br/>');
  const html = `
    <h3>Neue Kontaktanfrage</h3>
    <p><strong>Name:</strong> ${data.name || '-'}</p>
    <p><strong>E-Mail:</strong> ${data.email || '-'}</p>
    <p><strong>Telefon:</strong> ${data.phone || '-'}</p>
    <p><strong>Quelle:</strong> ${data.sourcePage || '-'}</p>
    <p><strong>Nachricht:</strong><br/>${htmlMessage}</p>
  `;

  await transport.sendMail({
    from: config.from,
    to: config.to,
    replyTo: data.email || undefined,
    subject,
    text: textLines.join('\n'),
    html,
  });

  return { sent: true, skipped: false };
}

module.exports = { sendContactNotification, getMailConfig };
