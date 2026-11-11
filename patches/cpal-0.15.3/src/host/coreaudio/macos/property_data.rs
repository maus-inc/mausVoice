//! Validate CoreAudio's returned property lengths before reading buffers.
pub(super) fn element_count(
    returned: usize,
    capacity: usize,
    element_size: usize,
) -> Option<usize> {
    if element_size == 0 || returned > capacity || returned % element_size != 0 {
        return None;
    }
    Some(returned / element_size)
}

pub(super) fn supports_rate(min: f64, max: f64, target: u32) -> bool {
    let target = f64::from(target);
    min <= target && target <= max
}

pub(super) fn buffer_list_fits(
    returned: usize,
    offset: usize,
    element_size: usize,
    count: usize,
) -> bool {
    count
        .checked_mul(element_size)
        .and_then(|bytes| offset.checked_add(bytes))
        .is_some_and(|needed| needed <= returned)
}

#[cfg(test)]
mod tests {
    use super::{buffer_list_fits, element_count, supports_rate};

    #[test]
    fn rate_ranges_include_their_boundaries() {
        assert!(supports_rate(44_100.0, 48_000.0, 44_100));
        assert!(supports_rate(44_100.0, 48_000.0, 47_000));
        assert!(supports_rate(44_100.0, 48_000.0, 48_000));
        assert!(!supports_rate(44_100.0, 48_000.0, 96_000));
        assert!(!supports_rate(f64::NAN, 48_000.0, 44_100));
    }

    #[test]
    fn checks_returned_array_lengths() {
        assert_eq!(element_count(0, 0, 4), Some(0));
        assert_eq!(element_count(8, 12, 4), Some(2));
        assert_eq!(element_count(9, 12, 4), None);
        assert_eq!(element_count(16, 12, 4), None);
        assert_eq!(element_count(0, 0, 0), None);
    }

    #[test]
    fn checks_variable_buffer_list_bounds_and_overflow() {
        assert!(buffer_list_fits(56, 8, 16, 3));
        assert!(!buffer_list_fits(55, 8, 16, 3));
        assert!(!buffer_list_fits(usize::MAX, 8, 16, usize::MAX));
        assert!(!buffer_list_fits(usize::MAX, usize::MAX, 2, 1));
    }
}
