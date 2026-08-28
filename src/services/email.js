import { ObjectId } from "mongodb";
import { getDb } from "../lib/mongo.js";
import { encryptSecret } from "../lib/secretCrypto.js";
import {
  applyTemplate,
  buildGoogleAuthUrl,
  exchangeGoogleCode,
  fetchGoogleProfile,
  getOAuthAccessToken,
  getOAuthRedirectUri,
  googleOAuthMissingKeys,
  isGoogleOAuthConfigured,
  sendViaGmailApi,
  signOAuthState,
  verifyOAuthState,
} from "../lib/gmail.js";
import { config } from "../config.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const BUILTIN_TEMPLATES = [
  {
    name: "Capacity check",
    subject: "MC {{mc}} — truck available",
    body: "Hi {{officer}},\n\nThis is dispatch reaching {{company}} (MC {{mc}}).\n\nDo you have a truck empty that can cover freight? Please call or reply with equipment and empty time.\n\nThanks,",
    isDefault: true,
  },
  {
    name: "Follow-up",
    subject: "Following up — MC {{mc}}",
    body: "Hi {{officer}},\n\nFollowing up with {{company}} (MC {{mc}}). Still looking for a truck if you have capacity.\n\nThanks,",
    isDefault: false,
  },
  {
    name: "Rate / availability",
    subject: "{{company}} — MC {{mc}}",
    body: "Hello {{company}},\n\nWe'd like to cover a load if you have a unit available. MC {{mc}}, {{trucks}} trucks on file, {{city}} {{state}}.\n\nPlease reply or call {{phone}}.\n\nBest,",
    isDefault: false,
  },
];

function httpError(message, status = 400, code = null) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  return error;
}

function uid(req) {
  return req.authUser?._id || new ObjectId(String(req.user.id));
}

function safeAccount(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    email: doc.email,
    method: doc.method,
    displayName: doc.displayName || "",
    isDefault: Boolean(doc.isDefault),
    connectedAt: doc.connectedAt,
    connected: true,
  };
}

function safeTemplate(doc) {
  return {
    id: String(doc._id),
    name: doc.name,
    subject: doc.subject,
    body: doc.body,
    isDefault: Boolean(doc.isDefault),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

async function accountsCol() {
  return (await getDb()).collection("email_accounts");
}

async function templatesCol() {
  return (await getDb()).collection("email_templates");
}

async function sentCol() {
  return (await getDb()).collection("email_sent");
}

async function listAccounts(userId) {
  return (await accountsCol()).find({ userId }).sort({ isDefault: -1, connectedAt: -1 }).toArray();
}

async function ensureDefaultAccount(userId, preferredId) {
  const col = await accountsCol();
  const accounts = await listAccounts(userId);
  if (!accounts.length) return null;
  let current = preferredId ? accounts.find((row) => String(row._id) === String(preferredId)) : null;
  current = current || accounts.find((row) => row.isDefault) || accounts[0];
  await col.updateMany({ userId }, { $set: { isDefault: false } });
  await col.updateOne({ _id: current._id }, { $set: { isDefault: true } });
  current.isDefault = true;
  return current;
}

async function seedTemplates(userId) {
  const col = await templatesCol();
  const count = await col.countDocuments({ userId });
  if (count) return;
  const now = new Date();
  await col.insertMany(
    BUILTIN_TEMPLATES.map((item) => ({
      userId,
      ...item,
      createdAt: now,
      updatedAt: now,
    })),
  );
}

async function loadAccountForSend(userId, accountId) {
  const col = await accountsCol();
  let account = null;
  if (accountId) {
    account = await col.findOne({ _id: new ObjectId(String(accountId)), userId });
  } else {
    account = await col.findOne({ userId, isDefault: true });
    if (!account) account = await col.findOne({ userId });
  }
  return account;
}

export async function getEmailStatus(req, res) {
  const userId = uid(req);
  await seedTemplates(userId);
  const accounts = await listAccounts(userId);
  const templates = await (await templatesCol()).find({ userId }).sort({ isDefault: -1, updatedAt: -1 }).toArray();
  const defaultAccount = accounts.find((row) => row.isDefault) || accounts[0] || null;
  res.json({
    ok: true,
    connected: accounts.length > 0,
    account: safeAccount(defaultAccount),
    accounts: accounts.map(safeAccount),
    oauthAvailable: isGoogleOAuthConfigured(),
    oauthMissing: googleOAuthMissingKeys(),
    redirectUri: getOAuthRedirectUri(),
    templates: templates.map(safeTemplate),
    variables: [
      { key: "company", label: "Company", token: "{{company}}" },
      { key: "legalName", label: "Legal name", token: "{{legalName}}" },
      { key: "officer", label: "Officer", token: "{{officer}}" },
      { key: "mc", label: "MC", token: "{{mc}}" },
      { key: "dot", label: "USDOT", token: "{{dot}}" },
      { key: "phone", label: "Phone", token: "{{phone}}" },
      { key: "email", label: "Email", token: "{{email}}" },
      { key: "city", label: "City", token: "{{city}}" },
      { key: "state", label: "State", token: "{{state}}" },
      { key: "zip", label: "ZIP", token: "{{zip}}" },
      { key: "trucks", label: "Trucks", token: "{{trucks}}" },
      { key: "safety", label: "Safety", token: "{{safety}}" },
      { key: "to", label: "To", token: "{{to}}" },
    ],
  });
}

export async function getOAuthUrl(req, res) {
  if (!isGoogleOAuthConfigured()) {
    throw httpError(
      "Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in backend/.env.",
      400,
      "OAUTH_NOT_CONFIGURED",
    );
  }
  const state = signOAuthState(uid(req));
  res.json({
    ok: true,
    url: buildGoogleAuthUrl(state),
    redirectUri: getOAuthRedirectUri(),
  });
}

export async function oauthCallback(req, res) {
  const fail = (message) => {
    const url = new URL(config.frontendOrigin);
    url.searchParams.set("gmail", "error");
    url.searchParams.set("page", "templates");
    url.searchParams.set("message", String(message || "OAuth failed").slice(0, 280));
    return res.redirect(302, url.toString());
  };

  try {
    const { code, state, error, error_description: errorDescription } = req.query || {};
    if (error) return fail(errorDescription || error);
    if (!code || !state) return fail("Missing OAuth code");

    const { userId } = verifyOAuthState(state);
    const tokens = await exchangeGoogleCode(String(code));
    const profile = await fetchGoogleProfile(tokens.access_token);
    const email = String(profile.email).toLowerCase();
    const owner = new ObjectId(String(userId));
    const col = await accountsCol();
    const existing = await col.findOne({ userId: owner, email });

    let refreshTokenEnc = encryptSecret(tokens.refresh_token || "");
    if (!tokens.refresh_token) {
      if (existing?.refreshTokenEnc) refreshTokenEnc = existing.refreshTokenEnc;
      else return fail("Google did not return a refresh token. Remove app access and try again.");
    }

    const now = new Date();
    const payload = {
      userId: owner,
      email,
      method: "oauth",
      displayName: profile.name || "",
      refreshTokenEnc,
      accessTokenEnc: encryptSecret(tokens.access_token),
      accessTokenExpiresAt: new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000),
      isDefault: existing?.isDefault || false,
      connectedAt: now,
      updatedAt: now,
    };

    await col.updateOne(
      { userId: owner, email },
      { $set: payload, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );

    const hasDefault = await col.findOne({ userId: owner, isDefault: true });
    if (!hasDefault) await ensureDefaultAccount(owner);

    const url = new URL(config.frontendOrigin);
    url.searchParams.set("gmail", "ok");
    url.searchParams.set("email", profile.email);
    url.searchParams.set("page", "templates");
    return res.redirect(302, url.toString());
  } catch (error) {
    return fail(error.message || "OAuth failed");
  }
}

export async function disconnectAccount(req, res) {
  const userId = uid(req);
  const col = await accountsCol();
  const accountId = req.body?.accountId;
  if (accountId) {
    const result = await col.deleteOne({ _id: new ObjectId(String(accountId)), userId });
    if (!result.deletedCount) throw httpError("Account not found", 404);
  } else {
    await col.deleteMany({ userId });
  }
  await ensureDefaultAccount(userId);
  const accounts = await listAccounts(userId);
  res.json({ ok: true, connected: accounts.length > 0, accounts: accounts.map(safeAccount) });
}

export async function setDefaultAccount(req, res) {
  const userId = uid(req);
  const accountId = req.body?.accountId;
  if (!accountId) throw httpError("accountId is required");
  const current = await ensureDefaultAccount(userId, accountId);
  if (!current) throw httpError("Account not found", 404);
  const accounts = await listAccounts(userId);
  res.json({ ok: true, accounts: accounts.map(safeAccount), account: safeAccount(current) });
}

export async function createTemplate(req, res) {
  const userId = uid(req);
  const name = String(req.body?.name || "").trim();
  const subject = String(req.body?.subject || "").trim();
  const body = String(req.body?.body || "");
  const isDefault = Boolean(req.body?.isDefault);
  if (!name || !subject || !body.trim()) throw httpError("Name, subject, and body are required");
  const col = await templatesCol();
  if (isDefault) await col.updateMany({ userId }, { $set: { isDefault: false } });
  const now = new Date();
  try {
    const result = await col.insertOne({ userId, name, subject, body, isDefault, createdAt: now, updatedAt: now });
    const template = await col.findOne({ _id: result.insertedId });
    res.status(201).json({ ok: true, template: safeTemplate(template) });
  } catch (error) {
    if (error?.code === 11000) throw httpError("A template with that name already exists", 409);
    throw error;
  }
}

export async function updateTemplate(req, res) {
  const userId = uid(req);
  const col = await templatesCol();
  const template = await col.findOne({ _id: new ObjectId(String(req.params.id)), userId });
  if (!template) throw httpError("Template not found", 404);
  const patch = { updatedAt: new Date() };
  if (req.body?.name != null) patch.name = String(req.body.name).trim();
  if (req.body?.subject != null) patch.subject = String(req.body.subject).trim();
  if (req.body?.body != null) patch.body = String(req.body.body);
  if (req.body?.isDefault === true) {
    await col.updateMany({ userId }, { $set: { isDefault: false } });
    patch.isDefault = true;
  } else if (req.body?.isDefault === false) {
    patch.isDefault = false;
  }
  const next = { ...template, ...patch };
  if (!next.name || !next.subject || !String(next.body).trim()) {
    throw httpError("Name, subject, and body are required");
  }
  try {
    await col.updateOne({ _id: template._id }, { $set: patch });
    res.json({ ok: true, template: safeTemplate({ ...template, ...patch }) });
  } catch (error) {
    if (error?.code === 11000) throw httpError("A template with that name already exists", 409);
    throw error;
  }
}

export async function deleteTemplate(req, res) {
  const userId = uid(req);
  const result = await (await templatesCol()).deleteOne({
    _id: new ObjectId(String(req.params.id)),
    userId,
  });
  if (!result.deletedCount) throw httpError("Template not found", 404);
  res.json({ ok: true });
}

export async function sendEmail(req, res) {
  const userId = uid(req);
  const account = await loadAccountForSend(userId, req.body?.accountId);
  if (!account) throw httpError("Connect a Gmail account first", 400, "GMAIL_NOT_CONNECTED");

  const to = String(req.body?.to || "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(to)) throw httpError("Enter a valid recipient email");

  let subject = String(req.body?.subject || "").trim();
  let body = String(req.body?.body || "");
  const templateId = req.body?.templateId;
  const vars = {
    email: to,
    to,
    ...(req.body?.vars && typeof req.body.vars === "object" ? req.body.vars : {}),
  };

  if (templateId) {
    const template = await (await templatesCol()).findOne({
      _id: new ObjectId(String(templateId)),
      userId,
    });
    if (!template) throw httpError("Template not found", 404);
    if (!subject) subject = applyTemplate(template.subject, vars);
    if (!body.trim()) body = applyTemplate(template.body, vars);
    else {
      subject = applyTemplate(subject, vars);
      body = applyTemplate(body, vars);
    }
  } else {
    subject = applyTemplate(subject, vars);
    body = applyTemplate(body, vars);
  }

  if (!subject || !body.trim()) throw httpError("Subject and body are required");

  const result = await sendViaGmailApi(account, { to, subject, body });
  await persistAccountTokens(account);

  await (await sentCol()).insertOne({
    userId,
    accountId: account._id,
    templateId: templateId ? new ObjectId(String(templateId)) : null,
    from: account.email,
    to,
    subject,
    body,
    method: "oauth",
    messageId: result.messageId || "",
    vars,
    createdAt: new Date(),
  });

  res.json({ ok: true, from: account.email, ...result });
}

const MAX_BULK = 40;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function persistAccountTokens(account) {
  await (await accountsCol()).updateOne(
    { _id: account._id },
    {
      $set: {
        accessTokenEnc: account.accessTokenEnc,
        accessTokenExpiresAt: account.accessTokenExpiresAt,
        refreshTokenEnc: account.refreshTokenEnc,
        updatedAt: new Date(),
      },
    },
  );
}

export async function sendBulk(req, res) {
  const userId = uid(req);
  const account = await loadAccountForSend(userId, req.body?.accountId);
  if (!account) throw httpError("Connect a Gmail account first", 400, "GMAIL_NOT_CONNECTED");

  const templateId = String(req.body?.templateId || "").trim();
  if (!templateId) throw httpError("Select a template");
  const template = await (await templatesCol()).findOne({
    _id: new ObjectId(templateId),
    userId,
  });
  if (!template) throw httpError("Template not found", 404);

  const incoming = Array.isArray(req.body?.recipients) ? req.body.recipients : [];
  if (!incoming.length) throw httpError("No recipients");
  if (incoming.length > MAX_BULK) {
    throw httpError(`Send at most ${MAX_BULK} emails per batch`, 400, "BULK_LIMIT");
  }

  const sent = [];
  const failed = [];
  const skipped = [];
  const seen = new Set();

  for (const row of incoming) {
    const to = String(row?.to || "")
      .trim()
      .toLowerCase();
    if (!EMAIL_RE.test(to)) {
      skipped.push({ to: to || "", reason: "Invalid email" });
      continue;
    }
    if (seen.has(to)) {
      skipped.push({ to, reason: "Duplicate" });
      continue;
    }
    seen.add(to);

    const vars = {
      email: to,
      to,
      ...(row?.vars && typeof row.vars === "object" ? row.vars : {}),
    };
    const subject = applyTemplate(template.subject, vars).trim();
    const body = applyTemplate(template.body, vars);
    if (!subject || !body.trim()) {
      failed.push({ to, error: "Template is empty after filling fields" });
      continue;
    }

    try {
      const result = await sendViaGmailApi(account, { to, subject, body });
      await (await sentCol()).insertOne({
        userId,
        accountId: account._id,
        templateId: template._id,
        from: account.email,
        to,
        subject,
        body,
        method: "oauth",
        messageId: result.messageId || "",
        vars,
        bulk: true,
        createdAt: new Date(),
      });
      sent.push({ to, messageId: result.messageId || "" });
      await wait(120);
    } catch (error) {
      failed.push({ to, error: error.message || "Send failed" });
      if (/rate limit|too many|quota|429/i.test(String(error.message || ""))) break;
    }
  }

  await persistAccountTokens(account);
  res.json({
    ok: true,
    from: account.email,
    sent,
    failed,
    skipped,
    remainingStopped: incoming.length - sent.length - failed.length - skipped.length,
  });
}

export async function listSent(req, res) {
  const userId = uid(req);
  const items = await (await sentCol())
    .find({ userId })
    .sort({ createdAt: -1 })
    .limit(30)
    .toArray();
  res.json({
    ok: true,
    sent: items.map((item) => ({
      id: String(item._id),
      from: item.from,
      to: item.to,
      subject: item.subject,
      createdAt: item.createdAt,
    })),
  });
}

export { getOAuthAccessToken };
