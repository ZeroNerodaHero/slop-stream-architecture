use webrtc::api::interceptor_registry::{configure_rtcp_reports, configure_twcc_receiver_only};
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS, MIME_TYPE_VP8, MIME_TYPE_VP9};
use webrtc::interceptor::nack::generator::Generator;
use webrtc::interceptor::nack::responder::Responder;
use webrtc::interceptor::registry::Registry;
use webrtc::rtp_transceiver::rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTCRtpHeaderExtensionCapability, RTPCodecType};
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

fn video_capability(mime_type: &str, sdp_fmtp_line: &str) -> RTCRtpCodecCapability {
    let feedback = |typ: &str, parameter: &str| RTCPFeedback {
        typ: typ.to_owned(),
        parameter: parameter.to_owned(),
    };
    RTCRtpCodecCapability {
        mime_type: mime_type.to_owned(),
        clock_rate: 90000,
        channels: 0,
        sdp_fmtp_line: sdp_fmtp_line.to_owned(),
        rtcp_feedback: vec![
            feedback("goog-remb", ""),
            feedback("ccm", "fir"),
            feedback("nack", ""),
            feedback("nack", "pli"),
        ],
    }
}

pub fn vp8_capability() -> RTCRtpCodecCapability {
    video_capability(MIME_TYPE_VP8, "")
}

pub fn vp9_capability() -> RTCRtpCodecCapability {
    video_capability(MIME_TYPE_VP9, "profile-id=0")
}

pub fn media_setup(twcc: bool, vp9: bool, resend: Option<std::sync::Arc<crate::resend::Resend>>) -> anyhow::Result<(MediaEngine, Registry)> {
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
    if vp9 {
        media.register_codec(
            RTCRtpCodecParameters {
                capability: vp9_capability(),
                payload_type: 98,
                ..Default::default()
            },
            RTPCodecType::Video,
        )?;
    }

    let mut registry = Registry::new();
    match resend {
        Some(resend) => registry.add(Box::new(crate::resend::Builder(resend))),
        None => registry.add(Box::new(Responder::builder().with_log2_size(9))),
    }
    registry.add(Box::new(Generator::builder()));
    registry = configure_rtcp_reports(registry);
    if twcc {
        registry = configure_twcc_receiver_only(registry, &mut media)?;
    }
    Ok((media, registry))
}

pub fn accept_simulcast(media: &mut MediaEngine) -> anyhow::Result<()> {
    for uri in [webrtc::sdp::extmap::SDES_MID_URI, webrtc::sdp::extmap::SDES_RTP_STREAM_ID_URI] {
        media.register_header_extension(RTCRtpHeaderExtensionCapability { uri: uri.to_owned() }, RTPCodecType::Video, None)?;
    }
    Ok(())
}

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

#[cfg(test)]
fn is_vp8_keyframe(payload: &[u8]) -> bool {
    crate::simulcast::parse_vp8(payload).keyframe
}

#[cfg(test)]
mod tests {
    use super::is_vp8_keyframe;

    #[test]
    fn a_keyframe_start_with_and_without_the_extension() {
        assert!(is_vp8_keyframe(&[0x10, 0x00, 0x9d]));
        assert!(is_vp8_keyframe(&[0x90, 0xe0, 0x81, 0x23, 0x05, 0x40, 0x50]));
        assert!(is_vp8_keyframe(&[0x90, 0x80, 0x12, 0x00]));
    }

    #[test]
    fn not_a_keyframe() {
        assert!(!is_vp8_keyframe(&[0x10, 0x01]));
        assert!(!is_vp8_keyframe(&[0x90, 0x80, 0x12, 0x01]));
        assert!(!is_vp8_keyframe(&[0x00, 0x00]));
        assert!(!is_vp8_keyframe(&[0x11, 0x00]));
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

    #[test]
    fn publish_media_accepts_simulcast_rids() {
        let (mut media, _) = super::media_setup(true, true, None).unwrap();
        assert!(super::accept_simulcast(&mut media).is_ok());
    }
}
