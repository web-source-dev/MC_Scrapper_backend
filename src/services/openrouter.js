import { config } from "../config.js";

const SYSTEM_PROMPT = `You write one-screen dispatch briefs. The reader is a freight dispatcher about to cover a load. They have 10 seconds.

Use only the JSON facts. Do not invent insurance, rates, lanes, or credit. If something is missing, skip it.

Reply with the take only, in this exact shape:

Take: Cover | Caution | Pass — <12 words>
Why: <one sentence a dispatcher can act on>
Call: <one sentence they say when the carrier answers, using the company name and MC if present>`;

function extractBrief(text) {
  const raw = String(text || "").trim();
  const take = raw.match(/Take:\s*/i);
  if (take) return raw.slice(raw.lastIndexOf(take[0])).trim();
  const marker = /Cover\s*\/\s*Caution\s*\/\s*Pass:/i;
  const match = raw.match(marker);
  if (!match) return raw;
  return raw.slice(raw.lastIndexOf(match[0])).trim();
}

function slimCarrier(carrier = {}, snapshot = null) {
  const snap = snapshot || carrier.snapshot || null;
  return {
    mc: carrier.mcDisplay || carrier.mcNumber || null,
    dot: carrier.dotNumber || null,
    legalName: carrier.legalName || null,
    dbaName: carrier.dbaName || null,
    location: carrier.location || carrier.physicalAddress?.line || null,
    phone: carrier.phone || null,
    officer: carrier.officer || null,
    trucks: carrier.trucks ?? carrier.fleet?.powerUnits ?? null,
    drivers: carrier.drivers ?? carrier.driverCounts?.total ?? null,
    equipment: carrier.equipment || [],
    cargo: carrier.cargo || [],
    hazmat: Boolean(carrier.hazmat),
    safetyRating: carrier.safetyRating || null,
    usdotStatus: carrier.usdotStatus || null,
    authorityStatus: carrier.authorityStatus || null,
    operationClass: carrier.operationClass || null,
    carrierOperation: carrier.carrierOperation || null,
    mcs150Date: carrier.mcs150Date || null,
    priorRevoke: Boolean(carrier.priorRevoke),
    snapshot: snap
      ? {
          available: snap.available,
          allowToOperate: snap.allowToOperate || null,
          outOfService: snap.outOfService || null,
          basics: (snap.basics || [])
            .filter((item) => item.onRoadDeficient || item.seriousDeficient)
            .map((item) => item.name)
            .filter(Boolean),
        }
      : null,
  };
}

export function isOpenRouterConfigured() {
  return Boolean(config.openRouterApiKey);
}

export function getOpenRouterModel() {
  return config.openRouterModel;
}

export async function briefCarrier(carrier, snapshot) {
  if (!isOpenRouterConfigured()) {
    throw Object.assign(new Error("Add OPENROUTER_API_KEY in backend/.env"), { status: 503 });
  }

  const facts = slimCarrier(carrier, snapshot);
  if (!facts.mc && !facts.dot && !facts.legalName) {
    throw Object.assign(new Error("Carrier details are missing"), { status: 400 });
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.frontendOrigin,
      "X-Title": "Carrier Verifier",
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      temperature: 0.2,
      max_tokens: 350,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(facts) },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.error?.message || payload.message || `OpenRouter ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status === 401 ? 502 : 502 });
  }

  const text = extractBrief(payload.choices?.[0]?.message?.content);
  if (!text) {
    throw Object.assign(new Error("The model returned an empty brief"), { status: 502 });
  }

  return {
    text,
    model: payload.model || config.openRouterModel,
  };
}

const REPORT_PROMPT = `You are a freight dispatcher writing about your own experience with a motor carrier. Another dispatcher on this desk will read it.

Write in the first person (I / my desk). This is what happened to you, not a generic incident report and not a policy notice.
Do not write "was reported for", "other dispatchers should", or "this carrier was flagged".
Keep it professional and specific to the clicked issues only.
Do not invent pickup times, cities, rates, equipment counts, or quotes.
2-3 sentences. Name the company and MC.

Output exactly:
REPORT: <the report>`;

function fallbackReport(carrier, words) {
  const name = carrier.dbaName || carrier.legalName || "this carrier";
  const mc = carrier.mcDisplay ? ` (${carrier.mcDisplay})` : "";
  const what = {
    "No-show": "they no-showed on a load I covered",
    Unreachable: "I could not get anyone on the phone",
    "Double broker": "it played out like a double broker on my load",
    Late: "they were late for me",
    "Wrong equipment": "they showed with the wrong equipment",
    "No tracking": "I never got tracking",
    "Failed to complete": "they did not complete the load for me",
    Unprofessional: "they were unprofessional with my desk",
    Detention: "I had a detention issue with them",
    Misrepresented: "they misrepresented what they could run",
  };
  const bits = words.map((word) => what[word] || String(word).toLowerCase());
  const experience =
    bits.length === 1 ? bits[0] : `${bits.slice(0, -1).join(", ")}, and ${bits[bits.length - 1]}`;
  return `I worked ${name}${mc} and ${experience}. I am logging it so the next person on this desk knows what I ran into.`;
}

function looksLikeReasoning(text) {
  return /the user wants|the json contains|i need to turn|let'?s do:|i('ll| will) produce|turn those words|based on the provided|i should (not invent|use the|create a)|something concise|clicked words/i.test(
    String(text || ""),
  );
}

function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<\|.*?\|>/g, "")
    .trim();
}

function extractReport(text) {
  const raw = stripThink(text);
  if (!raw) return "";

  const tagged = raw.match(/(?:^|\n)\s*REPORT:\s*([\s\S]+)/i);
  if (tagged) {
    const body = tagged[1]
      .trim()
      .split(/\n\n/)[0]
      .replace(/^["“']+|["”']+$/g, "")
      .trim();
    if (body && body.length <= 800 && !looksLikeReasoning(body)) return body;
  }

  const quotes = [...raw.matchAll(/[“"]([^"”\n]{8,200})[”"]/g)];
  const quoted = quotes.at(-1)?.[1]?.trim();
  if (quoted && !looksLikeReasoning(quoted)) return quoted;

  if (!looksLikeReasoning(raw) && raw.length <= 280 && !raw.includes("\n\n")) {
    return raw.replace(/^["“']+|["”']+$/g, "").trim();
  }

  return "";
}

export async function draftReport(carrier, words) {
  const facts = slimCarrier(carrier);
  const selected = Array.isArray(words)
    ? [...new Set(words.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
  if (!selected.length) {
    throw Object.assign(new Error("Click at least one word"), { status: 400 });
  }

  const fallback = fallbackReport(facts, selected);
  if (!isOpenRouterConfigured()) {
    return { text: fallback, model: "template" };
  }

  const who = [facts.legalName, facts.dbaName, facts.mc].filter(Boolean).join(" · ");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openRouterApiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": config.frontendOrigin,
      "X-Title": "Carrier Verifier",
    },
    body: JSON.stringify({
      model: config.openRouterModel,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: "system", content: REPORT_PROMPT },
        { role: "user", content: `${who}\nWords: ${selected.join(", ")}` },
      ],
    }),
    signal: AbortSignal.timeout(45000),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { text: fallback, model: "template" };
  }

  const message = payload.choices?.[0]?.message || {};
  const text = extractReport(message.content) || extractReport(message.reasoning);
  return {
    text: text || fallback,
    model: payload.model || config.openRouterModel,
  };
}
