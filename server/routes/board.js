import { buildTrailerBoard, buildSiteBoard, summarize } from '../services/board.js';

export function registerBoardRoutes(app) {

// One complete row per trailer (health, telemetry, location, customer, rental)
app.get('/api/board/trailers', async (req, res) => {
    try {
        const rows = await buildTrailerBoard();
        res.json({ success: true, trailers: rows, summary: summarize(rows) });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Per-site rollup for the sites list
app.get('/api/board/sites', async (req, res) => {
    try {
        res.json({ success: true, sites: await buildSiteBoard() });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

}
