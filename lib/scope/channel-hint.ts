/**
 * Lightweight channel-hint derivation, extracted from `lib/scope-audit.ts`
 * so the exec-gate hook bundle doesn't pull `better-sqlite3` at module
 * load. The audit module's top-level `import Database from "better-sqlite3"`
 * fires a native-module require at every bundle boot — extra ~30-40 ms on
 * the hook's hot path. By splitting the pure function out, the audit
 * surface keeps its database imports (it's the only consumer that needs
 * them) and the resolver path only requires the path/lowercase loop.
 */

import { CHANNEL_REGISTRY } from "../channel-detector.ts";
import type { ChannelName } from "../channel-detector.ts";

/**
 * Map a path-like string to a known channel name, using the registry
 * markers as substring hints. Returns null when nothing matches.
 */
export function deriveChannelHint(p: string): ChannelName | null {
  if (!p) return null;
  const lower = p.toLowerCase();
  for (const entry of CHANNEL_REGISTRY) {
    for (const marker of entry.cacheMarkers) {
      if (marker && lower.includes(marker.toLowerCase())) {
        return entry.name;
      }
    }
  }
  return null;
}
