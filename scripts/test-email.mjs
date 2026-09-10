import "dotenv/config";
import { config } from "../src/config.js";
import { fromAddress, isMailConfigured, mailStartupLine, sendMail, verifyMailer } from "../src/lib/mailer.js";

const to = process.argv[2] || process.env.TEST_EMAIL_TO || "";

if (!to) {
  console.error("Usage: node scripts/test-email.mjs <recipient@email.com>");
  process.exit(1);
}

if (!isMailConfigured()) {
  console.error("Mail is not configured. Set BREVO_API_KEY or SMTP_HOST/SMTP_USER/SMTP_PASS in backend/.env");
  process.exit(1);
}

function mask(value) {
  const raw = String(value || "");
  if (raw.length <= 8) return raw ? "****" : "(empty)";
  return `${raw.slice(0, 6)}…${raw.slice(-4)}`;
}

console.log("--- MC Scrapper mail test ---");
if (config.brevoApiKey) {
  console.log("Provider: Brevo API");
  console.log(`API key: ${mask(config.brevoApiKey)}`);
} else {
  console.log("Provider: SMTP");
  console.log(`Host: ${config.smtpHost}:${config.smtpPort} secure=${config.smtpSecure}`);
  console.log(`SMTP user: ${config.smtpUser || "(empty)"}`);
  console.log(`SMTP pass: ${mask(String(config.smtpPass || "").replace(/\s+/g, ""))}`);
  console.log("Note: Brevo SMTP user must be the login email shown in Brevo → SMTP & API → SMTP (not always the sender address).");
}
console.log(`From: ${fromAddress()}`);
console.log(`To: ${to}`);
console.log(mailStartupLine());
await verifyMailer();

const subject = "MC Scrapper — Brevo test email";
const text = [
  "This is a test email from MC Scrapper.",
  "",
  `Sent at: ${new Date().toISOString()}`,
  `From: ${fromAddress()}`,
  "",
  "If you received this, your Brevo mail setup is working.",
].join("\n");
const html = `
  <p>This is a test email from <strong>MC Scrapper</strong>.</p>
  <p>Sent at: ${new Date().toISOString()}</p>
  <p>From: ${fromAddress()}</p>
  <p>If you received this, your Brevo mail setup is working.</p>
`;

try {
  const result = await sendMail({ to, subject, text, html });
  console.log(`Test email sent to ${to} via ${result.via}`);
} catch (error) {
  console.error("Test email failed:", error.message);
  if (/535|authentication/i.test(error.message)) {
    console.error("");
    console.error("Brevo auth tips:");
    console.error("  1. SMTP_USER = login email in Brevo → SMTP & API → SMTP tab");
    console.error("  2. SMTP_PASS = SMTP key (starts with xsmtpsib-), not your Brevo account password");
    console.error("  3. MAIL_FROM = a verified sender in Brevo → Senders");
    console.error("  Or set BREVO_API_KEY instead (API key from Brevo → SMTP & API → API keys)");
  }
  process.exit(1);
}
