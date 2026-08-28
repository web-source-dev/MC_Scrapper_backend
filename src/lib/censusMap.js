import { CARGO_FIELDS, CARGO_LABELS, EQUIPMENT_TYPES } from "./equipment.js";

export function toNumber(value) {
  const parsed = Number.parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function toNullableNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value).replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatPhone(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return digits || null;
}

export function formatCensusDate(value) {
  const raw = String(value || "").replace(/\D/g, "");
  if (raw.length < 8) return value || null;
  return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
}

function statusWord(code) {
  if (code === "A") return "Active";
  if (code === "I") return "Inactive";
  if (code === "P") return "Pending";
  return code || null;
}

function docketStatusWord(code) {
  if (code === "A") return "Active";
  if (code === "I") return "Inactive / revoked";
  if (code === "P") return "Pending";
  return code || null;
}

function safetyLabel(code) {
  const map = { S: "Satisfactory", C: "Conditional", U: "Unsatisfactory" };
  return map[code] || (code ? String(code) : "Not rated");
}

function operationLabel(code) {
  const map = {
    A: "Interstate",
    B: "Intrastate hazmat",
    C: "Intrastate non-hazmat",
  };
  return map[code] || code || null;
}

function reviewLabel(code) {
  const map = { C: "Compliance review", S: "Safety review", A: "Audit" };
  return map[code] || code || null;
}

function units(row, owned, term, trip) {
  return {
    owned: toNumber(row[owned]),
    termLeased: toNumber(row[term]),
    tripLeased: toNumber(row[trip]),
    total: toNumber(row[owned]) + toNumber(row[term]) + toNumber(row[trip]),
  };
}

function dockets(row) {
  return [1, 2, 3]
    .map((index) => {
      const prefix = row[`docket${index}prefix`] || null;
      const number = toNullableNumber(row[`docket${index}`]);
      const status = row[`docket${index}_status_code`] || null;
      if (!prefix && number == null) return null;
      return {
        prefix,
        number,
        status,
        statusLabel: docketStatusWord(status),
        display: prefix && number != null ? `${prefix}-${number}` : null,
      };
    })
    .filter(Boolean);
}

function cargoList(row) {
  return CARGO_FIELDS.filter((field) => row[field] === "X").map((field) => CARGO_LABELS[field]);
}

function equipmentMatches(row) {
  const labels = EQUIPMENT_TYPES.filter((type) =>
    type.cargoFields.some((field) => row[field] === "X"),
  ).map((type) => type.label);
  if (labels.includes("Dry Van") && labels.includes("Power Only")) {
    return labels.filter((label) => label !== "Power Only");
  }
  return labels;
}

function address(street, city, state, zip, country) {
  return {
    street: street || null,
    city: city || null,
    state: state || null,
    zip: zip || null,
    country: country || null,
    line: [street, city, state, zip, country].filter(Boolean).join(", ") || null,
  };
}

function activeMcSlots(row) {
  return dockets(row).filter((item) => item.prefix === "MC" && item.number != null);
}

export function pickMc(row, filters = {}) {
  const slots = activeMcSlots(row);
  const { startMc, endMc, idList = [], identifier, identifierType, searchMode } = filters;

  if (searchMode === "mc-range" && startMc != null && endMc != null) {
    const match = slots.find((slot) => slot.status === "A" && slot.number >= startMc && slot.number <= endMc);
    if (match) return match.number;
  }

  if ((searchMode === "mc-lookup" || searchMode === "id-list") && identifierType !== "dot") {
    const wanted = searchMode === "mc-lookup" ? [Number(identifier)] : idList.map(Number);
    const match = slots.find((slot) => wanted.includes(slot.number));
    if (match) return match.number;
  }

  const active = slots.find((slot) => slot.status === "A");
  return active?.number ?? slots[0]?.number ?? null;
}

export function mapCarrier(row, filters = {}) {
  const mcNumber = pickMc(row, filters);
  const dotNumber = toNullableNumber(row.dot_number);
  const allDockets = dockets(row);
  const matched = allDockets.find((item) => item.prefix === "MC" && item.number === mcNumber);

  return {
    id: `${mcNumber || "none"}-${dotNumber || "none"}`,
    mcNumber,
    mcDisplay: mcNumber != null ? `MC-${mcNumber}` : null,
    dotNumber,
    legalName: row.legal_name || null,
    dbaName: row.dba_name || null,
    phone: formatPhone(row.phone),
    cellPhone: formatPhone(row.cell_phone),
    fax: formatPhone(row.fax),
    email: row.email_address || null,
    officer: row.company_officer_1 || null,
    officer2: row.company_officer_2 || null,
    businessType: row.business_org_desc || null,
    duns: row.dun_bradstreet_no && row.dun_bradstreet_no !== "0" ? row.dun_bradstreet_no : null,
    addedDate: formatCensusDate(row.add_date),
    operationClass: row.classdef || null,
    carrierOperation: operationLabel(row.carrier_operation),
    physicalAddress: address(row.phy_street, row.phy_city, row.phy_state, row.phy_zip, row.phy_country),
    mailingAddress: address(
      row.carrier_mailing_street,
      row.carrier_mailing_city,
      row.carrier_mailing_state,
      row.carrier_mailing_zip,
      row.carrier_mailing_country,
    ),
    location: [row.phy_city, row.phy_state].filter(Boolean).join(", ") || null,
    trucks: toNumber(row.power_units),
    truckUnits: toNumber(row.truck_units),
    busUnits: toNumber(row.bus_units),
    drivers: toNumber(row.total_drivers),
    fleet: {
      powerUnits: toNumber(row.power_units),
      truckUnits: toNumber(row.truck_units),
      busUnits: toNumber(row.bus_units),
      trucks: units(row, "owntruck", "trmtruck", "trptruck"),
      tractors: units(row, "owntract", "trmtract", "trptract"),
      trailers: units(row, "owntrail", "trmtrail", "trptrail"),
    },
    driverCounts: {
      total: toNumber(row.total_drivers),
      cdl: toNumber(row.total_cdl),
      interstate: toNumber(row.driver_inter_total),
      intrastate: toNumber(row.total_intrastate_drivers),
      leasedMonthly: toNumber(row.avg_drivers_leased_per_month),
      interstateBeyond100: toNumber(row.interstate_beyond_100_miles),
      interstateWithin100: toNumber(row.interstate_within_100_miles),
      intrastateBeyond100: toNumber(row.intrastate_beyond_100_miles),
      intrastateWithin100: toNumber(row.intrastate_within_100_miles),
    },
    dockets: allDockets,
    equipment: equipmentMatches(row),
    cargo: cargoList(row),
    hazmat: row.hm_ind === "Y",
    safetyRating: safetyLabel(row.safety_rating),
    safetyRatingCode: row.safety_rating || null,
    safetyRatingDate: formatCensusDate(row.safety_rating_date),
    reviewType: reviewLabel(row.review_type),
    reviewDate: formatCensusDate(row.review_date),
    crashRate: row.recordable_crash_rate || null,
    usdotStatus: statusWord(row.status_code) || row.status_code,
    authorityStatus: matched?.statusLabel ? `${matched.statusLabel} MC authority` : "No MC on file",
    priorRevoke: row.prior_revoke_flag === "Y",
    priorRevokeDot: toNullableNumber(row.prior_revoke_dot_number),
    mcsipStep: row.mcsipstep || null,
    mcsipDate: formatCensusDate(row.mcsipdate),
    mcs150Date: formatCensusDate(row.mcs150_date),
    mcs150Mileage: row.mcs150_mileage || null,
    mcs150MileageYear: row.mcs150_mileage_year || null,
    snapshot: null,
    saferUrl: mcNumber
      ? `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=MC_MX&query_string=${mcNumber}`
      : dotNumber
        ? `https://safer.fmcsa.dot.gov/query.asp?searchtype=ANY&query_type=queryCarrierSnapshot&query_param=USDOT&query_string=${dotNumber}`
        : null,
    liUrl: mcNumber
      ? `https://li-public.fmcsa.dot.gov/LIVIEW/pkg_carrquery.prc_carrlist?pv_vpath=LIVIEW&n_docketno=${mcNumber}`
      : null,
    smsUrl: dotNumber ? `https://ai.fmcsa.dot.gov/SMS/Carrier/${dotNumber}/Overview.aspx` : null,
  };
}
