import pg from 'pg';
const pool = new pg.Pool({
    connectionString: 'postgresql://postgres:dsHOrRoYPjtsalVZxtUOtijhdfKFpzvt@shortline.proxy.rlwy.net:14727/railway',
    ssl: { rejectUnauthorized: false }
});

async function reverseGeocode(lat, lng) {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=16&addressdetails=1`;
    const res = await fetch(url, {
        headers: { 'User-Agent': 'VRM-Fleet-Dashboard/1.0' }
    });
    if (!res.ok) return null;
    return res.json();
}

async function run() {
    const sites = await pool.query('SELECT id, name, latitude, longitude FROM job_sites ORDER BY id');

    // First pass: geocode all sites
    const geoResults = [];
    for (const site of sites.rows) {
        if (!site.latitude || !site.longitude) {
            geoResults.push({ site, city: 'Unknown', state: '', address: null });
            continue;
        }

        const geo = await reverseGeocode(site.latitude, site.longitude);
        const addr = geo?.address || {};
        const road = addr.road || addr.hamlet || '';
        const city = addr.city || addr.town || addr.village || addr.county || 'Unknown';
        const state = addr.state || '';
        const zip = addr.postcode || '';

        // Build full address
        const parts = [];
        if (road) parts.push(road);
        if (city) parts.push(city);
        if (state) parts.push(state);
        if (zip) parts.push(zip);
        const address = parts.join(', ') || null;

        geoResults.push({ site, city, state, address });
        console.log(`Geocoded ${site.id}: ${city}, ${state}`);

        // Rate limit: Nominatim requires 1 req/sec
        await new Promise(r => setTimeout(r, 1100));
    }

    // Second pass: generate unique names using city + state, disambiguating duplicates
    const nameCounts = {};
    const nameAssignments = [];

    for (const { site, city, state, address } of geoResults) {
        // Keep "Big View HQ" as-is (it was manually named)
        if (site.id === 1) {
            nameAssignments.push({ id: site.id, name: site.name, address });
            continue;
        }

        const baseKey = `${city}, ${state}`;
        if (!nameCounts[baseKey]) nameCounts[baseKey] = [];
        nameCounts[baseKey].push({ id: site.id, address });
    }

    // Assign names
    for (const [baseKey, entries] of Object.entries(nameCounts)) {
        if (entries.length === 1) {
            nameAssignments.push({ id: entries[0].id, name: baseKey, address: entries[0].address });
        } else {
            // Multiple sites in same city — add number suffix
            entries.forEach((entry, idx) => {
                nameAssignments.push({
                    id: entry.id,
                    name: `${baseKey} #${idx + 1}`,
                    address: entry.address,
                });
            });
        }
    }

    // Apply updates
    console.log('\n--- Applying updates ---');
    for (const { id, name, address } of nameAssignments) {
        await pool.query(
            'UPDATE job_sites SET name = $1, address = $2 WHERE id = $3',
            [name, address, id]
        );
        console.log(`Updated site ${id}: "${name}" — ${address || '(no address)'}`);
    }

    console.log(`\nDone! Updated ${nameAssignments.length} sites.`);
    await pool.end();
}
run();
