export type LookupKind = "channel" | "agent";

const NEXT_STEP_WHEN_MISSING: Record<LookupKind, string> = {
  channel: "list_channels shows every channel; create_channel makes one",
  agent: "lookup by owner (for example 'ian.m') lists that carbon unit's agents",
};

export function lookupMissNote(query: string, requested: LookupKind | undefined, foundKinds: LookupKind[]): string | undefined {
  const searched: LookupKind[] = requested ? [requested] : ["channel", "agent"];
  const missing = searched.filter((kind) => !foundKinds.includes(kind));
  if (!missing.length) return undefined;
  return missing.map((kind) => `No ${kind} matches '${query}'; ${NEXT_STEP_WHEN_MISSING[kind]}.`).join(" ");
}
