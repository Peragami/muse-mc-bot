// Process-wide registry shared by every body in this process.
// dashboard.js registers each body here ({ ctx, cfg } by username) so
// one dashboard server can report and command ALL bodies — the pair
// dashboard (dashboard-pair.html) reads /api/state/all built from it.
module.exports = { bodies: {}, fixtureFix: {}, repairJob: null, locks: {}, sheepReq: null, sheepSpot: null, pondJob: null, helpReq: null, rescue: null, medicReq: null };
