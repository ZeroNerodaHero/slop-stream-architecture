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
