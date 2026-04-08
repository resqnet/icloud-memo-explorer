/**
 * SRP (Secure Remote Password) implementation for Apple iCloud authentication.
 *
 * Implements SRP-6a with:
 *   - RFC 5054 2048-bit group parameters
 *   - SHA-256 hash
 *   - no_username_in_x (Apple-specific)
 *   - Apple's s2k / s2k_fo password derivation
 */

import { createHash, pbkdf2Sync, randomBytes } from "node:crypto";

// RFC 5054 2048-bit prime
const N_HEX =
  "AC6BDB41324A9A9BF166DE5E1389582FAF72B6651987EE07FC319294" +
  "3DB56050A37329CBB4A099ED8193E0757767A13DD52312AB4B03310D" +
  "CD7F48A9DA04FD50E8083969EDB767B0CF6095179A163AB3661A05FB" +
  "D5FAAAE82918A9962F0B93B855F97993EC975EEAA80D740ADBF4FF74" +
  "7359D041D5C33EA71D281E446B14773BCA97B43A23FB801676BD207A" +
  "436C6481F1D2B9078717461A5B9D32E688F87748544523B524B0D57D" +
  "5EA77A2775D2ECFA032CFBDBF52FB3786160279004E57AE6AF874E73" +
  "03CE53299CCC041C7BC308D82A5698F3A8D0C38271AE35F8E9DBFBB" +
  "694B5C803D89F7AE435DE236D525F54759B65E372FCD68EF20FA7111" +
  "F9E4AFF73";

const N = BigInt("0x" + N_HEX);
const g = 2n;

function sha256(data: Buffer): Buffer {
  return createHash("sha256").update(data).digest();
}

function bigIntToBuffer(n: bigint): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;
  return Buffer.from(hex, "hex");
}

function bufferToBigInt(buf: Buffer): bigint {
  return BigInt("0x" + buf.toString("hex"));
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = ((base % mod) + mod) % mod;
  while (exp > 0n) {
    if (exp % 2n === 1n) {
      result = (result * base) % mod;
    }
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function padToN(buf: Buffer): Buffer {
  const nLen = 256; // 2048 bits = 256 bytes
  if (buf.length >= nLen) return buf;
  const padded = Buffer.alloc(nLen);
  buf.copy(padded, nLen - buf.length);
  return padded;
}

function computeK(): bigint {
  const hash = sha256(Buffer.concat([padToN(bigIntToBuffer(N)), padToN(bigIntToBuffer(g))]));
  return bufferToBigInt(hash);
}

function computeU(A: bigint, B: bigint): bigint {
  const hash = sha256(Buffer.concat([padToN(bigIntToBuffer(A)), padToN(bigIntToBuffer(B))]));
  return bufferToBigInt(hash);
}

/** Derive password bytes using Apple's SRP password protocol. */
export function derivePassword(
  rawPassword: string,
  salt: Buffer,
  iterations: number,
  keyLength: number,
  protocol: "s2k" | "s2k_fo",
): Buffer {
  const passwordHash = sha256(Buffer.from(rawPassword, "utf-8"));
  const passwordDigest =
    protocol === "s2k_fo"
      ? Buffer.from(passwordHash.toString("hex"), "utf-8")
      : passwordHash;

  return pbkdf2Sync(passwordDigest, salt, iterations, keyLength, "sha256");
}

export interface SrpClientState {
  a: bigint;
  A: bigint;
  username: string;
}

export function startAuthentication(username: string): { state: SrpClientState; A: string } {
  const aBytes = randomBytes(32);
  const a = bufferToBigInt(aBytes);
  const A = modPow(g, a, N);

  return {
    state: { a, A, username },
    A: bigIntToBuffer(A).toString("base64"),
  };
}

export function processChallenge(
  state: SrpClientState,
  saltB64: string,
  bB64: string,
  iterations: number,
  protocol: "s2k" | "s2k_fo",
  rawPassword: string,
): { M1: string; M2: string } {
  const salt = Buffer.from(saltB64, "base64");
  const B = bufferToBigInt(Buffer.from(bB64, "base64"));

  const derivedPassword = derivePassword(rawPassword, salt, iterations, 32, protocol);

  // x = H(salt | password) — no username in x (Apple-specific)
  const x = bufferToBigInt(sha256(Buffer.concat([salt, derivedPassword])));

  const k = computeK();
  const u = computeU(state.A, B);

  if (u === 0n) throw new Error("SRP: u is zero");

  // S = (B - k * g^x) ^ (a + u * x) mod N
  const gx = modPow(g, x, N);
  const kgx = (k * gx) % N;
  const diff = ((B - kgx) % N + N) % N;
  const exp = (state.a + u * x) % (N - 1n);
  const S = modPow(diff, exp, N);

  const K = sha256(bigIntToBuffer(S));

  // M1 = H(H(N) xor H(g), H(username), salt, A, B, K) — RFC 5054
  const hN = sha256(bigIntToBuffer(N));
  const hg = sha256(bigIntToBuffer(g));
  const hNxorHg = Buffer.alloc(hN.length);
  for (let i = 0; i < hN.length; i++) {
    hNxorHg[i] = hN[i]! ^ hg[i]!;
  }
  const hUser = sha256(Buffer.from(state.username, "utf-8"));

  const M1buf = sha256(
    Buffer.concat([hNxorHg, hUser, salt, padToN(bigIntToBuffer(state.A)), padToN(bigIntToBuffer(B)), K]),
  );

  // M2 = H(A, M1, K)
  const M2buf = sha256(Buffer.concat([padToN(bigIntToBuffer(state.A)), M1buf, K]));

  return {
    M1: M1buf.toString("base64"),
    M2: M2buf.toString("base64"),
  };
}
