use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use crate::abi::PACKED_MORPH_FRAME_DELTA_STRIDE;
use crate::math::{clamp01, finite_or};

pub const AU_MORPH_BINDING_STRIDE: u32 = 5;
pub const VISEME_MORPH_BINDING_STRIDE: u32 = 4;

const SIDE_LEFT: u8 = 0;
const SIDE_RIGHT: u8 = 1;
const SIDE_CENTER: u8 = 2;

#[derive(Clone, Copy, Debug)]
struct AuMorphBinding {
    au_id: u32,
    side: u8,
    mesh_id: u32,
    morph_target_id: u32,
    weight: f32,
}

#[derive(Clone, Copy, Debug)]
struct VisemeMorphBinding {
    viseme_index: u32,
    mesh_id: u32,
    morph_target_id: u32,
    weight: f32,
}

/// Host-neutral live morph runtime. Owns AU/viseme/mix state and emits packed
/// morph frame deltas. Engine objects never enter this struct.
#[wasm_bindgen]
pub struct RuntimeCore {
    au_values: HashMap<u32, f32>,
    au_balances: HashMap<u32, f32>,
    mix_weights: HashMap<u32, f32>,
    mixed_aus: HashMap<u32, bool>,
    viseme_values: Vec<f32>,
    au_bindings: Vec<AuMorphBinding>,
    viseme_bindings: Vec<VisemeMorphBinding>,
}

#[wasm_bindgen]
impl RuntimeCore {
    #[wasm_bindgen(constructor)]
    pub fn new(viseme_slot_count: u32) -> RuntimeCore {
        RuntimeCore {
            au_values: HashMap::new(),
            au_balances: HashMap::new(),
            mix_weights: HashMap::new(),
            mixed_aus: HashMap::new(),
            viseme_values: vec![0.0; viseme_slot_count as usize],
            au_bindings: Vec::new(),
            viseme_bindings: Vec::new(),
        }
    }

    #[wasm_bindgen]
    pub fn au_morph_binding_stride() -> u32 {
        AU_MORPH_BINDING_STRIDE
    }

    #[wasm_bindgen]
    pub fn viseme_morph_binding_stride() -> u32 {
        VISEME_MORPH_BINDING_STRIDE
    }

    /// Packed rows: `[au_id, side, mesh_id, morph_target_id, weight] * N`
    /// side: 0=left, 1=right, 2=center
    #[wasm_bindgen]
    pub fn load_au_morph_bindings(&mut self, values: &[f32]) {
        let stride = AU_MORPH_BINDING_STRIDE as usize;
        let mut bindings = Vec::with_capacity(values.len() / stride.max(1));
        let mut index = 0;
        while index + stride <= values.len() {
            bindings.push(AuMorphBinding {
                au_id: values[index] as u32,
                side: values[index + 1] as u8,
                mesh_id: values[index + 2] as u32,
                morph_target_id: values[index + 3] as u32,
                weight: finite_or(values[index + 4], 1.0),
            });
            index += stride;
        }
        self.au_bindings = bindings;
    }

    /// Packed rows: `[viseme_index, mesh_id, morph_target_id, weight] * N`
    #[wasm_bindgen]
    pub fn load_viseme_morph_bindings(&mut self, values: &[f32]) {
        let stride = VISEME_MORPH_BINDING_STRIDE as usize;
        let mut bindings = Vec::with_capacity(values.len() / stride.max(1));
        let mut index = 0;
        while index + stride <= values.len() {
            bindings.push(VisemeMorphBinding {
                viseme_index: values[index] as u32,
                mesh_id: values[index + 1] as u32,
                morph_target_id: values[index + 2] as u32,
                weight: finite_or(values[index + 3], 1.0),
            });
            index += stride;
        }
        self.viseme_bindings = bindings;
    }

    #[wasm_bindgen]
    pub fn set_mixed_aus(&mut self, ids: &[u32]) {
        self.mixed_aus.clear();
        for id in ids {
            self.mixed_aus.insert(*id, true);
        }
    }

    #[wasm_bindgen]
    pub fn set_au(&mut self, id: u32, value: f32, balance: f32) {
        self.au_values.insert(id, clamp01(value));
        self.au_balances.insert(id, clamp_signed(balance));
    }

    #[wasm_bindgen]
    pub fn get_au(&self, id: u32) -> f32 {
        *self.au_values.get(&id).unwrap_or(&0.0)
    }

    #[wasm_bindgen]
    pub fn set_au_mix_weight(&mut self, id: u32, weight: f32) {
        self.mix_weights.insert(id, clamp01(weight));
    }

    #[wasm_bindgen]
    pub fn set_viseme(&mut self, index: u32, value: f32) {
        let index = index as usize;
        if index >= self.viseme_values.len() {
            return;
        }
        self.viseme_values[index] = clamp01(value);
    }

    #[wasm_bindgen]
    pub fn set_viseme_slot_count(&mut self, count: u32) {
        let count = count as usize;
        if self.viseme_values.len() == count {
            return;
        }
        let mut next = vec![0.0; count];
        let copy = self.viseme_values.len().min(count);
        next[..copy].copy_from_slice(&self.viseme_values[..copy]);
        self.viseme_values = next;
    }

    #[wasm_bindgen]
    pub fn clear(&mut self) {
        self.au_values.clear();
        self.au_balances.clear();
        self.mix_weights.clear();
        for value in &mut self.viseme_values {
            *value = 0.0;
        }
    }

    /// Packed morph FrameDelta rows: `[mesh_id, morph_target_id, value, mode] * N`
    #[wasm_bindgen]
    pub fn evaluate_morph_frame_delta(&self) -> Box<[f32]> {
        let mut writes: HashMap<(u32, u32), f32> = HashMap::new();

        for binding in &self.au_bindings {
            let value = *self.au_values.get(&binding.au_id).unwrap_or(&0.0);
            let balance = *self.au_balances.get(&binding.au_id).unwrap_or(&0.0);
            let mix_weight = if self.mixed_aus.contains_key(&binding.au_id) {
                *self.mix_weights.get(&binding.au_id).unwrap_or(&1.0)
            } else {
                1.0
            };
            let base = clamp01(value) * clamp01(mix_weight);
            let (left, right) = bilateral_values(base, balance);
            let side_value = match binding.side {
                SIDE_LEFT => left,
                SIDE_RIGHT => right,
                SIDE_CENTER => base,
                _ => base,
            };
            let weighted = clamp01(side_value * binding.weight);
            // Max-combine: several AUs can bind the same morph target; an
            // inactive AU must not clobber an active one.
            let entry = writes
                .entry((binding.mesh_id, binding.morph_target_id))
                .or_insert(0.0);
            if weighted > *entry {
                *entry = weighted;
            }
        }

        let mut viseme_writes: HashMap<(u32, u32), f32> = HashMap::new();
        for binding in &self.viseme_bindings {
            let index = binding.viseme_index as usize;
            let value = if index < self.viseme_values.len() {
                self.viseme_values[index]
            } else {
                0.0
            };
            let weighted = clamp01(clamp01(value) * binding.weight);
            let key = (binding.mesh_id, binding.morph_target_id);
            match viseme_writes.get(&key) {
                Some(existing) if weighted <= *existing => {}
                _ => {
                    viseme_writes.insert(key, weighted);
                }
            }
        }
        for (key, value) in viseme_writes {
            let entry = writes.entry(key).or_insert(0.0);
            if value > *entry {
                *entry = value;
            }
        }

        let mut out = Vec::with_capacity(writes.len() * PACKED_MORPH_FRAME_DELTA_STRIDE as usize);
        for ((mesh_id, morph_target_id), value) in writes {
            out.push(mesh_id as f32);
            out.push(morph_target_id as f32);
            out.push(value);
            out.push(0.0); // absolute mode
        }
        out.into_boxed_slice()
    }
}

fn bilateral_values(base: f32, balance: f32) -> (f32, f32) {
    let balance = clamp_signed(balance);
    if balance == 0.0 {
        return (base, base);
    }
    if balance < 0.0 {
        return (base, base * (1.0 + balance));
    }
    (base * (1.0 - balance), base)
}

fn clamp_signed(value: f32) -> f32 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates_bilateral_au_morph_writes() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[
            1.0, 0.0, 10.0, 100.0, 1.0, // left
            1.0, 1.0, 10.0, 101.0, 1.0, // right
            1.0, 2.0, 10.0, 102.0, 1.0, // center
        ]);
        core.set_au(1, 0.8, -0.25);

        let packed = core.evaluate_morph_frame_delta();
        let rows = unpack_rows(&packed);
        assert_eq!(rows.len(), 3);
        assert!(rows.contains(&(10, 100, 0.8)));
        assert!(rows.contains(&(10, 101, 0.6)));
        assert!(rows.contains(&(10, 102, 0.8)));
    }

    #[test]
    fn inactive_au_does_not_clobber_active_au_on_shared_morph() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[
            43.0, 0.0, 10.0, 100.0, 1.0, // AU 43 left -> morph 100
            7.0, 0.0, 10.0, 100.0, 1.0, // AU 7 left -> same morph, inactive
        ]);
        core.set_au(43, 1.0, 0.0);

        let packed = core.evaluate_morph_frame_delta();
        let rows = unpack_rows(&packed);
        assert_eq!(rows, vec![(10, 100, 1.0)]);
    }

    #[test]
    fn evaluates_viseme_max_aggregation() {
        let mut core = RuntimeCore::new(2);
        core.load_viseme_morph_bindings(&[
            0.0, 20.0, 200.0, 1.0,
            0.0, 20.0, 201.0, 0.5,
            1.0, 20.0, 200.0, 0.25,
        ]);
        core.set_viseme(0, 0.75);
        core.set_viseme(1, 1.0);

        let packed = core.evaluate_morph_frame_delta();
        let rows = unpack_rows(&packed);
        assert!(rows.contains(&(20, 200, 0.75))); // max(0.75, 0.25)
        assert!(rows.contains(&(20, 201, 0.375)));
    }

    #[test]
    fn applies_mix_weight_only_for_mixed_aus() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[2.0, 2.0, 1.0, 50.0, 1.0]);
        core.set_mixed_aus(&[2]);
        core.set_au_mix_weight(2, 0.5);
        core.set_au(2, 1.0, 0.0);

        let packed = core.evaluate_morph_frame_delta();
        let rows = unpack_rows(&packed);
        assert_eq!(rows, vec![(1, 50, 0.5)]);
    }

    fn unpack_rows(packed: &[f32]) -> Vec<(u32, u32, f32)> {
        let stride = PACKED_MORPH_FRAME_DELTA_STRIDE as usize;
        let mut rows = Vec::new();
        let mut index = 0;
        while index + stride <= packed.len() {
            rows.push((
                packed[index] as u32,
                packed[index + 1] as u32,
                packed[index + 2],
            ));
            index += stride;
        }
        rows.sort_by_key(|row| (row.0, row.1));
        rows
    }
}
