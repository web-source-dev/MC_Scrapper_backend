import { EQUIPMENT_TYPES, OOS_MCSIP_STEPS } from "./equipment.js";

export function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function likeContains(value) {
  return sqlString(`%${String(value).replace(/[%_]/g, "").toUpperCase()}%`);
}

function docketActive(prefixField, numberField, statusField) {
  return [
    `${prefixField} = 'MC'`,
    `${numberField} IS NOT NULL`,
    `${numberField} != ''`,
    `${statusField} = 'A'`,
  ].join(" AND ");
}

function docketInRange(prefixField, numberField, statusField, startMc, endMc) {
  return [
    `${prefixField} = 'MC'`,
    `${numberField} IS NOT NULL`,
    `${numberField} != ''`,
    `${numberField}::number >= ${startMc}`,
    `${numberField}::number <= ${endMc}`,
    `${statusField} = 'A'`,
  ].join(" AND ");
}

function docketInList(prefixField, numberField, statusField, numbers) {
  const list = numbers.map((value) => sqlString(value)).join(", ");
  return [
    `${prefixField} = 'MC'`,
    `${numberField} IN (${list})`,
    `${statusField} = 'A'`,
  ].join(" AND ");
}

function anyActiveMc() {
  return `(${[
    `(${docketActive("docket1prefix", "docket1", "docket1_status_code")})`,
    `(${docketActive("docket2prefix", "docket2", "docket2_status_code")})`,
    `(${docketActive("docket3prefix", "docket3", "docket3_status_code")})`,
  ].join(" OR ")})`;
}

function modeClause(filters) {
  const {
    searchMode,
    startMc,
    endMc,
    identifier,
    identifierType,
    idList = [],
    companyName,
    state,
    city,
    phone,
  } = filters;

  if (searchMode === "mc-range") {
    return `(${[
      `(${docketInRange("docket1prefix", "docket1", "docket1_status_code", startMc, endMc)})`,
      `(${docketInRange("docket2prefix", "docket2", "docket2_status_code", startMc, endMc)})`,
      `(${docketInRange("docket3prefix", "docket3", "docket3_status_code", startMc, endMc)})`,
    ].join(" OR ")})`;
  }

  if (searchMode === "mc-lookup") {
    if (identifierType === "dot") {
      return `dot_number = ${identifier}`;
    }
    return `(${[
      `(docket1prefix = 'MC' AND docket1 = ${sqlString(identifier)} AND docket1_status_code = 'A')`,
      `(docket2prefix = 'MC' AND docket2 = ${sqlString(identifier)} AND docket2_status_code = 'A')`,
      `(docket3prefix = 'MC' AND docket3 = ${sqlString(identifier)} AND docket3_status_code = 'A')`,
    ].join(" OR ")})`;
  }

  if (searchMode === "id-list") {
    if (identifierType === "dot") {
      return `dot_number IN (${idList.join(", ")})`;
    }
    return `(${[
      `(${docketInList("docket1prefix", "docket1", "docket1_status_code", idList)})`,
      `(${docketInList("docket2prefix", "docket2", "docket2_status_code", idList)})`,
      `(${docketInList("docket3prefix", "docket3", "docket3_status_code", idList)})`,
    ].join(" OR ")})`;
  }

  if (searchMode === "company-name") {
    const like = likeContains(companyName);
    return `(upper(legal_name) LIKE ${like} OR upper(dba_name) LIKE ${like})`;
  }

  if (searchMode === "location") {
    const parts = [`phy_state = ${sqlString(state)}`];
    if (city) {
      parts.push(`upper(phy_city) LIKE ${likeContains(city)}`);
    }
    return parts.join(" AND ");
  }

  if (searchMode === "phone") {
    const digits = sqlString(`%${phone}%`);
    return `(phone LIKE ${digits} OR cell_phone LIKE ${digits})`;
  }

  return "1 = 0";
}

export function buildWhereClause(filters) {
  const {
    searchMode,
    equipmentTypes = [],
    minTrucks,
    maxTrucks,
    minDrivers,
    maxDrivers,
    state,
    city,
    zip,
    safetyRating,
    hazmatOnly,
    requirePhone,
    requireCell,
    requireEmail,
    requireContact,
    interstateOnly,
    intrastateOnly,
    freightOnly,
    mcs150Months,
    strictSafer = true,
  } = filters;

  const clauses = [modeClause(filters)];
  const isExactLookup = searchMode === "mc-lookup" || searchMode === "id-list";

  if (strictSafer) {
    clauses.push("status_code = 'A'");
    clauses.push("phy_country = 'US'");
    clauses.push("upper(classdef) LIKE '%AUTHORIZED FOR HIRE%'");
    clauses.push(`(prior_revoke_flag IS NULL OR prior_revoke_flag != 'Y')`);
    clauses.push(`NOT (mcsipstep IN (${OOS_MCSIP_STEPS.map(sqlString).join(", ")}))`);
  } else if (!isExactLookup) {
    clauses.push("phy_country = 'US'");
  }

  if (searchMode !== "mc-range" && searchMode !== "id-list" && searchMode !== "mc-lookup") {
    clauses.push(anyActiveMc());
  }

  if (searchMode !== "location" && state) {
    clauses.push(`phy_state = ${sqlString(state)}`);
  }

  if (Number.isFinite(minTrucks)) {
    clauses.push(`power_units IS NOT NULL AND power_units != '' AND power_units::number >= ${minTrucks}`);
  }

  if (Number.isFinite(maxTrucks)) {
    clauses.push(`power_units IS NOT NULL AND power_units != '' AND power_units::number <= ${maxTrucks}`);
  }

  const selected = EQUIPMENT_TYPES.filter((type) => equipmentTypes.includes(type.id));
  if (selected.length > 0) {
    const cargoFields = [...new Set(selected.flatMap((type) => type.cargoFields))];
    clauses.push(`(${cargoFields.map((field) => `${field} = 'X'`).join(" OR ")})`);
  }

  if (safetyRating === "none") {
    clauses.push(`(safety_rating IS NULL OR safety_rating = '')`);
  } else if (safetyRating === "usable") {
    clauses.push(`(safety_rating IS NULL OR safety_rating = '' OR safety_rating = 'S')`);
  } else if (safetyRating && safetyRating !== "any") {
    clauses.push(`safety_rating = ${sqlString(safetyRating)}`);
  }

  if (hazmatOnly) {
    clauses.push(`hm_ind = 'Y'`);
  }

  if (requirePhone) {
    clauses.push(`phone IS NOT NULL AND phone != '' AND phone != '0'`);
  }

  if (requireCell) {
    clauses.push(`cell_phone IS NOT NULL AND cell_phone != '' AND cell_phone != '0'`);
  }

  if (requireEmail) {
    clauses.push(`email_address IS NOT NULL AND email_address != ''`);
  }

  if (requireContact) {
    clauses.push(`(
      (phone IS NOT NULL AND phone != '' AND phone != '0')
      OR (email_address IS NOT NULL AND email_address != '')
    )`);
  }

  if (interstateOnly && !intrastateOnly) {
    clauses.push(`carrier_operation = 'A'`);
  } else if (intrastateOnly && !interstateOnly) {
    clauses.push(`(carrier_operation = 'B' OR carrier_operation = 'C')`);
  }

  if (freightOnly) {
    clauses.push(`(crgo_passengers IS NULL OR crgo_passengers != 'X')`);
    clauses.push(`upper(classdef) NOT LIKE '%PASSENGER%'`);
  }

  if (Number.isFinite(minDrivers)) {
    clauses.push(`total_drivers IS NOT NULL AND total_drivers != '' AND total_drivers::number >= ${minDrivers}`);
  }

  if (Number.isFinite(maxDrivers)) {
    clauses.push(`total_drivers IS NOT NULL AND total_drivers != '' AND total_drivers::number <= ${maxDrivers}`);
  }

  if (searchMode !== "location" && city) {
    clauses.push(`upper(phy_city) LIKE ${likeContains(city)}`);
  }

  if (zip) {
    clauses.push(`phy_zip LIKE ${sqlString(`${zip}%`)}`);
  }

  if (mcs150Months) {
    clauses.push(`mcs150_date IS NOT NULL AND mcs150_date >= ${sqlString(mcs150Cutoff(mcs150Months))}`);
  }

  return clauses.join(" AND ");
}

function mcs150Cutoff(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function orderClause(searchMode) {
  if (searchMode === "mc-range" || searchMode === "id-list") return "docket1";
  if (searchMode === "location" || searchMode === "company-name") return "legal_name";
  return "legal_name";
}
