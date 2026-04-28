// services/categoryNormalizer.js
// Normalizes ai_category values for consistent clustering.
//
// Two passes:
//   1. Alias map — collapse synonyms ("exposed live wires" → "Live wire hazard")
//   2. Title-casing — "garbage pile-up" → "Garbage pile-up"
//
// Aliases are intentionally conservative — only obvious synonyms.
// When in doubt, leave separate; clustering can still find them via embeddings later.

const ALIASES = {
  // Electrical safety variants
  'exposed live wires': 'Live wire hazard',
  'exposed wires': 'Live wire hazard',
  'live wires': 'Live wire hazard',
  'live wire hazard': 'Live wire hazard',
  'electrical hazard': 'Live wire hazard',
  'electrocution risk': 'Live wire hazard',

  // Power outage variants
  'power outage': 'Power outage',
  'power cut': 'Power outage',
  'no power': 'Power outage',
  'electricity outage': 'Power outage',

  // Water supply variants
  'no water supply': 'No water supply',
  'no water': 'No water supply',
  'water shortage': 'No water supply',
  'water cutoff': 'No water supply',

  // Water leakage variants
  'water leakage': 'Water leakage',
  'water leak': 'Water leakage',
  'pipe leak': 'Water leakage',
  'pipe burst': 'Water leakage',

  // Water contamination
  'water contamination': 'Water contamination',
  'contaminated water': 'Water contamination',
  'dirty water': 'Water contamination',

  // Streetlights
  'streetlight outage': 'Streetlight outage',
  'streetlight not working': 'Streetlight outage',
  'broken streetlight': 'Streetlight outage',

  // Garbage
  'garbage pile-up': 'Garbage pile-up',
  'garbage pileup': 'Garbage pile-up',
  'garbage collection': 'Garbage pile-up',
  'uncollected garbage': 'Garbage pile-up',
  'trash pile': 'Garbage pile-up',

  // Drainage / sewage
  'drainage overflow': 'Drainage overflow',
  'drainage blockage': 'Drainage overflow',
  'blocked drain': 'Drainage overflow',
  'sewage overflow': 'Sewage overflow',
  'sewer overflow': 'Sewage overflow',
};

/**
 * Title-case while preserving punctuation and small connector words.
 * "garbage pile-up" → "Garbage pile-up"  (only first letter capitalized; that matches our convention)
 */
function titleCase(str) {
  if (!str) return str;
  // Trim, collapse whitespace.
  const cleaned = str.trim().replace(/\s+/g, ' ');
  // Capitalize first character only — matches LLM's existing output style for most categories.
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * Normalize a single category string.
 * Returns the canonical form.
 */
function normalize(category) {
  if (!category || typeof category !== 'string') return category;

  const lower = category.toLowerCase().trim();
  if (ALIASES[lower]) return ALIASES[lower];

  // No alias match → just title-case for consistency
  return titleCase(category);
}

module.exports = { normalize, ALIASES };
