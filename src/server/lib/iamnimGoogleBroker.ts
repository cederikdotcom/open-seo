import { z } from "zod";
import { getOptionalEnvValue } from "./runtime-env";

const slugSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,127}$/);
const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
});
export type GoogleBrokerPurpose = "google_search_console" | "google_analytics";

/** This deployment-level credential belongs only to the existing single-user
 * self-host mode. Hosted/multi-user installations must never inherit it. */
export async function getIamnimGoogleBroker() {
  const [base, org, pat, mode] = await Promise.all([
    getOptionalEnvValue("IAMNIM_GOOGLE_BROKER_URL"),
    getOptionalEnvValue("IAMNIM_ORG_SLUG"),
    getOptionalEnvValue("IAMNIM_PAT"),
    getOptionalEnvValue("AUTH_MODE"),
  ]);
  if (!base && !org && !pat) return null;
  if (mode !== "local_noauth")
    throw new Error(
      "Organization Google broker requires the protected single-user deployment.",
    );
  let url: URL;
  try {
    url = new URL(base ?? "");
  } catch {
    throw new Error("Invalid iamnim broker URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error(
      "iamnim broker must be an HTTPS origin without embedded credentials.",
    );
  }
  const parsed = slugSchema.safeParse(org);
  if (!parsed.success)
    throw new Error("Explicit iamnim organization required.");
  return {
    origin: url.origin,
    org: parsed.data,
    pat,
    accountId: `iamnim:${parsed.data}`,
    managementUrl: `${url.origin}/organizations/${encodeURIComponent(parsed.data)}/google`,
  };
}

export async function iamnimGoogleAccessToken(
  userId: string,
  accountId: string | undefined,
  purpose: GoogleBrokerPurpose,
): Promise<string | null> {
  const broker = await getIamnimGoogleBroker();
  if (!broker) return null;
  if (userId !== "local-admin" || accountId !== broker.accountId) {
    throw new Error(
      "Google broker identity does not match this connection. Select the organization broker explicitly.",
    );
  }
  if (!broker.pat)
    throw new Error(
      "Configure an explicitly scoped Google-vending PAT from iamnim.",
    );
  const url = new URL(
    `/api/organizations/${encodeURIComponent(broker.org)}/vend/google/token`,
    broker.origin,
  );
  url.searchParams.set("integration", purpose);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Authorization: `Bearer ${broker.pat}` },
      redirect: "error",
      signal: AbortSignal.timeout(25_000),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "iamnim Google broker unavailable. No alternate OAuth flow was attempted.",
    );
  }
  if (!response.ok)
    throw new Error(
      `iamnim Google vending refused (HTTP ${response.status}). Check the PAT capability, membership and named grant in iamnim.`,
    );
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("iamnim returned an invalid short-lived Google token.");
  }
  const result = tokenSchema.safeParse(payload);
  if (!result.success)
    throw new Error("iamnim returned an invalid short-lived Google token.");
  return result.data.access_token;
}

/** A connection source identifier, not a fabricated Google account/grant row. */
export async function iamnimGoogleGrantSources(userId: string) {
  const broker = await getIamnimGoogleBroker();
  if (!broker) return null;
  if (userId !== "local-admin" || !broker.pat) return [];
  return [{ id: broker.accountId, accountId: broker.accountId }];
}
