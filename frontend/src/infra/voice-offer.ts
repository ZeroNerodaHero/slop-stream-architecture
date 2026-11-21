/**
 * The voice offer, cut down to what the voice server can use before it goes in the join frame.
 *
 * The browser gathers candidates for every m-line of the offer (16 of them, docs/voice.md), not
 * one set: until the answer agrees to BUNDLE each m-line has its own ports. The voice server
 * bundles everything onto m-line 0's transport, so the candidates of m-lines 1 to 15 are never
 * tried. They are most of the offer, and a phone has many networks (wifi, cellular, VPNs, each
 * IPv4 and IPv6, each udp and tcp): an iPhone's offer measured 72 KB and the voice server refuses
 * anything over 48 KB with `bad offer` (MAX_SDP_BYTES in video/src/voice.rs). So: m-line 0 keeps
 * its udp candidates, tcp ones go (the voice server only listens on udp), and the others keep none.
 *
 * Only the string sent changes: the browser's own local description is left as it was.
 */
export function trimOffer(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  let mlines = 0;
  const kept = sdp.split(eol).filter((line) => {
    if (line.startsWith('m=')) mlines++;
    if (!line.startsWith('a=candidate:')) return true;
    // a=candidate:<foundation> <component> <transport> ...
    return mlines === 1 && line.split(' ')[2]?.toLowerCase() === 'udp';
  });
  return kept.join(eol);
}
