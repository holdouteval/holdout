export function siteLink(site: string | null, kind: "open" | "close", address: string): string | null {
  if (site === null) return null;
  const key = kind === "open" ? "agent" : "lane";
  return `${site.replace(/\/+$/, "")}/#${kind}?${key}=${address.toLowerCase()}`;
}
