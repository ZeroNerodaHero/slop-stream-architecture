export function trimOffer(sdp: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  let mlines = 0;
  const kept = sdp.split(eol).filter((line) => {
    if (line.startsWith('m=')) mlines++;
    if (!line.startsWith('a=candidate:')) return true;
    return mlines === 1 && line.split(' ')[2]?.toLowerCase() === 'udp';
  });
  return kept.join(eol);
}
