import json, sys, time
from playwright.sync_api import sync_playwright
secs = int(sys.argv[1]) if len(sys.argv) > 1 else 40
with sync_playwright() as p:
    br = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required', '--disable-features=WebRtcHideLocalIpsWithMdns', '--allow-loopback-in-peer-connection', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--force-webrtc-ip-handling-policy=default'])
    ctx = br.new_context(permissions=['camera', 'microphone'])
    pg = ctx.new_page()
    pg.goto('http://127.0.0.1:8765/whip.html')
    print(json.dumps(pg.evaluate("go('http://127.0.0.1:8889/live/whip')")), flush=True)
    time.sleep(5)
    print(pg.evaluate("pc.getSenders().map(s => s.track && s.track.kind).join(',') + ' ' + pc.connectionState"), flush=True)
    time.sleep(secs)
    stats = pg.evaluate("""async () => { const out = []; (await pc.getStats()).forEach(r => { if (r.type === 'outbound-rtp') out.push({kind: r.kind, bytes: r.bytesSent, frames: r.framesEncoded, encoder: r.encoderImplementation}); }); return out; }""")
    print(json.dumps(stats), flush=True)
    br.close()
