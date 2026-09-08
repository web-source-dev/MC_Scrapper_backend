import { Resolver } from "node:dns/promises";
import { isBlockedSignupDomain } from "./disposableEmails.js";

const resolver = new Resolver();
resolver.setServers(["1.1.1.1", "8.8.8.8"]);

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => {
        const error = new Error("timeout");
        error.code = "ETIMEOUT";
        reject(error);
      }, ms);
    }),
  ]);
}

export async function mailboxDomainError(domain) {
  const host = String(domain || "")
    .trim()
    .toLowerCase()
    .replace(/\.+$/, "");
  if (!host || isBlockedSignupDomain(host)) {
    return "Use a work or personal email, not a temporary or test inbox";
  }
  try {
    const mx = await withTimeout(resolver.resolveMx(host), 2500);
    if (Array.isArray(mx) && mx.length) return null;
  } catch (error) {
    if (error?.code === "ETIMEOUT") return null;
  }
  try {
    const addresses = await withTimeout(resolver.resolve4(host), 2000);
    if (Array.isArray(addresses) && addresses.length) return null;
  } catch (error) {
    if (error?.code === "ETIMEOUT") return null;
  }
  return "That email domain can't receive mail";
}
