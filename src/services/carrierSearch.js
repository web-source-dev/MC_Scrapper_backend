import { SELECT_FIELDS } from "../lib/equipment.js";
import { mapCarrier } from "../lib/censusMap.js";
import { buildWhereClause, orderClause } from "../lib/soql.js";
import { querySoda21, querySoda3 } from "./socrataClient.js";
import { fetchQcSnapshot, isQcMobileConfigured } from "./qcmobile.js";
import { config } from "../config.js";

function summarize(carriers) {
  const withPhone = carriers.filter((carrier) => carrier.phone).length;
  const withEmail = carriers.filter((carrier) => carrier.email).length;
  const hazmat = carriers.filter((carrier) => carrier.hazmat).length;
  const states = [...new Set(carriers.map((carrier) => carrier.physicalAddress.state).filter(Boolean))];
  const truckTotal = carriers.reduce((sum, carrier) => sum + (carrier.trucks || 0), 0);

  return {
    withPhone,
    withEmail,
    hazmat,
    states: states.length,
    avgTrucks: carriers.length ? Math.round(truckTotal / carriers.length) : 0,
  };
}

async function fetchAllRows(where, { maxRows, order }) {
  const select = SELECT_FIELDS.join(", ");
  const query = `SELECT ${select} WHERE ${where} ORDER BY ${order}`;
  const pageSize = Math.min(config.pageSize, maxRows);
  const maxPages = Math.max(1, Math.ceil(maxRows / pageSize));
  const rows = [];

  try {
    for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
      const page = await querySoda3({ query, pageNumber, pageSize });
      if (!Array.isArray(page) || page.length === 0) {
        return { rows: rows.slice(0, maxRows), source: "soda3", truncated: false };
      }
      rows.push(...page);
      if (page.length < pageSize) {
        return { rows: rows.slice(0, maxRows), source: "soda3", truncated: false };
      }
      if (rows.length >= maxRows) {
        return { rows: rows.slice(0, maxRows), source: "soda3", truncated: true };
      }
    }
    return { rows: rows.slice(0, maxRows), source: "soda3", truncated: rows.length >= maxRows };
  } catch (soda3Error) {
    const fallback = [];
    for (let offset = 0; offset < pageSize * maxPages; offset += pageSize) {
      const page = await querySoda21({
        select,
        where,
        order,
        limit: pageSize,
        offset,
      });
      if (!Array.isArray(page) || page.length === 0) break;
      fallback.push(...page);
      if (page.length < pageSize || fallback.length >= maxRows) break;
    }
    return {
      rows: fallback.slice(0, maxRows),
      source: "soda2.1",
      fallbackReason: soda3Error.message,
      truncated: fallback.length >= maxRows,
    };
  }
}

async function enrichCarriers(carriers, searchMode) {
  const shouldEnrich =
    isQcMobileConfigured() &&
    (searchMode === "mc-lookup" || searchMode === "phone" || carriers.length === 1);
  if (!shouldEnrich) return carriers;

  return Promise.all(
    carriers.map(async (carrier) => {
      const snapshot = await fetchQcSnapshot({
        mcNumber: carrier.mcNumber,
        dotNumber: carrier.dotNumber,
      });
      return { ...carrier, snapshot };
    }),
  );
}

export async function searchCarriers(filters) {
  const where = buildWhereClause(filters);
  const maxRows = filters.resultLimit || 10000;
  const { rows, source, fallbackReason, truncated } = await fetchAllRows(where, {
    maxRows,
    order: orderClause(filters.searchMode),
  });

  const mapped = rows
    .map((row) => mapCarrier(row, filters))
    .sort((a, b) => {
      if (a.mcNumber && b.mcNumber) return a.mcNumber - b.mcNumber;
      return String(a.legalName || "").localeCompare(String(b.legalName || ""));
    });

  const unique = [];
  const seen = new Set();
  for (const carrier of mapped) {
    if (seen.has(carrier.id)) continue;
    seen.add(carrier.id);
    unique.push(carrier);
  }

  const carriers = await enrichCarriers(unique, filters.searchMode);

  return {
    carriers,
    meta: {
      source,
      fallbackReason: fallbackReason || null,
      dataset: config.datasetId,
      domain: config.socrataDomain,
      searchMode: filters.searchMode,
      qcMobile: isQcMobileConfigured(),
      scannedRange:
        filters.searchMode === "mc-range"
          ? { startMc: filters.startMc, endMc: filters.endMc }
          : null,
      returned: unique.length,
      truncated,
      resultLimit: maxRows,
      summary: summarize(unique),
    },
  };
}

export async function enrichCarrierRecord({ mcNumber, dotNumber }) {
  return fetchQcSnapshot({ mcNumber, dotNumber });
}
