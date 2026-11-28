# RUSHED website

The main RUSHED site plus the **Scouting Dashboard**, a separate site at `/dashboard/` with its own look and no main-site menu.

## Build

Run `npm ci` followed by `npm run build`. The finished website is written to `dist/`. Pushing to `main` publishes it with GitHub Pages.

- Main site: `https://fatalquackers.github.io/rushed/`
- Dashboard sign in: `https://fatalquackers.github.io/rushed/dashboard/`
- Dashboard sign up: `https://fatalquackers.github.io/rushed/dashboard/signup/`

## Scouting dashboard

Anyone can create an account, but new accounts can't see anything until an **owner (Founder or Co-Founder) verifies them** in *Dashboard → Team*. The database itself enforces this, so it can't be bypassed from the browser.

Roles: Founder, Co-Founder, Management, Scout Lead, Scout.

- **Owners** (Founder, Co-Founder) verify sign-ups, change roles, pause access and edit the Discord settings. Only the Founder can give or take away owner roles.
- **Staff** (owners, Management, Scout Lead) review submitted games.
- **Scouts** submit games, update stats, track outreach and use the watchlist.

### One-time setup (about 10 minutes)

1. Create a free account at [supabase.com](https://supabase.com) and click **New project**. Pick any name and password and a region close to you.
2. In the project, open **SQL Editor → New query**. Paste everything from [`supabase/setup.sql`](supabase/setup.sql) and press **Run**.
3. Open **Project Settings → API** and copy the **Project URL** and the **anon / publishable key**. Paste them into [`src/dashboard/config.js`](src/dashboard/config.js) and push. (Both values are meant to be public.)
4. Open **Authentication → URL Configuration**:
   - set **Site URL** to `https://fatalquackers.github.io/rushed/dashboard/`
   - add the same address under **Redirect URLs**
5. Recommended: open **Authentication → Sign In / Providers → Email** and turn **Confirm email** off. Owners already check every new account, and Supabase's built-in email only sends a few emails per hour.
6. **Sign up yourself first.** The very first account becomes the Founder automatically.
7. Optional: in *Dashboard → Settings*, paste a Discord channel webhook to get sign-ups, submissions, reviews and closed deals posted to Discord. It's stored privately in the database.

### Roblox connection

The database pulls public data from Roblox by itself every 5 minutes (using Supabase's built-in `pg_net` and `pg_cron`), so nobody has to keep the page open:

- **Suggestions** lists games from Roblox's discovery lists and genre searches, ranked by a takeover score (0–100). The score favours a high efficiency factor, good likes, an owner who hasn't updated in a while, a size you could take on (50–5,000 CCU), a solo developer and growing CCU. *Add to review* sends a game into Submissions. *Hide* removes it for everyone.
- Every dashboard game gets its CCU and visits refreshed about once an hour, so its charts and growth fill in automatically.
- Pasting a Roblox link in *Submit a game* fills in the name, genre, CCU and visits.

Staff can press *Scan Roblox now* to run a scan straight away. Roblox doesn't share Discord/X links without a login, so those stay manual.

After updating `supabase/setup.sql`, run the whole file again in the SQL Editor. It's safe to run more than once.

### Moving games from the old dashboard

The old dashboard kept its games in one browser. Sign in to the new dashboard as an owner **in that same browser** and *Settings → Import from the old dashboard* offers to copy them in. A backup file exported from the old dashboard works too.
