// Rank tiers per project — pick via PROJECT env. XP thresholds ascending.
export const RANKSETS = {
  chronic: [
    { at: 0,     name: 'Seedling',  emoji: '🌱' },
    { at: 250,   name: 'Sprout',    emoji: '🌿' },
    { at: 1000,  name: 'Roller',    emoji: '🍃' },
    { at: 3000,  name: 'Stoner',    emoji: '💨' },
    { at: 8000,  name: 'Blazed',    emoji: '🔥' },
    { at: 20000, name: 'Kingpin',   emoji: '👑' },
  ],
  monwolf: [
    { at: 0,     name: 'Pup',        emoji: '🐶' },
    { at: 250,   name: 'Howler',     emoji: '🌙' },
    { at: 1000,  name: 'Hunter',     emoji: '🐺' },
    { at: 3000,  name: 'Alpha',      emoji: '⚡' },
    { at: 8000,  name: 'Pack Lord',  emoji: '🩸' },
    { at: 20000, name: 'Apex',       emoji: '👑' },
  ],
  default: [
    { at: 0,     name: 'Rookie',     emoji: '🥚' },
    { at: 250,   name: 'Regular',    emoji: '⭐' },
    { at: 1000,  name: 'Grinder',    emoji: '🔧' },
    { at: 3000,  name: 'Veteran',    emoji: '🏅' },
    { at: 8000,  name: 'Elite',      emoji: '💎' },
    { at: 20000, name: 'Legend',     emoji: '👑' },
  ],
};

export function rankFor(xp, set) {
  let r = set[0];
  for (const t of set) if (xp >= t.at) r = t;
  return r;
}
export function nextRank(xp, set) {
  for (const t of set) if (xp < t.at) return t;
  return null;
}
