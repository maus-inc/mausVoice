//! Limit memory committed for variable-sized CoreAudio property data.

// One MiB accommodates tens of thousands of stream buffers, device IDs or
// format ranges, while rejecting implausible lengths from a broken driver.
pub(super) const MAX_PROPERTY_BYTES: usize = 1024 * 1024;
