// Allowed in-game emote reactions. Shared so the server can validate what the
// client sends (no arbitrary payloads) and both ends agree on the set.
export const EMOTES = [
  '😆',
  '😮',
  '😭',
  '🤪',
  '😴',
  '😡',
  '⏰',
  '👵🏻',
  '👴🏻',
  '🐶',
  '🐉',
  '🐦‍🔥',
  '🕊️',
] as const;

export type Emote = (typeof EMOTES)[number];
