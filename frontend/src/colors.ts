/** Shared data-identity colors (sensor families, match classes, inferred patterns). */
export const SENSOR_COLORS: Record<string, string> = { MODIS: "#FFC15A", VIIRS: "#51D6F0" };
export const MATCH_COLORS: Record<string, string> = {
  "Matched (Both)": "#FF693B",
  "VIIRS-Only": "#51D6F0",
  "MODIS-Only": "#FFC15A",
};
export const REGIME_COLORS: Record<string, string> = {
  "High-intensity likely pattern": "#F04438",
  "Small thermal-feature pattern": "#8BE7F5",
  Unclassified: "#A9C0D3",
};
