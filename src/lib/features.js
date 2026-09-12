export const FEATURES = [
  {
    id: "search_identity",
    label: "MC, USDOT & company search",
    blurb: "MC range, single MC/DOT, pasted lists, and company name.",
  },
  {
    id: "export_csv",
    label: "Export CSV",
    blurb: "Download matched carriers.",
  },
  {
    id: "filters_fleet_safety",
    label: "Fleet & safety filters",
    blurb: "Fleet size, safety rating, and MCS-150 recency.",
  },
  {
    id: "filters_contacts",
    label: "Phone & email filters",
    blurb: "Require phone, cell, email, or any contact.",
  },
  {
    id: "search_multimode",
    label: "Multi-mode search",
    blurb: "Location and phone search in addition to MC, USDOT, and company.",
  },
  {
    id: "filters_advanced",
    label: "Advanced filters",
    blurb: "Equipment, cargo categories, hazmat, interstate, and truck/driver bounds.",
  },
  {
    id: "priority_support",
    label: "Priority support",
    blurb: "Faster help when you message the desk.",
  },
];

export const FEATURE_IDS = FEATURES.map((item) => item.id);
const FEATURE_SET = new Set(FEATURE_IDS);

export const IDENTITY_MODES = ["mc-range", "mc-lookup", "id-list", "company-name"];
export const MULTIMODE_MODES = ["location", "phone"];

export const PLAN_FEATURES = {
  free: ["search_identity", "export_csv"],
  standard: ["search_identity", "export_csv", "filters_fleet_safety", "filters_contacts"],
  plus: [
    "search_identity",
    "export_csv",
    "filters_fleet_safety",
    "filters_contacts",
    "search_multimode",
    "filters_advanced",
    "priority_support",
  ],
  premium: [...FEATURE_IDS],
};

export function isFeatureId(value) {
  return FEATURE_SET.has(String(value || ""));
}

export function sanitizeFeatures(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const next = [];
  for (const item of value) {
    const id = String(item || "");
    if (!FEATURE_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    next.push(id);
  }
  return next;
}

export function featuresForPlan(planId) {
  if (planId === "custom") return [...FEATURE_IDS];
  return [...(PLAN_FEATURES[planId] || PLAN_FEATURES.free)];
}

export function allFeatureIds() {
  return [...FEATURE_IDS];
}

export function hasFeature(features, id) {
  return Array.isArray(features) && features.includes(id);
}

export function allowedSearchModes(features) {
  const modes = [];
  if (hasFeature(features, "search_identity")) modes.push(...IDENTITY_MODES);
  if (hasFeature(features, "search_multimode")) modes.push(...MULTIMODE_MODES);
  return modes;
}

export function resolveFeatures(user) {
  const planId = String(user?.plan || "free");
  if (planId === "custom") {
    if (Array.isArray(user?.customFeatures)) return sanitizeFeatures(user.customFeatures);
    return allFeatureIds();
  }
  return featuresForPlan(planId);
}

function featureError(message) {
  const error = new Error(message);
  error.status = 403;
  error.code = "FEATURE_LOCKED";
  return error;
}

export function assertSearchEntitlements(user, filters = {}) {
  const features = resolveFeatures(user);
  const allowed = allowedSearchModes(features);
  const mode = String(filters.searchMode || "mc-range");

  if (!allowed.includes(mode)) {
    if (MULTIMODE_MODES.includes(mode)) {
      throw featureError("Location and phone search are on Plus and above. Message us to change your plan.");
    }
    throw featureError("This search mode is not on your plan. Message us to change your plan.");
  }

  const fleetOn = filters.fleetPreset && filters.fleetPreset !== "any";
  const safetyOn = filters.safetyRating && filters.safetyRating !== "any";
  const mcsOn = Boolean(filters.mcs150Months);
  if ((fleetOn || safetyOn || mcsOn) && !hasFeature(features, "filters_fleet_safety")) {
    throw featureError("Fleet and safety filters are on Standard and above. Message us to change your plan.");
  }

  const contactOn =
    Boolean(filters.requirePhone) ||
    Boolean(filters.requireCell) ||
    Boolean(filters.requireEmail) ||
    Boolean(filters.requireContact);
  if (contactOn && !hasFeature(features, "filters_contacts")) {
    throw featureError("Phone and email filters are on Standard and above. Message us to change your plan.");
  }

  const minTrucks = Number(filters.minTrucks);
  const maxTrucks = Number(filters.maxTrucks);
  const customFleetBounds =
    !fleetOn &&
    ((Number.isFinite(minTrucks) && minTrucks > 1) || (Number.isFinite(maxTrucks) && maxTrucks > 0));
  const advancedOn =
    (Array.isArray(filters.equipmentTypes) && filters.equipmentTypes.length > 0) ||
    (Array.isArray(filters.cargoTypes) && filters.cargoTypes.length > 0) ||
    Boolean(filters.hazmatOnly) ||
    Boolean(filters.interstateOnly) ||
    Boolean(filters.intrastateOnly) ||
    Boolean(filters.freightOnly) ||
    filters.minDrivers != null ||
    filters.maxDrivers != null ||
    customFleetBounds ||
    (mode !== "location" && Boolean(filters.city || filters.zip));

  if (advancedOn && !hasFeature(features, "filters_advanced")) {
    throw featureError("Advanced filters are on Plus and above. Message us to change your plan.");
  }

  return features;
}
