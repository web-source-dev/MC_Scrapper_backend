import { config } from "../config.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headers() {
  const next = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "MC-Scrapper/1.0 (SAFER census verifier)",
  };

  if (config.appToken) {
    next["X-App-Token"] = config.appToken;
  }

  return next;
}

async function parseError(response) {
  const text = await response.text();
  try {
    const json = JSON.parse(text);
    return json.message || json.error || text;
  } catch {
    return text.slice(0, 400) || response.statusText;
  }
}

async function fetchWithRetry(url, options, attempts = 4) {
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, options);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(await parseError(response));
        await sleep(400 * attempt);
        continue;
      }
      if (!response.ok) {
        throw new Error(await parseError(response));
      }
      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      await sleep(400 * attempt);
    }
  }

  throw lastError;
}

export async function querySoda3({ query, pageNumber = 1, pageSize = config.pageSize }) {
  const url = `${config.socrataDomain}/api/v3/views/${config.datasetId}/query.json`;
  return fetchWithRetry(url, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      query,
      page: { pageNumber, pageSize },
      includeSynthetic: false,
    }),
  });
}

export async function querySoda21({ select, where, limit, offset, order }) {
  const params = new URLSearchParams();
  if (select) params.set("$select", select);
  if (where) params.set("$where", where);
  if (order) params.set("$order", order);
  if (limit != null) params.set("$limit", String(limit));
  if (offset != null) params.set("$offset", String(offset));

  const url = `${config.socrataDomain}/resource/${config.datasetId}.json?${params.toString()}`;
  const requestHeaders = { Accept: "application/json" };
  if (config.appToken) requestHeaders["X-App-Token"] = config.appToken;

  return fetchWithRetry(url, { method: "GET", headers: requestHeaders });
}
