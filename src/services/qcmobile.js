import { fetch as undiciFetch } from "undici";
import { config } from "../config.js";
import { createDispatcher, parseProxyUrl } from "../lib/proxy.js";

const qcDispatcher = createDispatcher(config.fmcsaProxy);
const qcProxy = parseProxyUrl(config.fmcsaProxy);

function unwrap(payload) {
  if (!payload) return null;
  if (Array.isArray(payload.content)) return payload.content[0] || payload.content;
  if (payload.content) return payload.content;
  return payload;
}

function pickCarrier(payload) {
  const node = unwrap(payload);
  if (!node) return null;
  return node.carrier || node.Carrier || node;
}

async function qcGet(path) {
  if (!config.fmcsaWebKey) {
    throw new Error("FMCSA_WEBKEY is not set");
  }
  const url = `https://mobile.fmcsa.dot.gov/qc/services${path}${path.includes("?") ? "&" : "?"}webKey=${encodeURIComponent(config.fmcsaWebKey)}`;
  const response = await undiciFetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(25000),
    dispatcher: qcDispatcher,
  });
  if (!response.ok) {
    const body = await response.text();
    if (response.status === 403 && /forbidden/i.test(body) && !body.trim().startsWith("{")) {
      throw new Error(
        qcProxy
          ? `FMCSA QCMobile still returned 403 through ${qcProxy.display}. Confirm that proxy exits in the US.`
          : "FMCSA QCMobile blocked this connection (403). Set FMCSA_PROXY in backend/.env to a US HTTP or SOCKS proxy, then restart the API.",
      );
    }
    throw new Error(`QCMobile ${response.status}${body ? `: ${body.slice(0, 180)}` : ""}`);
  }
  return response.json();
}

function asList(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

export function isQcMobileConfigured() {
  return Boolean(config.fmcsaWebKey);
}

export function getQcProxyInfo() {
  return qcProxy ? { enabled: true, host: qcProxy.display } : { enabled: false, host: null };
}

export async function fetchQcSnapshot({ mcNumber, dotNumber }) {
  if (!isQcMobileConfigured()) {
    return {
      available: false,
      reason: "Add FMCSA_WEBKEY in backend/.env to load live SAFER / BASIC / authority data.",
    };
  }

  const snapshot = {
    available: true,
    reason: null,
    allowToOperate: null,
    outOfService: null,
    outOfServiceDate: null,
    complaintCount: null,
    authority: [],
    basics: [],
    cargo: [],
    operationClass: [],
    oos: null,
  };

  try {
    let identity = null;
    if (dotNumber) {
      identity = pickCarrier(await qcGet(`/carriers/${dotNumber}`));
    } else if (mcNumber) {
      identity = pickCarrier(await qcGet(`/carriers/docket-number/${mcNumber}`));
    }
    if (identity) {
      snapshot.allowToOperate = identity.allowToOperate || identity.allowedToOperate || null;
      snapshot.outOfService = identity.outOfService || null;
      snapshot.outOfServiceDate = identity.outOfServiceDate || null;
      snapshot.complaintCount = identity.complaintCount ?? identity.totalComplaints ?? null;
      if (!dotNumber && (identity.dotNumber || identity.dotNumber === 0)) {
        dotNumber = identity.dotNumber;
      }
    }

    if (!dotNumber) {
      return snapshot;
    }

    const [basics, authority, cargo, ops, oos] = await Promise.allSettled([
      qcGet(`/carriers/${dotNumber}/basics`),
      qcGet(`/carriers/${dotNumber}/authority`),
      qcGet(`/carriers/${dotNumber}/cargo-carried`),
      qcGet(`/carriers/${dotNumber}/operation-classification`),
      qcGet(`/carriers/${dotNumber}/oos`),
    ]);

    if (basics.status === "fulfilled") {
      const list = asList(unwrap(basics.value)?.basics || unwrap(basics.value)?.basic || unwrap(basics.value));
      snapshot.basics = list
        .map((item) => item.basic || item)
        .filter(Boolean)
        .map((item) => ({
          name: item.basicDesc || item.basicShortDesc || item.basicId,
          percentile: item.percentile ?? null,
          onRoadDeficient: item.rdDeficient === "Y",
          seriousDeficient: item.svDeficient === "Y" || item.rdsvDeficient === "Y",
          inspectionsWithViolation: item.totalInspectionWithViolation ?? null,
          violations: item.totalViolation ?? null,
        }));
    }

    if (authority.status === "fulfilled") {
      const list = asList(unwrap(authority.value)?.authority || unwrap(authority.value));
      snapshot.authority = list
        .map((item) => item.authority || item)
        .filter(Boolean)
        .map((item) => ({
          type: item.authType || item.authorityType || item.docketType || null,
          granted: item.authGrantDate || item.grantedDate || null,
          status: item.authStatus || item.status || null,
        }));
    }

    if (cargo.status === "fulfilled") {
      snapshot.cargo = asList(unwrap(cargo.value)?.cargoCarried || unwrap(cargo.value))
        .map((item) => item.cargoClassDesc || item.cargoCarried || item.description || item)
        .filter((item) => typeof item === "string");
    }

    if (ops.status === "fulfilled") {
      snapshot.operationClass = asList(
        unwrap(ops.value)?.operationClassification || unwrap(ops.value),
      )
        .map((item) => item.operationClassDesc || item.description || item)
        .filter((item) => typeof item === "string");
    }

    if (oos.status === "fulfilled") {
      snapshot.oos = unwrap(oos.value);
    }

    return snapshot;
  } catch (error) {
    return {
      available: false,
      reason: error.message || "QCMobile lookup failed",
    };
  }
}
