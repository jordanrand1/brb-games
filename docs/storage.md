# Data and recovery

One Node process owns `.data/arcade.sqlite` locally or `/var/data/arcade.sqlite`
on Render. SQLite uses WAL, foreign keys and transactions. Never run multiple
app processes against the same disk or copy only the live main database file.

| Data | Storage and lifetime |
| --- | --- |
| Broadcaster ID, login, display name, game preferences | `accounts`, until channel deletion |
| Twitch credentials | AES-256-GCM encrypted in `accounts`, removed on disconnect/revocation/deletion |
| Browser sessions | Signed HttpOnly cookie + `sessions`, 14-day expiration; disconnect invalidates all channel sessions |
| Active game, guesses, timer, current streak and scores | `snapshots`, after each game change and every five seconds |
| Community scores, shuffled bags, latest 200 round summaries | `communities`, until channel deletion |
| Completed round IDs | `completed_rounds`, permanent per-channel duplicate protection, deleted with the channel |
| AI reservations, usage and completed scoring results | `ai_requests`; uncertain requests retain their maximum charge |
| Backups | Encrypted consistent SQLite export in private R2 Standard storage, seven-day lifecycle |

Only game submissions are saved, not a general Twitch chat log. Public game state
omits secrets until reveal and omits Krillion answers until judging is complete.
SSE state is scoped to a broadcaster's authenticated session or an unguessable
read-only OBS capability. Refresh gets a complete state, then bounded patches.

`SESSION_SECRET` signs browser cookies. `ENCRYPTION_KEY` encrypts Twitch
credentials and separately derives a purpose-specific backup key. Store both in
Render environment variables and keep the encryption key in a password manager
outside Render. Rotating SESSION_SECRET signs everyone out. Replacing
ENCRYPTION_KEY without an explicit re-encryption migration makes existing tokens
and backups unreadable. Database and backup files have owner-only permissions.

The first startup imports version-1 `.data/communities/*.json` transactionally
and seeds permanent round claims from their available history. An import marker
prevents re-importing old files after a channel deletes its data. Matching legacy
Twitch tokens are imported only for allowed accounts, encrypted, and the plaintext
`twitch-session.json` is removed after a successful import. Browser sign-in must
be repeated because browser session storage has changed. Legacy community JSON
files are retained for migration safety and are not read again; archive them
privately and remove them from the hosted disk once the import is verified.

Closing the last dashboard/source starts a five-minute grace period. The game
then pauses, checkpoints, closes its Twitch socket and leaves memory. Opening a
dashboard/source resumes the saved time. Following a process restart, games stay
paused until a client reconnects; there is no simulation of unattended rounds.
A crash can lose up to five seconds of timer checkpoint progress. Accepted game
changes are saved immediately. Twitch does not replay chat messages missed during
a disconnected socket. A round already submitted for judging is never
re-submitted automatically; successful stored scores can be reused, while an
uncertain billing result is blocked from retrying.

Completed awards, their duplicate claim and the completed-game checkpoint are one transaction. Site AI budget
reservations use `BEGIN IMMEDIATE` and integer micro-dollars before a network
request. A known rejected API request releases the reservation; a timeout or
unknown result does not. Explicit retries consume their own reservation, with
at most three attempts per round. The ten-round daily allowance counts distinct
submitted round IDs in UTC. Billing totals remain anonymous after channel deletion
so deletion cannot reset the site's monthly spending. Provider rate/pricing
changes still require operator review.

## Backups and restore

The server creates a consistent `VACUUM INTO` snapshot, gzip-compresses and
AES-GCM-encrypts it, and uploads `arcade/YYYY-MM-DD.sqlite.gz.enc` to R2 using
S3 SigV4. It runs after startup and hourly checks, uploading when the prior backup
is at least 24 hours old. Failed attempts remain visible in the operator panel
and logs. Exports over 32 MiB stop with an operator warning to protect the small
server's memory. Set a seven-day R2 expiration rule so old files expire even if
the app is offline. Keep R2 private and limit its API token to this bucket.

Download a backup privately, stop the destination server, and restore into a new
empty directory with the original encryption key in the environment:

```sh
npm run backup:restore -- /private/path/backup.sqlite.gz.enc /private/path/recovered-data
```

The restore command checks authentication and SQLite integrity, expires browser
sessions, removes restored Twitch credentials, and places an AI budget hold on
the current UTC month. This prevents an older backup from resetting spending or
reviving a disconnected OBS source. Before reopening the site, reapply channel
and viewer deletions made since that backup. Reconnect Twitch normally.

Before releasing the recovery budget hold, use the provider's usage report to
reconcile charges incurred after the backup. The conservative default is to leave
AI disabled until next month. An operator who has reconciled the missing amount
can update the `recovery-hold` ledger entry to that amount (integer micro-dollars)
using SQLite while the app is stopped. Do not set it to zero without reconciling.

Start with `BRB_DATA_DIR` pointed at the recovered directory. Verify a second
round cannot award an already claimed round ID, and perform a new successful
backup. Keep a separate copy of the original backup until recovery is verified.
Render disk snapshots alone are not a substitute for the consistent database
exports. Deployments with an attached disk briefly interrupt connections.
