import { Router } from "express";
import { EQUIPMENT_TYPES } from "../lib/equipment.js";
import { FLEET_PRESETS, MCS150_OPTIONS, SAFETY_RATINGS, SEARCH_MODES, US_STATES } from "../lib/searchModes.js";
import { enrichCarrierRecord, searchCarriers } from "../services/carrierSearch.js";
import { getQcProxyInfo, isQcMobileConfigured } from "../services/qcmobile.js";
import { briefCarrier, draftReport, getOpenRouterModel, isOpenRouterConfigured } from "../services/openrouter.js";
import { addReview, listReviews, REPORT_WORDS } from "../services/reviews.js";
import { config } from "../config.js";
import { assertCanSearch, countMatchedMcs, recordSearchUsage } from "../services/usage.js";

export const carriersRouter = Router();

const MODE_IDS = SEARCH_MODES.map((mode) => mode.id);
const STATE_IDS = new Set(US_STATES.map(([code]) => code));
const MAX_LIST = 250;
const MAX_RESULTS = Number.isFinite(config.maxResults) ? config.maxResults : 10000;

function httpError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseOptionalInt(value, fieldName) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw httpError(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function parseRequiredMc(value, fieldName) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw httpError(`${fieldName} must be a valid number`);
  }
  return parsed;
}

function parseIdList(value) {
  const raw = Array.isArray(value) ? value.join(" ") : String(value || "");
  const numbers = [
    ...new Set(
      raw
        .split(/[\s,;]+/)
        .map((part) => part.replace(/^(MC|MX|FF|USDOT|DOT)[-\s]*/i, "").replace(/\D/g, ""))
        .filter(Boolean)
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part) && part > 0),
    ),
  ];
  if (numbers.length === 0) throw httpError("Paste at least one MC or USDOT number");
  if (numbers.length > MAX_LIST) {
    throw httpError(`ID list cannot exceed ${MAX_LIST} numbers`);
  }
  return numbers;
}

function parsePhoneDigits(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length < 7) throw httpError("Enter at least 7 digits of the phone number");
  return digits.slice(-10);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  return value === true || value === "true" || value === "1";
}

carriersRouter.get("/equipment-types", (_req, res) => {
  res.json({
    equipmentTypes: EQUIPMENT_TYPES.map(({ id, label }) => ({ id, label })),
  });
});

carriersRouter.get("/meta", (_req, res) => {
  res.json({
    searchModes: SEARCH_MODES,
    equipmentTypes: EQUIPMENT_TYPES.map(({ id, label }) => ({ id, label })),
    safetyRatings: SAFETY_RATINGS,
    fleetPresets: FLEET_PRESETS,
    mcs150Options: MCS150_OPTIONS,
    states: US_STATES.map(([code, name]) => ({ code, name })),
    limits: {
      maxMcRange: config.maxMcRange,
      maxList: MAX_LIST,
      maxResults: MAX_RESULTS,
    },
    qcMobile: isQcMobileConfigured(),
    qcProxy: getQcProxyInfo(),
    openRouter: isOpenRouterConfigured(),
    openRouterModel: isOpenRouterConfigured() ? getOpenRouterModel() : null,
    reviewWords: REPORT_WORDS,
  });
});

carriersRouter.post("/carriers/brief", async (req, res, next) => {
  try {
    const body = req.body || {};
    const brief = await briefCarrier(body.carrier, body.snapshot);
    res.json({ ok: true, ...brief });
  } catch (error) {
    next(error);
  }
});

carriersRouter.get("/carriers/reviews", async (req, res, next) => {
  try {
    const mcNumber = req.query.mc ? parseRequiredMc(req.query.mc, "MC") : null;
    const dotNumber = req.query.dot ? parseRequiredMc(req.query.dot, "USDOT") : null;
    const reviews = await listReviews(mcNumber, dotNumber);
    res.json({ ok: true, reviews });
  } catch (error) {
    next(error);
  }
});

carriersRouter.post("/carriers/reviews/draft", async (req, res, next) => {
  try {
    const body = req.body || {};
    const draft = await draftReport(body.carrier, body.words);
    res.json({ ok: true, ...draft });
  } catch (error) {
    next(error);
  }
});

carriersRouter.post("/carriers/reviews", async (req, res, next) => {
  try {
    const body = req.body || {};
    const review = await addReview({
      ...body,
      dispatcher: body.dispatcher || req.user?.name || req.user?.email || null,
    });
    res.status(201).json({ ok: true, review });
  } catch (error) {
    next(error);
  }
});

carriersRouter.get("/carriers/snapshot", async (req, res, next) => {
  try {
    const mcNumber = req.query.mc ? parseRequiredMc(req.query.mc, "MC") : null;
    const dotNumber = req.query.dot ? parseRequiredMc(req.query.dot, "USDOT") : null;
    if (!mcNumber && !dotNumber) {
      throw httpError("Provide an MC or USDOT number");
    }
    const snapshot = await enrichCarrierRecord({ mcNumber, dotNumber });
    res.json({ ok: true, snapshot });
  } catch (error) {
    next(error);
  }
});

carriersRouter.post("/verify", async (req, res, next) => {
  try {
    const body = req.body || {};
    const searchMode = body.searchMode || "mc-range";
    if (!MODE_IDS.includes(searchMode)) {
      throw httpError("Unknown search mode");
    }

    const selectedEquipment = Array.isArray(body.equipmentTypes)
      ? body.equipmentTypes.filter((id) => EQUIPMENT_TYPES.some((type) => type.id === id))
      : [];
    const minTrucks = parseOptionalInt(body.minTrucks, "Minimum trucks");
    const maxTrucks = parseOptionalInt(body.maxTrucks, "Maximum trucks");
    if (minTrucks != null && maxTrucks != null && maxTrucks < minTrucks) {
      throw httpError("Maximum trucks must be greater than or equal to minimum trucks");
    }
    const minDrivers = parseOptionalInt(body.minDrivers, "Minimum drivers");
    const maxDrivers = parseOptionalInt(body.maxDrivers, "Maximum drivers");
    if (minDrivers != null && maxDrivers != null && maxDrivers < minDrivers) {
      throw httpError("Maximum drivers must be greater than or equal to minimum drivers");
    }

    const state = String(body.state || "").trim().toUpperCase();
    if (state && !STATE_IDS.has(state)) throw httpError("Choose a valid US state");
    const zip = String(body.zip || "").replace(/\D/g, "").slice(0, 5);
    const city = String(body.city || "").trim() || null;
    if (city && city.length < 2) throw httpError("City must be at least 2 characters");

    const safetyRating = SAFETY_RATINGS.some((item) => item.id === body.safetyRating)
      ? body.safetyRating
      : "any";
    const mcs150Months =
      body.mcs150Months === "12" || body.mcs150Months === 12
        ? 12
        : body.mcs150Months === "24" || body.mcs150Months === 24
          ? 24
          : null;
    const resultLimit = Math.min(
      MAX_RESULTS,
      Math.max(1, parseOptionalInt(body.resultLimit, "Result limit") || MAX_RESULTS),
    );

    const filters = {
      searchMode,
      equipmentTypes: selectedEquipment,
      minTrucks,
      maxTrucks,
      minDrivers,
      maxDrivers,
      state: state || null,
      city,
      zip: zip || null,
      safetyRating,
      mcs150Months,
      hazmatOnly: parseBoolean(body.hazmatOnly),
      requirePhone: parseBoolean(body.requirePhone),
      requireCell: parseBoolean(body.requireCell),
      requireEmail: parseBoolean(body.requireEmail),
      requireContact: parseBoolean(body.requireContact),
      interstateOnly: parseBoolean(body.interstateOnly),
      intrastateOnly: parseBoolean(body.intrastateOnly),
      freightOnly: parseBoolean(body.freightOnly),
      strictSafer: parseBoolean(body.strictSafer, true),
      resultLimit,
      identifierType: body.identifierType === "dot" ? "dot" : "mc",
    };

    if (searchMode === "mc-range") {
      const start = parseRequiredMc(body.startMc, "Start MC");
      const end = parseRequiredMc(body.endMc, "End MC");
      if (end < start) throw httpError("End MC must be greater than or equal to Start MC");
      if (end - start + 1 > config.maxMcRange) {
        throw httpError(`MC range cannot exceed ${config.maxMcRange.toLocaleString()} numbers`);
      }
      filters.startMc = start;
      filters.endMc = end;
    }

    if (searchMode === "mc-lookup") {
      filters.identifier = parseRequiredMc(body.identifier || body.mcNumber || body.dotNumber, "MC / DOT number");
    }

    if (searchMode === "id-list") {
      filters.idList = parseIdList(body.idList || body.mcList);
    }

    if (searchMode === "company-name") {
      const companyName = String(body.companyName || "").trim();
      if (companyName.length < 3) throw httpError("Company name must be at least 3 characters");
      if (companyName.length > 80) throw httpError("Company name is too long");
      filters.companyName = companyName;
    }

    if (searchMode === "location") {
      if (!filters.state) throw httpError("Choose a state");
    }

    if (searchMode === "phone") {
      filters.phone = parsePhoneDigits(body.phone);
    }

    const quota = await assertCanSearch(req.authUser);
    filters.resultLimit = Math.min(filters.resultLimit, Math.max(1, quota.remaining));

    const result = await searchCarriers(filters);
    const charged = countMatchedMcs(result.carriers);
    const usage = await recordSearchUsage(req.authUser, charged);
    if (result.meta) {
      result.meta.quotaCapped = filters.resultLimit < resultLimit;
      result.meta.charged = charged;
    }

    res.json({
      ok: true,
      filters: {
        ...filters,
        idList: filters.idList || [],
      },
      usage,
      ...result,
    });
  } catch (error) {
    next(error);
  }
});
