// Import BEFORE src/config.js loads: gives the dashboard a fixed public URL, as
// the Steam-link pages need one. (config is frozen, so it can't be set later.)
// openMode blanks DASHBOARD_URL, so it has to run first and this assignment after.
import './tmpDb.js';
import './openMode.js';

process.env.DASHBOARD_URL = 'https://panel.example';
