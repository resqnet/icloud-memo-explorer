/**
 * iCloud authentication module.
 * Handles SRP login, 2FA verification, session caching.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { ICloudSession } from "./session.js";
import { startAuthentication, processChallenge } from "./srp.js";
import type { AuthState } from "./types.js";

const AUTH_HEADERS = {
  Accept: "application/json, text/javascript",
  "Content-Type": "application/json",
  "X-Apple-OAuth-Client-Id": "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d",
  "X-Apple-OAuth-Client-Type": "firstPartyAuth",
  "X-Apple-OAuth-Redirect-URI": "https://www.icloud.com",
  "X-Apple-OAuth-Require-Grant-Code": "true",
  "X-Apple-OAuth-Response-Mode": "web_message",
  "X-Apple-OAuth-Response-Type": "code",
  "X-Apple-Widget-Key": "d39ba9916b7251055b22c7f910e2ea796ee65e98b2ddecea8f5dde8d9d1a815d",
};

const SETUP_ENDPOINT = "https://setup.icloud.com/setup/ws/1";
const AUTH_ENDPOINT = "https://idmsa.apple.com/appleauth/auth";

const PARAMS: Record<string, string> = {
  clientBuildNumber: "2534Project66",
  clientMasteringNumber: "2534B22",
};

async function prompt(message: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await rl.question(message);
    return answer.trim();
  } finally {
    rl.close();
  }
}

async function promptPassword(message: string): Promise<string> {
  // Simple password input (no echo hiding in basic Node.js)
  return prompt(message);
}

function getAuthHeaders(session: ICloudSession): Record<string, string> {
  const headers: Record<string, string> = {
    ...AUTH_HEADERS,
    Referer: "https://idmsa.apple.com",
    "X-Apple-OAuth-State": session.data.client_id,
    "X-Apple-Frame-Id": session.data.client_id,
  };

  if (session.data.scnt) headers["scnt"] = session.data.scnt;
  if (session.data.session_id) headers["X-Apple-ID-Session-Id"] = session.data.session_id;
  if (session.data.auth_attributes) headers["X-Apple-Auth-Attributes"] = session.data.auth_attributes;

  return headers;
}

async function validateToken(session: ICloudSession, params: Record<string, string>): Promise<Record<string, unknown> | null> {
  try {
    const resp = await session.request("POST", `${SETUP_ENDPOINT}/validate`, {
      data: "null",
      params,
    });
    if (!resp.ok) return null;
    return await resp.json() as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function accountLogin(
  session: ICloudSession,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const loginData = {
    accountCountryCode: session.data.account_country,
    dsWebAuthToken: session.data.session_token,
    extended_login: true,
    trustToken: session.data.trust_token || "",
  };

  const resp = await session.request("POST", `${SETUP_ENDPOINT}/accountLogin`, {
    json: loginData,
    params,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Account login failed (${resp.status}): ${text.slice(0, 200)}`);
  }

  return await resp.json() as Record<string, unknown>;
}

async function srpAuthenticate(
  session: ICloudSession,
  appleId: string,
  password: string,
): Promise<void> {
  const authHeaders = getAuthHeaders(session);

  // Step 1: GET signin page to initialize
  await session.request("GET", `${AUTH_ENDPOINT}/authorize/signin`, {
    params: {
      frame_id: session.data.client_id,
      skVersion: "7",
      iframeid: session.data.client_id,
      client_id: AUTH_HEADERS["X-Apple-Widget-Key"],
      response_type: "code",
      redirect_uri: "https://www.icloud.com",
      response_mode: "web_message",
      state: session.data.client_id,
      authVersion: "latest",
    },
    headers: authHeaders,
  });

  // Step 2: SRP init
  const { state, A } = startAuthentication(appleId);

  const initResp = await session.request("POST", `${AUTH_ENDPOINT}/signin/init`, {
    json: {
      a: A,
      accountName: appleId,
      protocols: ["s2k", "s2k_fo"],
    },
    headers: getAuthHeaders(session),
  });

  if (!initResp.ok) {
    const text = await initResp.text();
    throw new Error(`SRP init failed (${initResp.status}): ${text.slice(0, 200)}`);
  }

  const initData = await initResp.json() as {
    salt: string;
    b: string;
    c: unknown;
    iteration: number;
    protocol: "s2k" | "s2k_fo";
  };

  // Step 3: Process challenge
  const { M1, M2 } = processChallenge(
    state,
    initData.salt,
    initData.b,
    initData.iteration,
    initData.protocol,
    password,
  );

  // Step 4: Complete signin
  const completeData: Record<string, unknown> = {
    accountName: appleId,
    c: initData.c,
    m1: M1,
    m2: M2,
    rememberMe: true,
    trustTokens: [] as string[],
  };

  if (session.data.trust_token) {
    completeData.trustTokens = [session.data.trust_token];
  }

  const completeResp = await session.request("POST", `${AUTH_ENDPOINT}/signin/complete`, {
    json: completeData,
    params: { isRememberMeEnabled: "true" },
    headers: getAuthHeaders(session),
  });

  // 409 = 2FA required (expected)
  if (completeResp.status === 409) {
    return; // 2FA will be handled separately
  }

  if (!completeResp.ok) {
    const text = await completeResp.text();
    throw new Error(`SRP complete failed (${completeResp.status}): ${text.slice(0, 200)}`);
  }
}

async function verify2FA(session: ICloudSession, code: string): Promise<boolean> {
  const resp = await session.request("POST", `${AUTH_ENDPOINT}/verify/trusteddevice/securitycode`, {
    json: { securityCode: { code } },
    headers: {
      ...getAuthHeaders(session),
      Accept: "application/json",
    },
  });

  if (!resp.ok) {
    return false;
  }
  return true;
}

async function trustSession(session: ICloudSession): Promise<void> {
  await session.request("GET", `${AUTH_ENDPOINT}/2sv/trust`, {
    headers: getAuthHeaders(session),
  });
}

export async function authenticate(appleId: string): Promise<AuthState> {
  const session = new ICloudSession(appleId);

  const params: Record<string, string> = {
    ...PARAMS,
    clientId: session.data.client_id,
  };

  // Try cached session first
  if (session.data.session_token) {
    console.log("Cached session found, validating...");
    const data = await validateToken(session, params);
    if (data && data.webservices) {
      console.log("Session is valid!");
      const dsid = (data.dsInfo as Record<string, unknown>)?.dsid as string | undefined;
      if (dsid) params.dsid = dsid;
      return {
        sessionData: session.data,
        cookies: Object.fromEntries(
          session.getCookieHeader().split("; ").map((c) => {
            const [k, ...v] = c.split("=");
            return [k, v.join("=")];
          }),
        ),
        webservices: data.webservices as Record<string, { url: string }>,
        dsid: dsid,
        params,
      };
    }
    console.log("Cached session expired, re-authenticating...");
  }

  // Need fresh login
  const password = await promptPassword("Password: ");
  console.log("Authenticating with SRP...");
  await srpAuthenticate(session, appleId, password);

  // Account login to get service URLs
  let accountData: Record<string, unknown>;
  try {
    accountData = await accountLogin(session, params);
  } catch {
    // May need 2FA first
    accountData = {};
  }

  // Check if 2FA is needed
  const hsaVersion = (accountData.dsInfo as Record<string, unknown>)?.hsaVersion as number | undefined;
  const hsaChallengeRequired = accountData.hsaChallengeRequired as boolean | undefined;
  const isTrusted = accountData.hsaTrustedBrowser as boolean | undefined;

  if (hsaChallengeRequired || !isTrusted) {
    console.log("2FA required. Check your Apple device for a verification code.");
    const code = await prompt("Verification code: ");

    const ok = await verify2FA(session, code);
    if (!ok) {
      throw new Error("Invalid verification code");
    }
    console.log("Code verified!");

    await trustSession(session);
    console.log("Session trusted for future use.");

    // Re-login with trusted session
    accountData = await accountLogin(session, params);
  }

  const dsid = (accountData.dsInfo as Record<string, unknown>)?.dsid as string | undefined;
  if (dsid) params.dsid = dsid;

  return {
    sessionData: session.data,
    cookies: Object.fromEntries(
      session.getCookieHeader().split("; ").map((c) => {
        const [k, ...v] = c.split("=");
        return [k, v.join("=")];
      }),
    ),
    webservices: accountData.webservices as Record<string, { url: string }> | undefined,
    dsid,
    params,
  };
}

export { ICloudSession };
