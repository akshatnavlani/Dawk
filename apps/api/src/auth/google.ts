import { z } from "zod";

export const GOOGLE_REDIRECT_URI = "http://127.0.0.1:3001/auth/google/callback";

const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export type GoogleProfile = {
  sub: string;
  email: string;
  emailVerified: boolean;
};

export type GoogleTokenClient = (input: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}) => Promise<GoogleProfile>;

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
});

const userInfoSchema = z.object({
  sub: z.string().min(1),
  email: z.string().min(1),
  email_verified: z.boolean().optional(),
});

export function googleAuthorizeUrl(input: {
  clientId: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "openid email profile",
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
  });
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

export const exchangeGoogleCode: GoogleTokenClient = async (input) => {
  if (input.redirectUri !== GOOGLE_REDIRECT_URI) {
    throw new Error("google_redirect_rejected");
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: GOOGLE_REDIRECT_URI,
      code_verifier: input.codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error("google_token_exchange_failed");
  }

  const tokenJson: unknown = await tokenResponse.json();
  const token = tokenResponseSchema.safeParse(tokenJson);
  if (!token.success) {
    throw new Error("google_token_exchange_failed");
  }

  const infoResponse = await fetch(GOOGLE_USERINFO_URL, {
    headers: { authorization: `Bearer ${token.data.access_token}` },
  });
  if (!infoResponse.ok) {
    throw new Error("google_userinfo_failed");
  }

  const infoJson: unknown = await infoResponse.json();
  const info = userInfoSchema.safeParse(infoJson);
  if (!info.success) {
    throw new Error("google_userinfo_failed");
  }

  return {
    sub: info.data.sub,
    email: info.data.email,
    emailVerified: info.data.email_verified === true,
  };
};
