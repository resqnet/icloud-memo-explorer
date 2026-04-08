/** Shared type definitions */

export interface CloudKitRecord {
  recordName: string;
  recordType: string;
  fields: Record<string, CloudKitField>;
  created?: { timestamp: number };
  modified?: { timestamp: number };
}

export interface CloudKitField {
  value: unknown;
  type?: string;
}

export interface Note {
  title: string;
  body: string;
  created: Date;
  modified: Date;
  filename: string;
}

export interface SessionData {
  client_id: string;
  session_token?: string;
  trust_token?: string;
  scnt?: string;
  session_id?: string;
  auth_attributes?: string;
  account_country?: string;
}

export interface AuthState {
  sessionData: SessionData;
  cookies: Record<string, string>;
  webservices?: Record<string, { url: string }>;
  dsid?: string;
  params: Record<string, string>;
}
