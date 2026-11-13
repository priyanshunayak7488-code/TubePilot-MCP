
export function getUpstreamAuthorizeUrl({
  upstreamUrl,
  clientId,
  scope,
  redirectUri,
  state,
  hostedDomain,
}: {
  upstreamUrl: string;
  clientId: string;
  scope: string;
  redirectUri: string;
  state?: string;
  hostedDomain?: string;
}) {
  const upstream = new URL(upstreamUrl);

  upstream.searchParams.set("client_id", clientId);
  upstream.searchParams.set("redirect_uri", redirectUri);
  upstream.searchParams.set("scope", scope);
  upstream.searchParams.set("response_type", "code");
  upstream.searchParams.set("access_type", "offline");
  upstream.searchParams.set("prompt", "consent");

  if (state) upstream.searchParams.set("state", state);
  if (hostedDomain) upstream.searchParams.set("hd", hostedDomain);

  return upstream.href;
}

export interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Exchange Google's authorization code for access and refresh tokens.
export async function fetchUpstreamAuthToken({
  clientId,
  clientSecret,
  code,
  redirectUri,
  upstreamUrl,
  grantType,
}: {
  code: string | undefined;
  upstreamUrl: string;
  clientSecret: string;
  redirectUri: string;
  clientId: string;
  grantType: string;
}): Promise<[GoogleTokenResponse, null] | [null, Response]> {
  if (!code) {
    return [null, new Response("Missing code", { status: 400 })];
  }

  const resp = await fetch(upstreamUrl, {
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: grantType,
      redirect_uri: redirectUri,
    }).toString(),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  if (!resp.ok) {
    console.error("Google token exchange failed:", resp.status);
    return [
      null,
      new Response("Failed to fetch access token", { status: 500 }),
    ];
  }

  const body = (await resp.json()) as GoogleTokenResponse;

  if (!body.access_token) {
    return [
      null,
      new Response("Missing access token", { status: 400 }),
    ];
  }

  return [body, null];
}

// Exchange a refresh token for a new Google access token.
export async function refreshGoogleAccessToken({
  clientId,
  clientSecret,
  refreshToken,
}: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<[GoogleTokenResponse, null] | [null, Response]> {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }).toString(),
  });

  if (!resp.ok) {
    console.error("Google token refresh failed:", resp.status);
    return [
      null,
      new Response(
        "Google token refresh failed. Please reconnect your Google account.",
        { status: 401 },
      ),
    ];
  }

  const body = (await resp.json()) as GoogleTokenResponse;

  if (!body.access_token) {
    return [
      null,
      new Response("Missing refreshed access token", { status: 401 }),
    ];
  }

  return [body, null];
}

export type Props = {
  name: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
};
