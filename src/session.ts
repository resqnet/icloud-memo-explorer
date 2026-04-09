/**
 * HTTP session manager for iCloud API.
 * Handles cookies, session tokens, and persistence.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { SessionData } from "./types.js";

const HEADER_MAP: Record<string, keyof SessionData> = {
  "x-apple-id-account-country": "account_country",
  "x-apple-id-session-id": "session_id",
  "x-apple-auth-attributes": "auth_attributes",
  "x-apple-session-token": "session_token",
  "x-apple-twosv-trust-token": "trust_token",
  scnt: "scnt",
};

export class ICloudSession {
  private cookies: Map<string, string> = new Map();
  data: SessionData;
  private storageDir: string;
  private accountName: string;

  constructor(appleId: string) {
    this.accountName = appleId;
    this.storageDir = join(homedir(), ".icloud-memo-explorer");
    mkdirSync(this.storageDir, { recursive: true });

    this.data = { client_id: crypto.randomUUID().toLowerCase() };
    this.load();
  }

  private get safeAccountName(): string {
    return this.accountName.replace(/[^\w]/g, "");
  }

  private get sessionPath(): string {
    return join(this.storageDir, `${this.safeAccountName}.session.json`);
  }

  private get cookiePath(): string {
    return join(this.storageDir, `${this.safeAccountName}.cookies.json`);
  }

  private load(): void {
    try {
      if (existsSync(this.sessionPath)) {
        const saved = JSON.parse(readFileSync(this.sessionPath, "utf-8"));
        this.data = { ...this.data, ...saved };
      }
    } catch {
      // start fresh
    }
    try {
      if (existsSync(this.cookiePath)) {
        const saved: Record<string, string> = JSON.parse(readFileSync(this.cookiePath, "utf-8"));
        for (const [k, v] of Object.entries(saved)) {
          this.cookies.set(k, v);
        }
      }
    } catch {
      // start fresh
    }
  }

  save(): void {
    writeFileSync(this.sessionPath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    const cookieObj: Record<string, string> = {};
    for (const [k, v] of this.cookies) {
      cookieObj[k] = v;
    }
    writeFileSync(this.cookiePath, JSON.stringify(cookieObj, null, 2), { mode: 0o600 });
  }

  /** Update session data from response headers. */
  updateFromResponse(headers: Headers): void {
    for (const [header, key] of Object.entries(HEADER_MAP)) {
      const value = headers.get(header);
      if (value) {
        (this.data as unknown as Record<string, string>)[key] = value;
      }
    }

    // Parse Set-Cookie headers
    const setCookies = headers.getSetCookie?.() ?? [];
    for (const raw of setCookies) {
      const parts = raw.split(";")[0];
      if (!parts) continue;
      const eqIdx = parts.indexOf("=");
      if (eqIdx === -1) continue;
      const name = parts.slice(0, eqIdx).trim();
      const value = parts.slice(eqIdx + 1).trim();
      this.cookies.set(name, value);
    }

    this.save();
  }

  /** Build Cookie header string. */
  getCookieHeader(): string {
    const parts: string[] = [];
    for (const [k, v] of this.cookies) {
      parts.push(`${k}=${v}`);
    }
    return parts.join("; ");
  }

  /** Make an authenticated request. */
  async request(
    method: string,
    url: string,
    options: {
      headers?: Record<string, string>;
      json?: unknown;
      data?: string;
      params?: Record<string, string>;
    } = {},
  ): Promise<Response> {
    const urlObj = new URL(url);
    if (options.params) {
      for (const [k, v] of Object.entries(options.params)) {
        urlObj.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.3.1 Safari/605.1.15",
      Origin: "https://www.icloud.com",
      Referer: "https://www.icloud.com/",
      Cookie: this.getCookieHeader(),
      ...options.headers,
    };

    let body: string | undefined;
    if (options.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(options.json);
    } else if (options.data !== undefined) {
      body = options.data;
    }

    const resp = await fetch(urlObj.toString(), {
      method,
      headers,
      body,
      redirect: "follow",
    });

    this.updateFromResponse(resp.headers);
    return resp;
  }
}
