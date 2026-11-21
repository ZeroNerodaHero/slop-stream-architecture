//! Codec and interceptor setup shared by the server and the dummy publisher.
//! Opus and VP8 only: every browser has both, so a publisher cannot pick a codec
//! some watcher lacks, and all watchers get the same bytes.

use webrtc::api::interceptor_registry::{configure_rtcp_reports, configure_twcc_receiver_only};
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8};
use webrtc::interceptor::nack::generator::Generator;
use webrtc::interceptor::nack::responder::Responder;
use webrtc::interceptor::registry::Registry;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType};
use webrtc::rtp_transceiver::RTCPFeedback;

pub fn opus_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
        rtcp_feedback: vec![],
    }
}

pub fn vp8_capability() -> RTCRtpCodecCapability {
    let feedback = |typ: &str, parameter: &str| RTCPFeedback {
        typ: typ.to_owned(),
        parameter: parameter.to_owned(),
    };
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_VP8.to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: String::new(),
        rtcp_feedback: vec![
            feedback("goog-remb", ""),
            feedback("ccm", "fir"),
            feedback("nack", ""),
            feedback("nack", "pli"),
        ],
    }
}

/// `twcc`: ask the remote side for transport-wide feedback. Only useful when the
/// remote is a browser uploading to us; it adapts its bitrate to that feedback.
pub fn media_setup(twcc: bool) -> anyhow::Result<(MediaEngine, Registry)> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            capability: opus_capability(),
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )?;
    media.register_codec(
        RTCRtpCodecParameters {
            capability: vp8_capability(),
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    )?;

    let mut registry = Registry::new();
    // Re-send lost packets from a short history (2^9 packets, ~2s), and ask the
    // other side to re-send what we lost.
    registry.add(Box::new(Responder::builder().with_log2_size(9)));
    registry.add(Box::new(Generator::builder()));
    registry = configure_rtcp_reports(registry);
    if twcc {
        registry = configure_twcc_receiver_only(registry, &mut media)?;
    }
    Ok((media, registry))
}

/// Opus for voice only: mono speech at a low bitrate, with DTX so silence costs
/// almost nothing. Never use it for the stream; music must not get DTX.
pub fn opus_voice_capability() -> RTCRtpCodecCapability {
    RTCRtpCodecCapability {
        mime_type: MIME_TYPE_OPUS.to_owned(),
        clock_rate: 48000,
        channels: 2,
        sdp_fmtp_line: "minptime=10;useinbandfec=1;usedtx=1;stereo=0;sprop-stereo=0;maxaveragebitrate=32000"
            .to_owned(),
        rtcp_feedback: vec![],
    }
}

/// Like `media_setup`, but for voice: the voice Opus for the mics, and VP8 for the cameras and
/// screens shown in a voice channel, with TWCC so a browser sending one adapts its bitrate.
pub fn voice_media_setup() -> anyhow::Result<(MediaEngine, Registry)> {
    let mut media = MediaEngine::default();
    media.register_codec(
        RTCRtpCodecParameters {
            capability: opus_voice_capability(),
            payload_type: 111,
            ..Default::default()
        },
        RTPCodecType::Audio,
    )?;
    media.register_codec(
        RTCRtpCodecParameters {
            capability: vp8_capability(),
            payload_type: 96,
            ..Default::default()
        },
        RTPCodecType::Video,
    )?;

    let mut registry = Registry::new();
    registry.add(Box::new(Responder::builder().with_log2_size(9)));
    registry.add(Box::new(Generator::builder()));
    registry = configure_rtcp_reports(registry);
    registry = configure_twcc_receiver_only(registry, &mut media)?;
    Ok((media, registry))
}

/// Whether a VP8 RTP payload starts a keyframe (RFC 7741): the first packet of
/// partition 0 (S set, PID 0), past the payload descriptor, with the P bit of the
/// VP8 frame tag clear. Only VP8 is registered above, so it is the one codec a
/// publisher can send us. Anything short or malformed is not a keyframe.
pub fn is_vp8_keyframe(payload: &[u8]) -> bool {
    let Some(&first) = payload.first() else { return false };
    if first & 0x10 == 0 || first & 0x07 != 0 {
        return false;
    }
    let mut at = 1;
    if first & 0x80 != 0 {
        let Some(&ext) = payload.get(at) else { return false };
        at += 1;
        // I: a picture id, 7 bits or (M set) 15
        if ext & 0x80 != 0 {
            let Some(&id) = payload.get(at) else { return false };
            at += if id & 0x80 != 0 { 2 } else { 1 };
        }
        // L: TL0PICIDX
        if ext & 0x40 != 0 {
            at += 1;
        }
        // T or K: TID/Y/KEYIDX
        if ext & 0x30 != 0 {
            at += 1;
        }
    }
    payload.get(at).is_some_and(|tag| tag & 0x01 == 0)
}

#[cfg(test)]
mod tests {
    use super::is_vp8_keyframe;

    #[test]
    fn a_keyframe_start_with_and_without_the_extension() {
        // S, PID 0, frame tag with P clear
        assert!(is_vp8_keyframe(&[0x10, 0x00, 0x9d]));
        // X, S; I with a 15 bit picture id; L; T; then the tag
        assert!(is_vp8_keyframe(&[0x90, 0xe0, 0x81, 0x23, 0x05, 0x40, 0x50]));
        // X, S; I with a 7 bit picture id
        assert!(is_vp8_keyframe(&[0x90, 0x80, 0x12, 0x00]));
    }

    #[test]
    fn not_a_keyframe() {
        // a delta frame: P set
        assert!(!is_vp8_keyframe(&[0x10, 0x01]));
        assert!(!is_vp8_keyframe(&[0x90, 0x80, 0x12, 0x01]));
        // a middle packet of a keyframe: S clear
        assert!(!is_vp8_keyframe(&[0x00, 0x00]));
        // the start of a later partition: PID 1
        assert!(!is_vp8_keyframe(&[0x11, 0x00]));
        // cut short anywhere
        assert!(!is_vp8_keyframe(&[]));
        assert!(!is_vp8_keyframe(&[0x10]));
        assert!(!is_vp8_keyframe(&[0x90]));
        assert!(!is_vp8_keyframe(&[0x90, 0x80]));
        assert!(!is_vp8_keyframe(&[0x90, 0x80, 0x92, 0x00]));
    }

    #[test]
    fn voice_opus_has_dtx_and_fec() {
        let fmtp = super::opus_voice_capability().sdp_fmtp_line;
        assert!(fmtp.split(';').any(|p| p == "usedtx=1"));
        assert!(fmtp.split(';').any(|p| p == "useinbandfec=1"));
    }

    #[test]
    fn voice_media_setup_works() {
        assert!(super::voice_media_setup().is_ok());
    }
}
