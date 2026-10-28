/** Role data copied from the authenticated Twitch EventSub chat event. */
export function canControlChannelMessage(event: any): boolean {
  if (!event) return false;
  if (event.chatter_user_id && event.chatter_user_id === event.broadcaster_user_id) return true;
  return Array.isArray(event.badges) && event.badges.some((badge: any) => badge?.set_id === "moderator");
}
