# RUSHED website

A static multi-page website with an optional scouting dashboard.

## Build

Run `npm ci` followed by `npm run build`. The finished website is written to `dist/` and can be served as static files.

## Dashboard data

The scouting dashboard stores accounts, submissions, reviews, and settings in the browser's local storage. It does not sync between people or browsers, and publishing the site does not restore records that were not exported. Use **Dashboard → Settings → Backup** to export or import a backup. This client-side dashboard is a prototype, not a secure production account system.

## Publishing

Pushing to `main` runs the GitHub Pages workflow and publishes the contents of `dist/`.
