/**
 * Barber site config — points to the same Worker API but with ?site=barber
 * so the Worker reads from the "barber" KV key instead of "business".
 */
const API_BASE = "https://auto-repair-api.getyoursitelive.workers.dev/api";
const SITE_KEY = "barber";
