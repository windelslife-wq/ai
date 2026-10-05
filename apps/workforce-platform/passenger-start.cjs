// cPanel Application Manager / Passenger entry point. Environment variables
// are supplied by cPanel; do not load a public .env file here.
import("./src/server.js").catch((error) => {
  console.error(`Passenger application failed to start: ${error.message}`);
  process.exit(1);
});
