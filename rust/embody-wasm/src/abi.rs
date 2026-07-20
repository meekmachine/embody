use wasm_bindgen::prelude::*;

pub const CORE_ABI_VERSION: u32 = 1;
pub const PACKED_MORPH_FRAME_DELTA_STRIDE: u32 = 4;

#[wasm_bindgen]
pub fn core_abi_version() -> u32 {
    CORE_ABI_VERSION
}

#[wasm_bindgen]
pub fn packed_morph_frame_delta_stride() -> u32 {
    PACKED_MORPH_FRAME_DELTA_STRIDE
}

#[wasm_bindgen]
pub fn pack_morph_frame_delta(
    mesh_ids: &[u32],
    morph_target_ids: &[u32],
    values: &[f32],
    modes: &[u8],
) -> Box<[f32]> {
    let count = mesh_ids.len().min(morph_target_ids.len()).min(values.len());
    let mut out = Vec::with_capacity(count * PACKED_MORPH_FRAME_DELTA_STRIDE as usize);

    for index in 0..count {
        out.push(mesh_ids[index] as f32);
        out.push(morph_target_ids[index] as f32);
        out.push(sanitize_float(values[index]));
        out.push(*modes.get(index).unwrap_or(&0) as f32);
    }

    out.into_boxed_slice()
}

fn sanitize_float(value: f32) -> f32 {
    if value.is_finite() {
        value
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exposes_core_abi_version() {
        assert_eq!(core_abi_version(), 1);
        assert_eq!(packed_morph_frame_delta_stride(), 4);
    }

    #[test]
    fn packs_morph_frame_delta_rows() {
        let packed = pack_morph_frame_delta(&[1, 2], &[10, 20], &[0.25, f32::NAN], &[0]);
        assert_eq!(&*packed, &[1.0, 10.0, 0.25, 0.0, 2.0, 20.0, 0.0, 0.0]);
    }
}
