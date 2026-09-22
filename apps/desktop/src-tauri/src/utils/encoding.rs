fn decode_utf16(
    bytes: &[u8],
    decode_code_unit: fn([u8; 2]) -> u16,
) -> Result<String, String> {
    let (code_unit_bytes, trailing_bytes) = bytes.as_chunks::<2>();
    if !trailing_bytes.is_empty() {
        return Err("UTF-16 input has an odd number of bytes".to_owned());
    }

    let code_units: Vec<u16> = code_unit_bytes
        .iter()
        .map(|bytes| decode_code_unit(*bytes))
        .collect();
    String::from_utf16(&code_units).map_err(|error| error.to_string())
}

pub fn decode_to_utf8(bytes: &[u8]) -> Result<String, String> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        decode_utf16(&bytes[2..], u16::from_le_bytes)
    } else if bytes.starts_with(&[0xFE, 0xFF]) {
        decode_utf16(&bytes[2..], u16::from_be_bytes)
    } else if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        String::from_utf8(bytes[3..].to_vec()).map_err(|e| e.to_string())
    } else {
        String::from_utf8(bytes.to_vec()).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_utf8() {
        let input = b"{\"gatewayUrl\":\"https://example.com\"}";
        assert_eq!(
            decode_to_utf8(input).expect("valid UTF-8 must decode"),
            "{\"gatewayUrl\":\"https://example.com\"}"
        );
    }

    #[test]
    fn utf8_with_bom() {
        let mut input = vec![0xEF, 0xBB, 0xBF];
        input.extend_from_slice(b"{\"key\":\"value\"}");
        assert_eq!(
            decode_to_utf8(&input).expect("valid UTF-8 with BOM must decode"),
            "{\"key\":\"value\"}"
        );
    }

    #[test]
    fn utf16_le_with_bom() {
        let json = "{\"key\":\"value\"}";
        let mut input = vec![0xFF, 0xFE];
        for u in json.encode_utf16() {
            input.extend_from_slice(&u.to_le_bytes());
        }
        assert_eq!(
            decode_to_utf8(&input).expect("valid UTF-16 LE with BOM must decode"),
            json
        );
    }

    #[test]
    fn utf16_be_with_bom() {
        let json = "{\"key\":\"value\"}";
        let mut input = vec![0xFE, 0xFF];
        for u in json.encode_utf16() {
            input.extend_from_slice(&u.to_be_bytes());
        }
        assert_eq!(
            decode_to_utf8(&input).expect("valid UTF-16 BE with BOM must decode"),
            json
        );
    }

    #[test]
    fn utf16_le_with_bom_rejects_a_trailing_byte() {
        let input = vec![0xFF, 0xFE, 0x7B];
        assert_eq!(
            decode_to_utf8(&input),
            Err("UTF-16 input has an odd number of bytes".to_owned())
        );
    }

    #[test]
    fn utf16_be_with_bom_rejects_a_trailing_byte() {
        let input = vec![0xFE, 0xFF, 0x7B];
        assert_eq!(
            decode_to_utf8(&input),
            Err("UTF-16 input has an odd number of bytes".to_owned())
        );
    }
}
