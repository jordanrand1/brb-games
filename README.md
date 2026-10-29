# BRB Arcade

Twitch chat games for BRB screens and playing along with your community:
Word Hunt, Wordle elimination, and Krillion. Streamers connect Twitch,
configure a game, and copy a personal transparent OBS Browser Source URL.

Any streamer can sign in with Twitch. The hosted beta supports up to ten active
Twitch channels at once, each with independent controls, games, connections,
records, settings and OBS URLs. One Node server
and SQLite keep the deployment small; Word Hunt uses bundled commonsense word vectors
without per-guess API fees. Krillion has a durable $2 site-wide monthly ceiling,
ten rounds per channel per UTC day, and an operator validation gate.

## Run locally

Use Node 22.8+ (Node 24 is used by the container). There are no runtime npm
packages. SQLite and TypeScript execution use Node's built-in support.

```sh
cp .env.example .env
npm ci --ignore-scripts
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). Without Twitch credentials,
the dashboard has an isolated local chat simulator. With Twitch configured,
simulation is disabled; sign in with the broadcaster account. Configure
`PUBLIC_BASE_URL` and register its `/auth/callback` path in your Twitch app.
See [.env.example](.env.example) for server-only configuration.

The dashboard has one setup/edit card and one embedded OBS source preview.
Refresh reconnects to the current round. Scores, word bags, settings, browser
sessions, encrypted Twitch credentials and active games persist in SQLite.
After five minutes without a dashboard or source, the channel pauses. Reopening
resumes saved time. After a process restart, games remain paused until a client
reconnects. Twitch tokens refresh and chat reconnects automatically; revoked
permissions require another Twitch sign-in.

## Chat games

- **Word Hunt:** type a supported word directly in chat. Local cosine
  similarity and vocabulary rank show how close it is to the secret concrete
  noun. Timers: 30/45 seconds, 1/2/3/5 minutes. The word is revealed on a solve or
  timeout, followed by a new round after eight seconds. Consecutive wins build
  levels. Solver earns 100 points, Biggest Leap 50 and Pathfinder 30. Optional
  clutch time grants five seconds for a five-point improvement near zero, at
  most once per viewer and fifteen bonus seconds per round.
- **Wordle:** `!join`, then `!guess WORD`. Six guesses each, public personal
  boards, and 30/45/60-second elimination rounds. A race is capped at 100 players.
- **Krillion:** one `!answer YOUR ANSWER` per viewer, up to 100 answers per round.
  After 30/45/60 seconds, one AI batch judges relevance and originality. Answers
  below 50 relevance score zero; valid answers score 70% relevance and 30%
  novelty. Exact duplicates get zero novelty. Provider failures preserve answers;
  explicit retries are budgeted, and uncertain requests cannot be resent.

Broadcaster/moderator chat controls: `!game wordhunt` (or `!game hunt`), `!game wordle`,
`!game krillion [optional question]`, `!stop`. Roles and broadcaster identity
come from authenticated Twitch EventSub events and are checked server-side.
The older `!game context` command remains supported.

Word Hunt **always** uses local vectors, even with `OPENAI_API_KEY` configured.
The installed vocabulary contains 30,000 guess words and 2,302 target nouns:
481 Easy, 852 Standard and 969 Expert. Easy is the default for new setups;
saved difficulty choices are retained. Easy and Standard use explicit reviewed
word lists; Expert retains specialist vocabulary. Each difficulty has a persistent shuffled
bag with no automatic repeats until exhausted. Deliberately choosing a custom
secret may repeat. Run `npm run setup:vectors` if assets are missing (one-time download of about
325 MB plus vocabulary and WordNet data). Hosted images require the bundled
assets and do not download at startup. Commonsense scoring uses ConceptNet Numberbatch 19.08. Its selected vector data
is distributed under CC BY-SA 4.0 with attribution in
[licenses/NUMBERBATCH.txt](licenses/NUMBERBATCH.txt). WordNet's notice is in
[licenses/WORDNET.txt](licenses/WORDNET.txt).

Category hints are enabled by default and can be toggled in the dashboard. A
broad topic reveals at **Start** (immediately), **Middle** (50%), or **End**
(75% through, leaving the final quarter to use it), with no API request.
Middle remains the default for existing games. Pauses freeze the reveal countdown;
refreshes and restarts preserve it. Once shown, a hint stays revealed through
timer edits and resets when the next word starts.

## Host and operate

Public signup is the default, even when an old invitation list is configured.
`OWNER_TWITCH_USER_ID` still identifies the only account allowed to use operational
controls. To close signups again, set `SIGNUP_MODE=invite` and include that owner
in `ALLOWED_TWITCH_USER_IDS`. Sign-in does not bypass the ten-active-channel
capacity limit; accounts can sign in while full and play when a slot opens.

Follow [docs/deployment.md](docs/deployment.md) for Render, access modes, Twitch
OAuth, capped AI, R2 backups, release checks and rollback. The starting budget
is $7 compute + $0.25 disk + up to $2 AI, before taxes and bandwidth overages.
[docs/storage.md](docs/storage.md) explains migration, encryption, retention,
crash recovery and backup restoration. The owner-only `/operator` page reports
connections, memory, backup health and AI budget, and runs the live judge check.

No resources are provisioned just by starting the app. Hosted operation requires
the operator's service accounts and credentials. Streamers need no API key.
Keep the personal OBS URL private; replacing it invalidates old sources.
Disconnect removes Twitch access while retaining records. Channel-data deletion
is available in the dashboard. The public `/privacy` page describes saved data.

## Verification

```sh
npm test
npm run test:load
```

Tests cover game behavior, persistent awards, account isolation, OAuth and HTTP
permissions, SSE updates, restart recovery, budget limits and encrypted backup
restoration. Automated Twitch responses are mocked; a real hosted Twitch/OBS
session and funded live judge validation are launch requirements.

## Hackathon delivery

Publish the repository and run instructions, project description, a public
YouTube demo of up to three minutes, and the main Codex build session ID.
Future ideas, including cross-community Krillion answer depth, stay in
[BACKLOG.md](BACKLOG.md).

Semantic ranking, target filtering, and model upgrades are explained in
[docs/semantic-ranking.md](docs/semantic-ranking.md).
