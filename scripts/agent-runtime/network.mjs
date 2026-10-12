import { LIMITS } from "./config.mjs";
import { invariant, parseJson } from "./contracts.mjs";

const PUBLIC_HOSTS = new Set([
  "registry.npmjs.org",
  "api.github.com",
  "raw.githubusercontent.com",
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
  "cursor.com",
  "www.cursor.com",
  "developers.openai.com",
  "learn.chatgpt.com",
]);

export function publicUrl(input) {
  const url = new URL(input);
  invariant(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      PUBLIC_HOSTS.has(url.hostname),
    "Source URL is not allowlisted.",
  );
  return url;
}

export async function readBounded(response, maximum) {
  if (
    !response.body ||
    Number(response.headers.get("content-length") || 0) > maximum
  ) {
    await response.body?.cancel();
    throw new Error("Response exceeds its size limit.");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      invariant(length <= maximum, "Response exceeds its size limit.");
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}

export async function publicFetch(
  input,
  {
    fetchImpl = fetch,
    token,
    etag,
    maximum = LIMITS.source,
    json = false,
  } = {},
) {
  let url = publicUrl(input);
  const signal = AbortSignal.timeout(LIMITS.timeout);
  for (let attempt = 0; attempt < 5; attempt++) {
    const headers = {
      "user-agent": "zeros-runtime-notifications",
      accept: json ? "application/json" : "text/html,text/plain",
    };
    if (etag) headers["if-none-match"] = etag;
    // Never forward a GitHub credential to a registry, docs host, or redirect.
    if (token && attempt === 0 && url.hostname === "api.github.com")
      headers.authorization = `Bearer ${token}`;
    const response = await fetchImpl(url.href, {
      headers,
      redirect: "manual",
      signal,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      url = publicUrl(new URL(response.headers.get("location"), url).href);
      continue;
    }
    if (response.status === 304) return { notModified: true, etag };
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Public source HTTP ${response.status}.`);
    }
    const text = (await readBounded(response, maximum)).toString("utf8");
    return {
      text,
      data: json ? parseJson(text, maximum) : undefined,
      etag: response.headers.get("etag"),
      url: url.href,
    };
  }
  throw new Error("Too many public source redirects.");
}

export async function githubPages(
  path,
  { token, fetchImpl = fetch, maximumPages = LIMITS.pages } = {},
) {
  invariant(
    path.startsWith("/repos/") || path.startsWith("/advisories?"),
    "Invalid public GitHub path.",
  );
  const result = [];
  for (let page = 1; page <= maximumPages; page++) {
    const separator = path.includes("?") ? "&" : "?";
    const { data } = await publicFetch(
      `https://api.github.com${path}${separator}per_page=100&page=${page}`,
      { token, fetchImpl, json: true },
    );
    invariant(Array.isArray(data), "GitHub pagination changed shape.");
    result.push(...data);
    if (data.length < 100) return result;
  }
  throw new Error("GitHub pagination is incomplete.");
}
