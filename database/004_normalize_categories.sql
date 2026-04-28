-- One-time normalization of existing ai_category values.
-- Mirrors the alias map in services/categoryNormalizer.js.
-- Run AFTER updating the JS code so any new extractions are already normalized.

-- Electrical safety
UPDATE complaints SET ai_category = 'Live wire hazard'
  WHERE LOWER(ai_category) IN (
    'exposed live wires', 'exposed wires', 'live wires',
    'live wire hazard', 'electrical hazard', 'electrocution risk'
  );

-- Power outage
UPDATE complaints SET ai_category = 'Power outage'
  WHERE LOWER(ai_category) IN (
    'power cut', 'no power', 'electricity outage', 'power outage'
  );

-- No water supply
UPDATE complaints SET ai_category = 'No water supply'
  WHERE LOWER(ai_category) IN (
    'no water', 'water shortage', 'water cutoff', 'no water supply'
  );

-- Water leakage
UPDATE complaints SET ai_category = 'Water leakage'
  WHERE LOWER(ai_category) IN (
    'water leak', 'pipe leak', 'pipe burst', 'water leakage'
  );

-- Water contamination
UPDATE complaints SET ai_category = 'Water contamination'
  WHERE LOWER(ai_category) IN (
    'contaminated water', 'dirty water', 'water contamination'
  );

-- Streetlights
UPDATE complaints SET ai_category = 'Streetlight outage'
  WHERE LOWER(ai_category) IN (
    'streetlight not working', 'broken streetlight', 'streetlight outage'
  );

-- Garbage
UPDATE complaints SET ai_category = 'Garbage pile-up'
  WHERE LOWER(ai_category) IN (
    'garbage pileup', 'garbage collection', 'uncollected garbage',
    'trash pile', 'garbage pile-up'
  );

-- Drainage / sewage
UPDATE complaints SET ai_category = 'Drainage overflow'
  WHERE LOWER(ai_category) IN (
    'drainage blockage', 'blocked drain', 'drainage overflow'
  );

UPDATE complaints SET ai_category = 'Sewage overflow'
  WHERE LOWER(ai_category) IN (
    'sewer overflow', 'sewage overflow'
  );

-- Title-case anything else that's still lowercase (catches stragglers)
UPDATE complaints
  SET ai_category = UPPER(LEFT(ai_category, 1)) || SUBSTRING(ai_category FROM 2)
  WHERE ai_category IS NOT NULL
    AND ai_category != ''
    AND ai_category = LOWER(ai_category)
    AND ai_category != UPPER(LEFT(ai_category, 1)) || SUBSTRING(ai_category FROM 2);
