export function restreamBlock(
  relay: boolean,
  direct: boolean,
  app: boolean,
  directOn: boolean,
): string | null {
  if (relay) return null;
  if (direct && app && directOn) return null;
  if (direct && app)
    return "sending to destinations is off in this app. turn on send to destinations from this app in settings, advanced";
  if (direct)
    return "this browser cannot send to destinations yet. go live from the desktop app to send to them";
  return "sending to destinations is not set up on slop yet, so only slop gets your stream";
}
