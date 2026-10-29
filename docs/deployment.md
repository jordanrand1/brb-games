# Deploy the invite-only beta

The repository contains the app and deployment configuration. The operator still
needs GitHub, Render, Cloudflare R2 and a Twitch application. Streamers only need
Twitch sign-in and OBS. No hosting or cloud resources are provisioned by running
local tests.

## One-time setup

1. Push this repository to a GitHub repository. `.env`, `.data/`, databases,
   credentials and private screenshots must remain ignored. Keep the bundled
   `src/local-vectors.bin`, `src/local-vocab.json`, `src/semantic-model.json`,
   the target list, `src/context-categories.json` and `licenses/` in source.
   Git has been initialized locally; create the first commit before pushing:

   ```sh
   git add .
   git commit -m "Prepare hosted Twitch games beta"
   ```

   Create an empty GitHub repository, add its URL as `origin`, then push `main`.
   The app works with a private source repository; make it public when ready
   for the hackathon's source requirement.
2. In Render, create a Blueprint from `render.yaml`. Choose the Hobby workspace,
   the `0.5c-512mb` compute instance ($7/month), one instance, and a 1 GB disk
   ($0.25/month). Set the region closest to initial streamers before creating it.
   The Blueprint disables auto-deploy; run checks before manual deploys to avoid
   interrupting streams with every commit.
3. Set `PUBLIC_BASE_URL` to the final HTTPS `https://YOUR-SERVICE.onrender.com`
   URL, without a path. Register exactly
   `https://YOUR-SERVICE.onrender.com/auth/callback` in the Twitch developer
   console. Local and hosted callbacks can coexist in the same application.
4. Set `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. Set
   `ALLOWED_TWITCH_USER_IDS` to at most ten comma-separated **numeric user IDs**,
   not logins, and `OWNER_TWITCH_USER_ID` to your ID from that list. With the app's
   credentials in your local `.env`, run `npm run twitch:ids -- your_login invited_login`.
   It uses Twitch's official API and prints only logins and IDs. Never paste
   tokens into third-party tools.
   Production fails closed if the invitation list, owner, Twitch credentials or
   HTTPS URL are missing. Local development permits existing Twitch use when no
   invitation list is configured.
5. Render generates separate `SESSION_SECRET` and `ENCRYPTION_KEY` values. Save
   them privately outside the service. Do not replace ENCRYPTION_KEY on a deploy.
6. Create a private R2 **Standard** bucket. Add an object lifecycle rule expiring
   objects under `arcade/` after seven days. Give a bucket-scoped Object Read &
   Write API token to the app via `R2_ACCOUNT_ID`, `R2_BUCKET`,
   `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`. Do not enable public access.
7. Set a funded `OPENAI_API_KEY`, `OPENAI_JUDGE_MODEL=gpt-6-luna`, and
   `AI_MONTHLY_BUDGET_USD=2` (or a smaller value). Semantic Hunt always uses local
   commonsense vectors; this key enables only capped Krillion judging. Models other than
   the audited judge are rejected. Provider billing alerts are additional to,
   and do not replace, the application's transaction-based spending limit.
8. Deploy. Sign in as the owner, open `/operator`, run **Validate AI judge**, and
   confirm it passes. This sends one small scored batch through the same budget
   ledger. It checks direct relevance, off-topic answers, duplicates and answer
   instruction injection. Krillion remains unavailable until the check passes.
9. Run **Run backup now**, confirm a recent success, download the resulting
   encrypted object and test restoration into a disposable empty directory.
   Restore and recovery instructions are in [storage.md](storage.md).
10. Configure Render billing notifications and an external uptime check for
    `/healthz` using your preferred existing monitor. Check operator backup
    status, memory and logs during the beta. Alerts are not a hard provider bill
    ceiling; the $2 AI cap is enforced by the app, while bandwidth is metered.

The image bootstraps the persistent mount's ownership, then runs the application
as the unprivileged `node` user. Docker includes all game assets; it does not
fetch vectors at runtime. Set only one replica. Render restarts the process on
failure and terminates TLS in front of it. Do not expose the container's HTTP
port directly on the public internet.

## Existing local data

Make a private backup of `.data` before your first new local startup. The new
app automatically imports JSON once. Never copy credentials into Git. To carry
scores to Render, stop local gameplay, create a consistent SQLite export or
encrypted backup, transfer it privately and restore before first hosted use.
Use the **same ENCRYPTION_KEY** for a backup migration; source and hosted browser
cookies need a fresh sign-in. Local demo data stays isolated as `local-demo`.

A backup restore deliberately holds AI spending until reconciled. A planned
migration can remove that hold only after checking the provider's current-month
usage. Do not run local and hosted copies against independent $2 ledgers and
assume they share a global provider budget: retire the old live instance or
set its AI budget to zero after moving.

## Release checks

```sh
npm ci --ignore-scripts
npm test
npm run test:load
docker build -t brb-arcade-beta .
```

Automated HTTP integration uses test-only Twitch mocks in a child process. It
checks real endpoints, separate sign-ins, chat routing, permissions, source
rotation, restart recovery, disconnect and deletion. It sends nothing to Twitch
or OpenAI. The test-only preload is excluded from the image.

The load check runs ten channels with thirty simulated SSE clients and one
thousand guesses over twenty seconds. It fails above 400 MiB RSS or one-second
p95 guess processing. This is a local capacity gate, not a hosted throughput or
uptime guarantee. Repeat on the target deployment before enlarging the beta.

Before inviting streamers, test two real Twitch channels, broadcaster/moderator
commands, a rejected ordinary-viewer control command, an OBS refresh, and a
controlled server restart. Close the dashboard while OBS stays open and verify
chat continues. Then close every dashboard/source and confirm the channel is
released after five minutes. Finally, play a full hosted session while the
operator's computer is off. These real-account and OBS checks cannot be
substituted by mocks.

## Updates and recovery

Run checks, create a fresh backup, then manually deploy outside an active game
window. Keep the original encryption key and persistent mount. Sessions survive
normal redeployment, while live rounds reconnect from a saved paused checkpoint.
Rolling back code must remain compatible with the database schema; restore a
consistent backup if a future migration changes it incompatibly.

Do not enable autoscaling, extra databases, a custom domain or paid observability
until measured use justifies the bill. Render includes limited outbound
bandwidth; public source links have connection limits but are not a billing
firewall. A small invite list, compact updates and billing monitoring keep the
initial estimate near $9.25/month before taxes and overages.
