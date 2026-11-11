//! WebAssembly bridge over `oura-protocol`.
//!
//! The PWA does Web Bluetooth I/O in TypeScript; everything that touches bytes
//! (request builders, packet framing, app-auth crypto, history-batch decoding and
//! event-body decoders) stays in open_oura's Rust so there is one source of truth.
//! The batch decode/validate logic mirrors `oura-link::history`, which is private
//! to that crate and pulls in tokio, so it is reproduced here over the same public
//! `oura-protocol` types.

use oura_protocol::auth;
use oura_protocol::device::{self, Battery, Capability, DeviceInfo};
use oura_protocol::events::{
    self, EventBatchSummary, ExtEventBatchSummary, ExtEventEnvelopeParser, RingEvent,
};
use oura_protocol::protocol::{self, Packet};
use serde::Serialize;
use wasm_bindgen::prelude::*;

fn to_js<T: Serialize + ?Sized>(value: &T) -> Result<JsValue, JsError> {
    value
        .serialize(&serde_wasm_bindgen::Serializer::json_compatible())
        .map_err(|e| JsError::new(&e.to_string()))
}

fn key16(bytes: &[u8]) -> Result<[u8; 16], JsError> {
    bytes
        .try_into()
        .map_err(|_| JsError::new("auth key must be exactly 16 bytes"))
}

// --- framing -----------------------------------------------------------------

#[derive(Serialize)]
pub struct JsPacket {
    pub tag: u8,
    pub ext: Option<u8>,
    pub payload: Vec<u8>,
}

pub fn packets_of(frame: &[u8]) -> Vec<JsPacket> {
    Packet::parse_many(frame)
        .into_iter()
        .map(|p| JsPacket {
            tag: p.tag,
            ext: p.ext_tag(),
            payload: p.payload,
        })
        .collect()
}

/// Parse every `tag|len|payload` packet in one BLE notification.
#[wasm_bindgen(js_name = parseFrame)]
pub fn parse_frame(frame: &[u8]) -> Result<JsValue, JsError> {
    to_js(&packets_of(frame))
}

/// Split a `[u16 LE len][frame]...` buffer back into notification frames.
fn split_frames(framed: &[u8]) -> Vec<&[u8]> {
    let mut out = Vec::new();
    let mut i = 0;
    while i + 2 <= framed.len() {
        let len = u16::from_le_bytes([framed[i], framed[i + 1]]) as usize;
        let end = (i + 2 + len).min(framed.len());
        out.push(&framed[i + 2..end]);
        i = end;
    }
    out
}

// --- auth --------------------------------------------------------------------

/// AES-128/ECB/PKCS7 of the ring's nonce under the 16-byte app-auth key.
#[wasm_bindgen(js_name = encryptNonce)]
pub fn encrypt_nonce(key: &[u8], nonce: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(auth::encrypt_nonce(&key16(key)?, nonce).to_vec())
}

// --- request builders --------------------------------------------------------

#[wasm_bindgen(js_name = reqFirmware)]
pub fn req_firmware() -> Vec<u8> {
    protocol::req_firmware()
}

#[wasm_bindgen(js_name = reqBattery)]
pub fn req_battery() -> Vec<u8> {
    protocol::req_battery()
}

#[wasm_bindgen(js_name = reqSerial)]
pub fn req_serial() -> Vec<u8> {
    protocol::product::SERIAL.to_vec()
}

#[wasm_bindgen(js_name = reqHardware)]
pub fn req_hardware() -> Vec<u8> {
    protocol::product::HARDWARE.to_vec()
}

#[wasm_bindgen(js_name = reqCapabilities)]
pub fn req_capabilities(page: u8) -> Vec<u8> {
    protocol::req_capabilities(page)
}

#[wasm_bindgen(js_name = reqAuthNonce)]
pub fn req_auth_nonce() -> Vec<u8> {
    protocol::req_auth_nonce()
}

#[wasm_bindgen(js_name = reqAuthenticate)]
pub fn req_authenticate(encrypted: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(protocol::req_authenticate(&key16(encrypted)?))
}

#[wasm_bindgen(js_name = reqSetAuthKey)]
pub fn req_set_auth_key(key: &[u8]) -> Result<Vec<u8>, JsError> {
    Ok(protocol::req_set_auth_key(&key16(key)?))
}

#[wasm_bindgen(js_name = reqSyncTime)]
pub fn req_sync_time(unix_secs: f64, timezone_half_hours: u8) -> Vec<u8> {
    protocol::req_sync_time(unix_secs as u64, timezone_half_hours)
}

#[wasm_bindgen(js_name = reqSyncTimeCounter)]
pub fn req_sync_time_counter(unix_secs: f64, token: u8) -> Vec<u8> {
    protocol::req_sync_time_counter(unix_secs as u64, token)
}

#[wasm_bindgen(js_name = reqStreamSubscribe)]
pub fn req_stream_subscribe(mode: u8) -> Vec<u8> {
    protocol::req_stream_subscribe(mode)
}

#[wasm_bindgen(js_name = reqEventSubscribe)]
pub fn req_event_subscribe(category: u8, flags: u16) -> Vec<u8> {
    protocol::req_event_subscribe(category, flags)
}

#[wasm_bindgen(js_name = reqParamRead)]
pub fn req_param_read(param_id: u8) -> Vec<u8> {
    protocol::req_param_read(param_id)
}

#[wasm_bindgen(js_name = reqGetEvent)]
pub fn req_get_event(start_deciseconds: u32, max_events: u8, flags: i32) -> Vec<u8> {
    protocol::req_get_event(start_deciseconds, max_events, flags)
}

#[wasm_bindgen(js_name = reqExtGetEvent)]
pub fn req_ext_get_event(start_ms: f64, max_events: u16, buffer_id: u8) -> Vec<u8> {
    protocol::req_ext_get_event(start_ms as u64, max_events, buffer_id)
}

#[wasm_bindgen(js_name = reqDataFlush)]
pub fn req_data_flush() -> Vec<u8> {
    protocol::req_data_flush()
}

#[wasm_bindgen(js_name = reqFeatureStatus)]
pub fn req_feature_status(feature: u8) -> Vec<u8> {
    protocol::req_feature_status(feature)
}

#[wasm_bindgen(js_name = reqFeatureLatest)]
pub fn req_feature_latest(feature: u8) -> Vec<u8> {
    protocol::req_feature_latest(feature)
}

#[wasm_bindgen(js_name = reqSetFeatureMode)]
pub fn req_set_feature_mode(feature: u8, mode: u8) -> Vec<u8> {
    protocol::req_set_feature_mode(feature, mode)
}

#[wasm_bindgen(js_name = reqCheckSleepAnalysis)]
pub fn req_check_sleep_analysis(force: bool) -> Vec<u8> {
    protocol::req_check_sleep_analysis(force)
}

// --- response parsers --------------------------------------------------------

fn packet(tag: u8, payload: &[u8]) -> Packet {
    Packet::new(tag, payload.to_vec())
}

#[wasm_bindgen(js_name = parseDeviceInfo)]
pub fn parse_device_info(tag: u8, payload: &[u8]) -> Result<JsValue, JsError> {
    to_js(&DeviceInfo::parse(&packet(tag, payload)))
}

#[wasm_bindgen(js_name = parseBattery)]
pub fn parse_battery(tag: u8, payload: &[u8]) -> Result<JsValue, JsError> {
    to_js(&Battery::parse(&packet(tag, payload)))
}

#[wasm_bindgen(js_name = parseProductAscii)]
pub fn parse_product_ascii(tag: u8, payload: &[u8]) -> Option<String> {
    device::parse_product_ascii(&packet(tag, payload))
}

#[wasm_bindgen(js_name = parseCapabilities)]
pub fn parse_capabilities(tag: u8, payload: &[u8]) -> Result<JsValue, JsError> {
    let caps: Vec<Capability> = device::parse_capabilities(&packet(tag, payload));
    to_js(&caps)
}

#[derive(Serialize)]
pub struct LiveHr {
    pub bpm: u16,
    pub ibi_ms: u16,
}

/// Daytime-HR live notification (`2f <len> 28 <cap=02> ... <ibi:u12|validity:u4>`).
/// Mirrors `oura-link::client::parse_live_hr_frame`.
pub fn live_hr_of(frame: &[u8]) -> Option<LiveHr> {
    if frame.len() < 10 || frame[0] != 0x2f || frame[2] != 0x28 {
        return None;
    }
    if frame[3] != protocol::feature::DAYTIME_HR {
        return None;
    }
    let ibi_ms = (((frame[9] & 0x0f) as u16) << 8) | frame[8] as u16;
    if (frame[9] >> 4) & 0x0f != 1 || !(300..=2000).contains(&ibi_ms) {
        return None;
    }
    Some(LiveHr {
        bpm: (60_000u32 / ibi_ms as u32) as u16,
        ibi_ms,
    })
}

#[wasm_bindgen(js_name = parseLiveHr)]
pub fn parse_live_hr(frame: &[u8]) -> Result<JsValue, JsError> {
    to_js(&live_hr_of(frame))
}

// --- history -----------------------------------------------------------------

#[derive(Serialize)]
pub struct JsEvent {
    pub tag: u8,
    pub name: &'static str,
    pub timestamp: u32,
    pub body_hex: String,
    pub decoded: Option<serde_json::Value>,
}

impl From<RingEvent> for JsEvent {
    fn from(e: RingEvent) -> Self {
        JsEvent {
            tag: e.tag,
            name: e.name,
            timestamp: e.timestamp,
            body_hex: e.body.iter().map(|b| format!("{b:02x}")).collect(),
            decoded: e.decoded,
        }
    }
}

#[derive(Serialize)]
pub struct JsBatch {
    pub events: Vec<JsEvent>,
    pub bytes_left: u32,
    pub next_cursor: u32,
    pub rejected_events: u32,
    pub replayed_events: u32,
    pub progressed: bool,
}

/// Matches `oura-link::history::MAX_CURSOR_ADVANCE_DS` (180 days).
const MAX_CURSOR_ADVANCE_DS: u32 = 180 * 24 * 60 * 60 * 10;

/// Decode one history batch from its notification frames and validate it against
/// the cursor that requested it. Errors when the ring's summary packet is missing
/// (link lost mid-batch) or an extended request reported a failure code.
pub fn decode_validated_batch(frames: &[&[u8]], batch_start: u32) -> Result<JsBatch, String> {
    let mut bytes_left = None;
    let mut result_code = None;
    let mut raw = Vec::new();
    let mut envelopes = ExtEventEnvelopeParser::default();
    let mut packet_count = 0usize;

    for frame in frames {
        for packet in Packet::parse_many(frame) {
            packet_count += 1;
            if packet.tag == 0x11 {
                bytes_left = EventBatchSummary::parse(&packet).map(|s| s.bytes_left);
            } else if packet.tag == 0x2f && packet.payload.first() == Some(&0x42) {
                if let Some(summary) = ExtEventBatchSummary::parse(&packet) {
                    bytes_left = Some(summary.bytes_left);
                    result_code = Some(summary.result_code);
                }
            } else if packet.tag == 0x2f && packet.payload.first() == Some(&0x43) {
                raw.extend(
                    envelopes
                        .push_packet(&packet)
                        .into_iter()
                        .filter(|p| p.tag >= protocol::HISTORY_EVENT_PREFIX)
                        .map(|p| RingEvent::from_packet(&p)),
                );
            } else if packet.tag >= protocol::HISTORY_EVENT_PREFIX {
                raw.push(RingEvent::from_packet(&packet));
            }
        }
    }

    let bytes_left = bytes_left.ok_or_else(|| {
        format!("event batch ended without a summary packet ({packet_count} packet(s) received)")
    })?;
    if let Some(code) = result_code.filter(|&c| c != 0) {
        return Err(format!(
            "extended history request failed with result code 0x{code:02x}"
        ));
    }

    let mut max_ts = batch_start;
    let mut rejected_events = 0;
    let mut replayed_events = 0;
    let events: Vec<JsEvent> = raw
        .into_iter()
        .filter(|e| {
            if e.timestamp < batch_start {
                replayed_events += 1;
                false
            } else if e.timestamp <= batch_start.saturating_add(MAX_CURSOR_ADVANCE_DS) {
                max_ts = max_ts.max(e.timestamp);
                true
            } else {
                rejected_events += 1;
                false
            }
        })
        .map(JsEvent::from)
        .collect();
    let next_cursor = if events.is_empty() {
        batch_start
    } else {
        max_ts.saturating_add(1)
    };
    Ok(JsBatch {
        progressed: !events.is_empty() && next_cursor > batch_start,
        events,
        bytes_left,
        next_cursor,
        rejected_events,
        replayed_events,
    })
}

/// `framed` is the batch's notifications as `[u16 LE len][frame]...`.
#[wasm_bindgen(js_name = decodeBatch)]
pub fn decode_batch(framed: &[u8], batch_start: u32) -> Result<JsValue, JsError> {
    let frames = split_frames(framed);
    let batch = decode_validated_batch(&frames, batch_start).map_err(|e| JsError::new(&e))?;
    to_js(&batch)
}

/// Re-decode a stored event body with the current decoders.
#[wasm_bindgen(js_name = decodeEventBody)]
pub fn decode_event_body(tag: u8, body: &[u8]) -> Result<JsValue, JsError> {
    to_js(&events::decode_event_body(tag, body))
}

#[wasm_bindgen(js_name = eventName)]
pub fn event_name(tag: u8) -> String {
    events::event_name(tag).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn h(s: &str) -> Vec<u8> {
        hex::decode(s).unwrap()
    }

    #[test]
    fn auth_vector_matches_open_oura() {
        let out = auth::encrypt_nonce(
            &key16(&h("4431967d8bacc2659743142b68391d9a")).ok().unwrap(),
            &h("0e2d6a0a08c99b4365f458e6e97382"),
        );
        assert_eq!(out.to_vec(), h("a38a8772d3acb6db5c2b516dd56987c8"));
    }

    #[test]
    fn splits_length_prefixed_frames() {
        let framed = [2, 0, 0xaa, 0xbb, 1, 0, 0xcc];
        assert_eq!(split_frames(&framed), vec![&[0xaa, 0xbb][..], &[0xcc][..]]);
    }

    #[test]
    fn decodes_a_legacy_batch_and_advances_the_cursor() {
        // temp_event (0x46) at ds 100 with one probe 31.00 °C, then the 0x11 summary
        // (events_received, sleep_progress, bytes_left=0).
        let event = h("4606640000001c0c");
        let summary = h("110801000000000000");
        let batch = decode_validated_batch(&[&event, &summary], 50).unwrap();
        assert_eq!(batch.events.len(), 1);
        assert_eq!(batch.events[0].timestamp, 100);
        assert_eq!(batch.next_cursor, 101);
        assert!(batch.progressed);
        assert_eq!(batch.bytes_left, 0);
    }

    #[test]
    fn missing_summary_is_an_error() {
        let event = h("4606640000001c0c");
        assert!(decode_validated_batch(&[&event], 0).is_err());
    }

    #[test]
    fn replayed_tail_does_not_progress() {
        let event = h("4606640000001c0c");
        let summary = h("110801000000000000");
        let batch = decode_validated_batch(&[&event, &summary], 500).unwrap();
        assert!(batch.events.is_empty());
        assert_eq!(batch.replayed_events, 1);
        assert!(!batch.progressed);
    }

    #[test]
    fn live_hr_requires_valid_ibi() {
        // ibi = 0x3e8 = 1000 ms, validity nibble 1 → 60 bpm.
        let frame = h("2f08280200000000e813");
        let hr = live_hr_of(&frame).unwrap();
        assert_eq!((hr.bpm, hr.ibi_ms), (60, 1000));
    }
}
