/**
 * CloudKit API client for fetching iCloud Notes.
 */

import { ICloudSession } from "./session.js";
import type { AuthState, CloudKitRecord } from "./types.js";

export async function fetchNotes(
  authState: AuthState,
  appleId: string,
  onProgress?: (count: number) => void,
): Promise<CloudKitRecord[]> {
  const session = new ICloudSession(appleId);
  // Restore session state
  Object.assign(session.data, authState.sessionData);

  const ckUrl = authState.webservices?.ckdatabasews?.url;
  if (!ckUrl) {
    throw new Error("CloudKit URL not available. Authentication may have failed.");
  }

  const base = `${ckUrl}/database/1/com.apple.notes/production/private`;
  const params = authState.params;

  // Step 1: List zones to get the Notes zone owner
  const zonesResp = await session.request("POST", `${base}/zones/list`, {
    json: {},
    params,
  });

  if (!zonesResp.ok) {
    throw new Error(`Failed to list zones: ${zonesResp.status}`);
  }

  const zonesData = (await zonesResp.json()) as {
    zones: Array<{
      zoneID: { zoneName: string; ownerRecordName: string };
      syncToken?: string;
    }>;
  };

  const notesZone = zonesData.zones.find((z) => z.zoneID.zoneName === "Notes");
  if (!notesZone) {
    throw new Error("Notes zone not found in iCloud");
  }

  const owner = notesZone.zoneID.ownerRecordName;
  const allRecords: CloudKitRecord[] = [];

  // Step 2: Fetch via changes/zone (gets all records)
  const changesUrl = `${base}/changes/zone`;
  const payload: {
    zones: Array<{
      zoneID: { zoneName: string; ownerRecordName: string };
      syncToken?: string;
    }>;
  } = {
    zones: [{ zoneID: { zoneName: "Notes", ownerRecordName: owner } }],
  };

  const resp = await session.request("POST", changesUrl, { json: payload, params });

  if (!resp.ok) {
    throw new Error(`Failed to fetch changes: ${resp.status}`);
  }

  const data = (await resp.json()) as {
    zones: Array<{
      records: CloudKitRecord[];
      syncToken?: string;
      moreComing?: boolean;
    }>;
  };

  const zoneData = data.zones[0];
  if (zoneData?.records) {
    allRecords.push(...zoneData.records);
    onProgress?.(allRecords.length);
  }

  // Page through if more
  let syncToken = zoneData?.syncToken;
  let moreComing = zoneData?.moreComing;

  while (moreComing && syncToken) {
    payload.zones[0]!.syncToken = syncToken;

    const pageResp = await session.request("POST", changesUrl, { json: payload, params });
    if (!pageResp.ok) break;

    const pageData = (await pageResp.json()) as typeof data;
    const pageZone = pageData.zones[0];
    if (pageZone?.records) {
      allRecords.push(...pageZone.records);
      onProgress?.(allRecords.length);
    }

    syncToken = pageZone?.syncToken;
    moreComing = pageZone?.moreComing;
  }

  // Also try records/query for Note type
  const queryUrl = `${base}/records/query`;
  const queryPayload = {
    zoneID: { zoneName: "Notes", ownerRecordName: owner },
    query: { recordType: "Note" },
  };

  try {
    const queryResp = await session.request("POST", queryUrl, { json: queryPayload, params });
    if (queryResp.ok) {
      const queryData = (await queryResp.json()) as { records: CloudKitRecord[] };
      if (queryData.records?.length) {
        // Deduplicate by recordName
        const existing = new Set(allRecords.map((r) => r.recordName));
        for (const r of queryData.records) {
          if (!existing.has(r.recordName)) {
            allRecords.push(r);
          }
        }
      }
    }
  } catch {
    // query approach is supplementary, ignore errors
  }

  return allRecords;
}
