# Demo stack: run the whole app locally with a realistic fleet

The simulator stands in for the Victron VRM and Peplink InControl2 APIs. It serves
24 trailers across 7 customer sites and HQ, including deliberate problem cases:

- a critical battery
- dirty panels
- an offline router
- a hot battery
- weak signal
- a healthy full-battery unit that must *not* alert

The seeder builds customers, sites, rentals in every lifecycle state, maintenance,
notes, and two weeks of history. That lets every page, chart, and alert be
exercised without production access.

## Run it

You need a local PostgreSQL database you don't mind wiping.

```bash
# 1. Telemetry simulator (leave running)
npm run demo:sim

# 2. Seed a LOCAL database (refuses non-localhost URLs; wipes app tables)
DEMO_SEED_CONFIRM=yes DATABASE_URL=postgresql://postgres@localhost:5432/vrm_demo npm run demo:seed

# 3. App server pointed at the simulator
VRM_API_BASE=http://localhost:4010/v2 VRM_API_TOKEN=demo VRM_USER_ID=1 \
IC2_API_BASE=http://localhost:4010 IC2_CLIENT_ID=demo IC2_CLIENT_SECRET=demo \
DATABASE_URL=postgresql://postgres@localhost:5432/vrm_demo JWT_SECRET=dev \
node server/server.js

# 4. Frontend
npx vite
```

## Demo logins

These are local demo data only; they're defined in `seed.js`.

| User      | Password        | Persona                        |
|-----------|-----------------|--------------------------------|
| `admin`   | `demo-admin`    | Admin (everything)             |
| `fleet`   | `demo-fleet`    | Fleet Manager                  |
| `billing` | `demo-billing`  | Billing Manager                |
| `tech`    | `demo-tech`     | Technical Manager              |
| `acme`    | `demo-customer` | Customer portal (Acme's sites) |

Telemetry follows the time of day at each site's longitude: solar output tracks the
sun, and batteries charge and drain.
