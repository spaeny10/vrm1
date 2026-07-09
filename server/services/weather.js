import { WEATHER_CACHE_TTL } from '../config.js';
import { weatherCache } from '../state.js';

// ============================================================
// Weather / Solar Irradiance (Open-Meteo, free, no API key)
// ============================================================
export async function fetchSolarIrradiance(latitude, longitude) {
    const cacheKey = `${Math.round(latitude * 10) / 10},${Math.round(longitude * 10) / 10}`;
    const cached = weatherCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_TTL) {
        return cached.data;
    }

    try {
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latitude}&longitude=${longitude}`
            + `&daily=shortwave_radiation_sum,sunshine_duration,temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code`
            + `&current=cloud_cover,temperature_2m,weather_code,wind_speed_10m`
            + `&timezone=auto&forecast_days=3`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Open-Meteo ${res.status}`);
        const json = await res.json();

        const radiationMJ = json.daily?.shortwave_radiation_sum?.[0] ?? null;
        const sunshineSec = json.daily?.sunshine_duration?.[0] ?? null;
        const cloudCover = json.current?.cloud_cover ?? null;

        const data = {
            peak_sun_hours: radiationMJ !== null ? Math.round((radiationMJ / 3.6) * 100) / 100 : null,
            sunshine_hours: sunshineSec !== null ? Math.round((sunshineSec / 3600) * 10) / 10 : null,
            cloud_cover_pct: cloudCover,
            data_source: 'open-meteo',
            temperature_current: json.current?.temperature_2m ?? null,
            weather_code: json.current?.weather_code ?? null,
            wind_speed_kmh: json.current?.wind_speed_10m ?? null,
            precipitation_mm: json.daily?.precipitation_sum?.[0] ?? null,
            forecast_3d: json.daily ? {
                dates: json.daily.time,
                weather_codes: json.daily.weather_code,
                temp_max: json.daily.temperature_2m_max,
                temp_min: json.daily.temperature_2m_min,
                radiation: json.daily.shortwave_radiation_sum,
                precipitation: json.daily.precipitation_sum,
            } : null,
        };

        weatherCache.set(cacheKey, { data, fetchedAt: Date.now() });
        return data;
    } catch (err) {
        // Fallback to astronomical calculation
        const dayOfYear = Math.floor((Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000);
        const fallback = {
            peak_sun_hours: computeAstronomicalPSH(latitude, dayOfYear),
            sunshine_hours: null,
            cloud_cover_pct: null,
            data_source: 'astronomical',
        };
        weatherCache.set(cacheKey, { data: fallback, fetchedAt: Date.now() - WEATHER_CACHE_TTL + 600000 }); // retry in 10 min
        return fallback;
    }
}

export function computeAstronomicalPSH(latitude, dayOfYear) {
    const toRad = (deg) => deg * Math.PI / 180;
    const toDeg = (rad) => rad * 180 / Math.PI;
    // Solar declination angle
    const declination = 23.45 * Math.sin(toRad(360 / 365 * (284 + dayOfYear)));
    const latRad = toRad(latitude);
    const declRad = toRad(declination);
    // Sunset hour angle
    const cosOmega = -Math.tan(latRad) * Math.tan(declRad);
    if (cosOmega > 1) return 0;   // polar night
    if (cosOmega < -1) return 12; // midnight sun
    const omega = toDeg(Math.acos(cosOmega));
    // Day length in hours
    const dayLength = 2 * omega / 15;
    // Clear-sky PSH estimate (atmospheric attenuation ~60%)
    return Math.round(dayLength * 0.60 * 100) / 100;
}
