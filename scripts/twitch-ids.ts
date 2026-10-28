import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^\s*(TWITCH_CLIENT_ID|TWITCH_CLIENT_SECRET)\s*=\s*(.*?)\s*$/);
  if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
}
const names = process.argv.slice(2);
if (!names.length || names.length > 10 || names.some((name) => !/^[a-zA-Z0-9_]{1,25}$/.test(name))) throw new Error("Usage: npm run twitch:ids -- your_login invited_login (up to ten logins)");
const clientId = process.env.TWITCH_CLIENT_ID || "", clientSecret = process.env.TWITCH_CLIENT_SECRET || "";
if (!clientId || !clientSecret) throw new Error("Set TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET in .env first.");
const response = await fetch("https://id.twitch.tv/oauth2/token", { method: "POST", body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: "client_credentials" }), signal: AbortSignal.timeout(15_000) });
if (!response.ok) throw new Error("Twitch could not authorize the application (" + response.status + "). Check its configured credentials.");
const token = (await response.json() as any).access_token;
const url = new URL("https://api.twitch.tv/helix/users");
for (const name of names) url.searchParams.append("login", name.toLowerCase());
const users = await fetch(url, { headers: { "Client-Id": clientId, Authorization: "Bearer " + token }, signal: AbortSignal.timeout(15_000) });
if (!users.ok) throw new Error("Twitch user lookup failed (" + users.status + ").");
const data = (await users.json() as any).data || [];
for (const name of names) { const user = data.find((entry: any) => entry.login === name.toLowerCase()); console.log(name + ": " + (user?.id || "not found")); }
