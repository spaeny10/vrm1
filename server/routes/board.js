import { buildTrailerBoard, buildSiteBoard, summarize } from '../services/board.js';
import { getRoster } from '../services/roster.js';

export function registerBoardRoutes(app) {

// One complete row per trailer (health, telemetry, location, customer, rental)
app.get('/api/board/trailers', async (req, res) => {
    try {
        const rows = await buildTrailerBoard();
        // issues: places where the records disagree and the roster had to guess
        // warming: the server restarted and hasn't finished its first read of VRM and InControl
        res.json({ success: true, trailers: rows, summary: summarize(rows), issues: getRoster().issues, warming: getRoster().warming });
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
