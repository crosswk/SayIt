// 豆包流式 ASR 二进制 WebSocket 帧编解码

use flate2::write::GzEncoder;
use flate2::read::GzDecoder;
use flate2::Compression;
use std::io::{Read, Write};

// Protocol constants
const PROTOCOL_VERSION: u8 = 0x10; // version 1, header size 1 (4 bytes)
const MSG_FULL_CLIENT: u8 = 0x10;  // message type 1 (full client request)
const MSG_AUDIO_ONLY: u8 = 0x20;   // message type 2 (audio only)
const MSG_SERVER_RESP: u8 = 0x90;  // message type 9 (server response)
const MSG_ERROR: u8 = 0xF0;        // message type F (error)
const FLAG_NONE: u8 = 0x00;
const FLAG_LAST_AUDIO: u8 = 0x02;  // last audio packet
const SERIAL_JSON: u8 = 0x10;      // JSON serialization
const SERIAL_NONE: u8 = 0x00;
const COMPRESS_GZIP: u8 = 0x01;
#[allow(dead_code)]
const COMPRESS_NONE: u8 = 0x00;

fn gzip_compress(data: &[u8]) -> Vec<u8> {
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder.write_all(data).unwrap();
    encoder.finish().unwrap()
}

fn gzip_decompress(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut decoder = GzDecoder::new(data);
    let mut result = Vec::new();
    decoder.read_to_end(&mut result).map_err(|e| format!("gzip 解压失败: {}", e))?;
    Ok(result)
}

/// 构建 full client request 帧（JSON 参数，Gzip 压缩）
pub fn build_full_client_request(json_payload: &str) -> Vec<u8> {
    let compressed = gzip_compress(json_payload.as_bytes());
    let payload_size = compressed.len() as u32;

    let mut frame = Vec::with_capacity(8 + compressed.len());
    // Header: version(1) + header_size(1) = 0x11
    frame.push(PROTOCOL_VERSION | 0x01); // 0x11
    // Message type(full_client=1) + flags(none=0) = 0x10
    frame.push(MSG_FULL_CLIENT | FLAG_NONE);
    // Serialization(JSON=1) + Compression(Gzip=1) = 0x11
    frame.push(SERIAL_JSON | COMPRESS_GZIP);
    // Reserved
    frame.push(0x00);
    // Payload size (big-endian)
    frame.extend_from_slice(&payload_size.to_be_bytes());
    // Payload
    frame.extend_from_slice(&compressed);
    frame
}

/// 构建 audio only request 帧（原始音频，Gzip 压缩）
pub fn build_audio_request(audio_data: &[u8], is_last: bool) -> Vec<u8> {
    let compressed = gzip_compress(audio_data);
    let payload_size = compressed.len() as u32;
    let flags = if is_last { FLAG_LAST_AUDIO } else { FLAG_NONE };

    let mut frame = Vec::with_capacity(8 + compressed.len());
    frame.push(PROTOCOL_VERSION | 0x01);
    frame.push(MSG_AUDIO_ONLY | flags);
    frame.push(SERIAL_NONE | COMPRESS_GZIP);
    frame.push(0x00);
    frame.extend_from_slice(&payload_size.to_be_bytes());
    frame.extend_from_slice(&compressed);
    frame
}

/// 解析服务端响应帧
pub struct ServerResponse {
    pub is_last: bool,
    pub payload: String,
    pub is_error: bool,
    #[allow(dead_code)]
    pub error_code: u32,
}

pub fn parse_server_response(data: &[u8]) -> Result<ServerResponse, String> {
    if data.len() < 4 {
        return Err("帧太短".into());
    }

    let msg_type = data[1] & 0xF0;
    let flags = data[1] & 0x0F;
    let serialization = data[2] & 0xF0;
    let compression = data[2] & 0x0F;

    if msg_type == MSG_ERROR {
        // Error frame: 4 bytes header + 4 bytes error code + 4 bytes msg size + msg
        if data.len() < 12 {
            return Err("错误帧太短".into());
        }
        let error_code = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
        let msg_size = u32::from_be_bytes([data[8], data[9], data[10], data[11]]) as usize;
        let msg = if data.len() >= 12 + msg_size {
            String::from_utf8_lossy(&data[12..12 + msg_size]).to_string()
        } else {
            format!("error code: {}", error_code)
        };
        return Ok(ServerResponse {
            is_last: true,
            payload: msg,
            is_error: true,
            error_code,
        });
    }

    if msg_type != MSG_SERVER_RESP {
        return Err(format!("未知消息类型: 0x{:02X}", msg_type));
    }

    // 根据 flags 判断是否有 sequence 字段
    // flags bit0 = 1 表示 header 后 4 字节为 sequence number
    let has_sequence = (flags & 0x01) != 0;
    let header_len: usize = if has_sequence { 12 } else { 8 }; // 4 header + (4 seq) + 4 payload_size

    if data.len() < header_len {
        return Err("响应帧太短".into());
    }

    let payload_size_offset = if has_sequence { 8 } else { 4 };
    let payload_size = u32::from_be_bytes([
        data[payload_size_offset],
        data[payload_size_offset + 1],
        data[payload_size_offset + 2],
        data[payload_size_offset + 3],
    ]) as usize;

    let payload_offset = payload_size_offset + 4;

    if data.len() < payload_offset + payload_size {
        return Err(format!("payload 不完整: 期望 {} 字节，实际 {}", payload_size, data.len() - payload_offset));
    }

    let raw_payload = &data[payload_offset..payload_offset + payload_size];

    let payload_bytes = if compression == COMPRESS_GZIP {
        gzip_decompress(raw_payload)?
    } else {
        raw_payload.to_vec()
    };

    let payload = if serialization == SERIAL_JSON {
        String::from_utf8_lossy(&payload_bytes).to_string()
    } else {
        String::from_utf8_lossy(&payload_bytes).to_string()
    };

    let is_last = flags == 0x03 || flags == 0x02; // negative sequence or last flag

    Ok(ServerResponse {
        is_last,
        payload,
        is_error: false,
        error_code: 0,
    })
}
