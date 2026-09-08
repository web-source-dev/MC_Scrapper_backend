import nodemailer from "nodemailer";
import { config } from "../config.js";

function smtpPass() {
  return String(config.smtpPass || "").replace(/\s+/g, "");
}

function smtpPort() {
  return config.smtpPort === 465 ? 465 : config.smtpPort || 587;
}

function smtpUseSsl() {
  const port = smtpPort();
  if (port === 465) return true;
  if (port === 587) return false;
  return Boolean(config.smtpSecure);
}

function extractEmail(value) {
  const raw = String(value || "").trim();
  const angle = raw.match(/<([^>]+)>/);
  return (angle ? angle[1] : raw).trim().toLowerCase();
}

export function fromAddress() {
  const smtpUser = String(config.smtpUser || "").trim();
  const configured = String(config.mailFrom || "").trim();
  if (smtpUser) {
    const fromEmail = configured ? extractEmail(configured) : "";
    if (!fromEmail || fromEmail !== smtpUser.toLowerCase()) {
      return `MC Scrapper <${smtpUser}>`;
    }
    return configured.includes("<") ? configured : `MC Scrapper <${configured}>`;
  }
  return configured || "MC Scrapper <noreply@mcscraper.site>";
}

export function isMailConfigured() {
  return Boolean(config.resendApiKey || (config.smtpHost && config.smtpUser && smtpPass()));
}

function createSmtpTransport() {
  return nodemailer.createTransport({
    host: config.smtpHost,
    port: smtpPort(),
    secure: smtpUseSsl(),
    requireTLS: smtpPort() === 587,
    auth: { user: config.smtpUser, pass: smtpPass() },
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 20_000,
  });
}

async function sendViaResend({ to, subject, text, html }) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress(),
      to: [to],
      subject,
      text,
      html,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Resend failed (${response.status}) ${body.slice(0, 180)}`);
  }
}

async function sendViaSmtp({ to, subject, text, html }) {
  const transporter = createSmtpTransport();
  await transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
}

function logOtpToConsole({ to, subject, text }) {
  console.warn(`[mail] SMTP/Resend unavailable — console OTP\nTo: ${to}\nSubject: ${subject}\n${text}`);
}

export async function sendMail({ to, subject, text, html }) {
  if (config.resendApiKey) {
    await sendViaResend({ to, subject, text, html });
    return { delivered: true, via: "resend" };
  }
  if (config.smtpHost && config.smtpUser && smtpPass()) {
    await sendViaSmtp({ to, subject, text, html });
    return { delivered: true, via: "smtp" };
  }
  if (!config.isProduction) {
    logOtpToConsole({ to, subject, text });
    return { delivered: false, via: "log" };
  }
  const error = new Error("We couldn't send a verification email. Try again later.");
  error.status = 503;
  error.code = "MAIL_NOT_CONFIGURED";
  throw error;
}

export async function sendSignupOtp({ to, code, name }) {
  const greeting = name ? `Hi ${name},` : "Hi,";
  const text = [
    greeting,
    "",
    `Your MC Scrapper verification code is ${code}.`,
    "It expires in 10 minutes.",
    "",
    "If you didn't create an account, you can ignore this email.",
  ].join("\n");
  const html = `
    <p>${greeting}</p>
    <p>Your MC Scrapper verification code is:</p>
    <p style="font-size:28px;letter-spacing:6px;font-weight:700;font-family:ui-monospace,monospace">${code}</p>
    <p>This code expires in 10 minutes. If you didn't create an account, ignore this email.</p>
  `;
  const payload = {
    to,
    subject: `${code} is your MC Scrapper code`,
    text,
    html,
  };

  try {
    const result = await sendMail(payload);
    if (result.via === "log") {
      console.log(`[mail] verification code for ${to} is in the log above`);
    } else {
      console.log(`[mail] verification email sent via ${result.via} to ${to} from ${fromAddress()}`);
    }
    return result;
  } catch (error) {
    console.error(`[mail] send failed (${error.message})`);
    if (!config.isProduction) {
      logOtpToConsole(payload);
      console.log("[mail] using console OTP so local signup can continue");
      return { delivered: false, via: "log" };
    }
    throw error;
  }
}

export async function verifyMailer() {
  if (config.resendApiKey) return;
  if (!(config.smtpHost && config.smtpUser && smtpPass())) return;
  try {
    await createSmtpTransport().verify();
    console.log("[mail] SMTP connection ok");
  } catch (error) {
    console.error("[mail] SMTP verify failed:", error.message);
  }
}

export function mailStartupLine() {
  if (config.resendApiKey) return "Mail: Resend";
  if (config.smtpHost && config.smtpUser && smtpPass()) {
    return `Mail: SMTP ${config.smtpHost}:${smtpPort()} ssl=${smtpUseSsl()} from=${fromAddress()}`;
  }
  return config.isProduction ? "Mail: not configured" : "Mail: console OTP (set SMTP or Resend)";
}
