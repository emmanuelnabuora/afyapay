/** Kenya's 47 counties, used to check plan areas and the search filter. */
export const KENYAN_COUNTIES = [
  'Baringo', 'Bomet', 'Bungoma', 'Busia', 'Elgeyo-Marakwet', 'Embu', 'Garissa', 'Homa Bay', 'Isiolo', 'Kajiado', 'Kakamega', 'Kericho',
  'Kiambu', 'Kilifi', 'Kirinyaga', 'Kisii', 'Kisumu', 'Kitui', 'Kwale', 'Laikipia', 'Lamu', 'Machakos', 'Makueni', 'Mandera', 'Marsabit',
  'Meru', 'Migori', 'Mombasa', "Murang'a", 'Nairobi', 'Nakuru', 'Nandi', 'Narok', 'Nyamira', 'Nyandarua', 'Nyeri', 'Samburu', 'Siaya',
  'Taita-Taveta', 'Tana River', 'Tharaka-Nithi', 'Trans Nzoia', 'Turkana', 'Uasin Gishu', 'Vihiga', 'Wajir', 'West Pokot',
] as const;

const BY_KEY = new Map(KENYAN_COUNTIES.map((c) => [c.toLowerCase().replace(/[^a-z]/g, ''), c]));

/** "homa bay", "Homa-Bay" -> "Homa Bay"; null if it is not a Kenyan county. */
export function normaliseCounty(input: unknown): string | null {
  return typeof input === 'string' ? BY_KEY.get(input.toLowerCase().replace(/[^a-z]/g, '')) ?? null : null;
}
