import { ProxyAgent } from "undici";
import { socksDispatcher } from "fetch-socks";

export function parseProxyUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  const withProtocol = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const url = new URL(withProtocol);
  const protocol = url.protocol.replace(":", "").toLowerCase();
  const port = Number(url.port) || (protocol.startsWith("socks") ? 1080 : protocol === "https" ? 443 : 80);
  return {
    href: url.href,
    protocol,
    host: url.hostname,
    port,
    username: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    display: `${url.hostname}:${port}`,
  };
}

export function createDispatcher(raw) {
  const proxy = parseProxyUrl(raw);
  if (!proxy) return undefined;

  if (proxy.protocol.startsWith("socks")) {
    return socksDispatcher({
      type: proxy.protocol.startsWith("socks4") ? 4 : 5,
      host: proxy.host,
      port: proxy.port,
      userId: proxy.username || undefined,
      password: proxy.password || undefined,
    });
  }

  return new ProxyAgent(proxy.href);
}
