
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import {
  fetchUpstreamAuthToken,
  getUpstreamAuthorizeUrl,
  type Props,
} from "./utils";
import {
  addApprovedClient,
  bindStateToSession,
  createOAuthState,
  generateCSRFProtection,
  isClientApproved,
  OAuthError,
  renderApprovalDialog,
  validateCSRFToken,
  validateOAuthState,
} from "./workers-oauth-utils";

const app = new Hono<{
  Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers };
}>();

app.get("/authorize", async (c) => {
  const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(
    c.req.raw,
  );
  const { clientId } = oauthReqInfo;

  if (!clientId) {
    return c.text("Invalid request", 400);
  }

  // Check if client is already approved.
  if (
    await isClientApproved(
      c.req.raw,
      clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    )
  ) {
    const { stateToken } = await createOAuthState(
      oauthReqInfo,
      c.env.OAUTH_KV,
    );
    const { setCookie: sessionBindingCookie } =
      await bindStateToSession(stateToken);

    return redirectToGoogle(c.req.raw, c.env, stateToken, {
      "Set-Cookie": sessionBindingCookie,
    });
  }

  // Generate CSRF protection for the approval form.
  const { token: csrfToken, setCookie } =
    generateCSRFProtection();

  return renderApprovalDialog(c.req.raw, {
    client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
    csrfToken,
    server: {
      description: "TubePilot AI connects to your YouTube analytics.",
      name: "TubePilot AI",
    },
    setCookie,
    state: { oauthReqInfo },
  });
});

app.post("/authorize", async (c) => {
  try {
    const formData = await c.req.raw.formData();

    // Validate CSRF token.
    validateCSRFToken(formData, c.req.raw);

    const encodedState = formData.get("state");

    if (!encodedState || typeof encodedState !== "string") {
      return c.text("Missing state in form data", 400);
    }

    let state: { oauthReqInfo?: AuthRequest };

    try {
      state = JSON.parse(atob(encodedState));
    } catch {
      return c.text("Invalid state data", 400);
    }

    if (!state.oauthReqInfo?.clientId) {
      return c.text("Invalid request", 400);
    }

    // Add client to approved list.
    const approvedClientCookie = await addApprovedClient(
      c.req.raw,
      state.oauthReqInfo.clientId,
      c.env.COOKIE_ENCRYPTION_KEY,
    );

    // Create OAuth state and bind it to this user's session.
    const { stateToken } = await createOAuthState(
      state.oauthReqInfo,
      c.env.OAUTH_KV,
    );
    const { setCookie: sessionBindingCookie } =
      await bindStateToSession(stateToken);

    // Set both cookies.
    const headers = new Headers();
    headers.append("Set-Cookie", approvedClientCookie);
    headers.append("Set-Cookie", sessionBindingCookie);

    return redirectToGoogle(
      c.req.raw,
      c.env,
      stateToken,
      Object.fromEntries(headers),
    );
  } catch (error: any) {
    console.error("POST /authorize error:", error);

    if (error instanceof OAuthError) {
      return error.toResponse();
    }

    return c.text("Internal server error", 500);
  }
});

async function redirectToGoogle(
  request: Request,
  env: Env,
  stateToken: string,
  headers: Record<string, string> = {},
) {
  return new Response(null, {
    headers: {
      ...headers,
      location: getUpstreamAuthorizeUrl({
        clientId: env.GOOGLE_CLIENT_ID,
        hostedDomain: env.HOSTED_DOMAIN,
        redirectUri: new URL("/callback", request.url).href,

        // Required YouTube permissions.
        scope:
          "email profile https://www.googleapis.com/auth/yt-analytics.readonly https://www.googleapis.com/auth/youtube.readonly",

        state: stateToken,
        upstreamUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      }),
    },
    status: 302,
  });
}

/**
 * OAuth Callback Endpoint
 *
 * Validates OAuth state, exchanges Google's authorization code,
 * retrieves user information, and completes MCP authorization.
 *
 * SECURITY:
 * 1. Validates the state token stored in KV.
 * 2. Validates the browser session-binding cookie.
 */
app.get("/callback", async (c) => {
  // Validate OAuth state and session binding.
  let oauthReqInfo: AuthRequest;
  let clearSessionCookie: string;

  try {
    const result = await validateOAuthState(
      c.req.raw,
      c.env.OAUTH_KV,
    );

    oauthReqInfo = result.oauthReqInfo;
    clearSessionCookie = result.clearCookie;
  } catch (error: any) {
    if (error instanceof OAuthError) {
      return error.toResponse();
    }

    return c.text("Internal server error", 500);
  }

  if (!oauthReqInfo.clientId) {
    return c.text("Invalid OAuth request data", 400);
  }

  // Exchange Google's authorization code for tokens.
  const code = c.req.query("code");

  if (!code) {
    return c.text("Missing code", 400);
  }

  const [tokens, googleErrResponse] =
    await fetchUpstreamAuthToken({
      clientId: c.env.GOOGLE_CLIENT_ID,
      clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      code,
      grantType: "authorization_code",
      redirectUri: new URL("/callback", c.req.url).href,
      upstreamUrl: "https://oauth2.googleapis.com/token",
    });

  if (googleErrResponse) {
    return googleErrResponse;
  }

  const accessToken = tokens.access_token;
  const refreshToken = tokens.refresh_token;

  if (!refreshToken) {
    return c.text(
      "Google did not return a refresh token. Please revoke the previous app permission and authorize again.",
      400,
    );
  }

  // Fetch the user's Google account information.
  const userResponse = await fetch(
    "https://www.googleapis.com/oauth2/v2/userinfo",
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  );

  if (!userResponse.ok) {
    return c.text(
      `Failed to fetch user info: ${await userResponse.text()}`,
      500,
    );
  }

  const { id, name, email } = (await userResponse.json()) as {
    id: string;
    name: string;
    email: string;
  };

  // Complete MCP authorization.
  const { redirectTo } =
    await c.env.OAUTH_PROVIDER.completeAuthorization({
      metadata: {
        label: name,
      },
      props: {
        accessToken,
        refreshToken,
        expiresIn: tokens.expires_in,
        email,
        name,
      } as Props,
      request: oauthReqInfo,
      scope: oauthReqInfo.scope,
      userId: id,
    });

  // Clear the one-time session-binding cookie.
  const headers = new Headers({
    Location: redirectTo,
  });

  if (clearSessionCookie) {
    headers.set("Set-Cookie", clearSessionCookie);
  }

  return new Response(null, {
    status: 302,
    headers,
  });
});

export { app as GoogleHandler };
