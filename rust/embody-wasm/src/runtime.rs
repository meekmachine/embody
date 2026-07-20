use std::collections::HashMap;

use wasm_bindgen::prelude::*;

use crate::abi::{PACKED_BONE_FRAME_DELTA_STRIDE, PACKED_MORPH_FRAME_DELTA_STRIDE};
use crate::bones::{
    composite_axis_value, multiply_quat, quat_from_channel, select_axis_binding, side_scale,
    AxisBindingRow, AxisValueRow, CompositeAxis, JawBinding, RestTransform, TranslationRow,
    BONE_REST_TRANSFORM_STRIDE, BONE_TRANSLATION_ROW_STRIDE, COMPOSITE_AXIS_BINDING_ROW_STRIDE,
    COMPOSITE_AXIS_HEADER_STRIDE, COMPOSITE_AXIS_VALUE_ROW_STRIDE, FLAG_HAS_POSITION,
    FLAG_HAS_ROTATION, JAW_BINDING_STRIDE,
};
use crate::math::{clamp01, finite_or};
use crate::profile::{compile_tables, ModelData, ProfileData};

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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum TransitionTarget {
    Au(u32),
    Viseme(u32),
}

#[derive(Clone, Copy, Debug)]
struct Transition {
    target: TransitionTarget,
    from: f32,
    to: f32,
    duration: f32,
    elapsed: f32,
    balance: Option<f32>,
    jaw_scale: f32,
}

fn ease_in_out_quad(t: f32) -> f32 {
    if t < 0.5 {
        2.0 * t * t
    } else {
        -1.0 + (4.0 - 2.0 * t) * t
    }
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
    viseme_jaw_scales: Vec<f32>,
    au_bindings: Vec<AuMorphBinding>,
    viseme_bindings: Vec<VisemeMorphBinding>,
    bone_rest_transforms: HashMap<u32, RestTransform>,
    composite_axes: Vec<CompositeAxis>,
    translation_rows: Vec<TranslationRow>,
    jaw_binding: Option<JawBinding>,
    viseme_jaw_amounts: Vec<f32>,
    continuum_pairs: HashMap<u32, (u32, bool)>,
    viseme_slot_ids: Vec<String>,
    transitions: Vec<Transition>,
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
            viseme_jaw_scales: vec![1.0; viseme_slot_count as usize],
            au_bindings: Vec::new(),
            viseme_bindings: Vec::new(),
            bone_rest_transforms: HashMap::new(),
            composite_axes: Vec::new(),
            translation_rows: Vec::new(),
            jaw_binding: None,
            viseme_jaw_amounts: Vec::new(),
            continuum_pairs: HashMap::new(),
            viseme_slot_ids: Vec::new(),
            transitions: Vec::new(),
        }
    }

    /// Configure the core from the profile and model descriptor JSON hosts
    /// already have. All binding compilation (mesh/morph/bone name resolution,
    /// composite axes, translations, jaw, viseme slots, mix defaults,
    /// continuum pairs) happens here, inside the core.
    #[wasm_bindgen]
    pub fn configure(&mut self, profile_json: &str, model_json: &str) -> Result<(), JsError> {
        let profile: ProfileData = serde_json::from_str(profile_json)
            .map_err(|err| JsError::new(&format!("Invalid profile JSON: {err}")))?;
        let model: ModelData = serde_json::from_str(model_json)
            .map_err(|err| JsError::new(&format!("Invalid model descriptor JSON: {err}")))?;

        let tables = compile_tables(&profile, &model);

        self.load_au_morph_bindings(&tables.au_morph_bindings);
        self.load_viseme_morph_bindings(&tables.viseme_morph_bindings);
        self.set_mixed_aus(&tables.mixed_aus);
        self.set_viseme_slot_count(tables.viseme_slot_count);
        self.load_viseme_jaw_amounts(&tables.viseme_jaw_amounts);
        self.load_bone_rest_transforms(&tables.rest_transforms);
        self.load_composite_axes(&tables.composite_axes);
        self.load_bone_translations(&tables.translations);
        self.load_jaw_binding(&tables.jaw_binding);

        self.mix_weights.clear();
        for (au_id, weight) in tables.mix_defaults {
            self.mix_weights.insert(au_id, clamp01(weight));
        }
        self.continuum_pairs = tables.continuum_pairs;
        self.viseme_slot_ids = tables.viseme_slot_ids;
        Ok(())
    }

    #[wasm_bindgen]
    pub fn viseme_slot_index(&self, slot_id: &str) -> i32 {
        self.viseme_slot_ids
            .iter()
            .position(|id| id == slot_id)
            .map(|index| index as i32)
            .unwrap_or(-1)
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

    /// Continuum-aware AU set. Negative values route through the configured
    /// continuum pair (e.g. eyes left/right) exactly like the legacy runtime.
    #[wasm_bindgen]
    pub fn set_au_signed(&mut self, id: u32, value: f32, balance: f32) {
        if value < 0.0 {
            if let Some((pair_id, is_negative)) = self.continuum_pairs.get(&id).copied() {
                let (neg_au, pos_au) = if is_negative { (id, pair_id) } else { (pair_id, id) };
                let continuum_value = if is_negative { -value } else { value };
                self.set_continuum(neg_au, pos_au, continuum_value, balance);
                return;
            }
        }
        self.set_au(id, value, balance);
    }

    #[wasm_bindgen]
    pub fn set_continuum(&mut self, neg_au: u32, pos_au: u32, value: f32, balance: f32) {
        let value = clamp_signed(value);
        if value < 0.0 {
            self.set_au(pos_au, 0.0, balance);
            self.set_au(neg_au, -value, balance);
        } else {
            self.set_au(neg_au, 0.0, balance);
            self.set_au(pos_au, value, balance);
        }
    }

    #[wasm_bindgen]
    pub fn get_continuum(&self, neg_au: u32, pos_au: u32) -> f32 {
        let neg = self.get_au(neg_au);
        let pos = self.get_au(pos_au);
        if neg > 0.0 {
            -neg
        } else {
            pos
        }
    }

    /// Start (or replace) an eased AU transition. Advanced by `update`.
    #[wasm_bindgen]
    pub fn transition_au(&mut self, id: u32, to: f32, duration_ms: f32, balance: f32) {
        let from = if to < 0.0 && self.continuum_pairs.contains_key(&id) {
            let (pair_id, is_negative) = self.continuum_pairs[&id];
            let (neg_au, pos_au) = if is_negative { (id, pair_id) } else { (pair_id, id) };
            let current = self.get_continuum(neg_au, pos_au);
            if is_negative {
                -current
            } else {
                current
            }
        } else {
            self.get_au(id)
        };
        self.start_transition(Transition {
            target: TransitionTarget::Au(id),
            from,
            to,
            duration: duration_ms / 1000.0,
            elapsed: 0.0,
            balance: if balance.is_finite() { Some(balance) } else { None },
            jaw_scale: 1.0,
        });
    }

    #[wasm_bindgen]
    pub fn transition_viseme(&mut self, index: u32, to: f32, duration_ms: f32, jaw_scale: f32) {
        let from = self
            .viseme_values
            .get(index as usize)
            .copied()
            .unwrap_or(0.0);
        self.start_transition(Transition {
            target: TransitionTarget::Viseme(index),
            from,
            to: clamp01(to),
            duration: duration_ms / 1000.0,
            elapsed: 0.0,
            balance: None,
            jaw_scale: finite_or(jaw_scale, 1.0),
        });
    }

    /// Advance all running transitions by `dt` seconds and write the eased
    /// values into the core state. Returns the number of still-active
    /// transitions so hosts know whether a frame delta re-evaluation is due.
    #[wasm_bindgen]
    pub fn update(&mut self, dt_seconds: f32) -> u32 {
        if dt_seconds <= 0.0 {
            return self.transitions.len() as u32;
        }

        let mut transitions = std::mem::take(&mut self.transitions);
        transitions.retain_mut(|transition| {
            transition.elapsed += dt_seconds;
            let progress = (transition.elapsed / transition.duration).min(1.0);
            let value =
                transition.from + (transition.to - transition.from) * ease_in_out_quad(progress);
            match transition.target {
                TransitionTarget::Au(id) => {
                    let balance = transition
                        .balance
                        .unwrap_or_else(|| *self.au_balances.get(&id).unwrap_or(&0.0));
                    self.set_au_signed(id, value, balance);
                }
                TransitionTarget::Viseme(index) => {
                    self.set_viseme(index, value);
                    self.set_viseme_jaw_scale(index, transition.jaw_scale);
                }
            }
            progress < 1.0
        });
        self.transitions = transitions;
        self.transitions.len() as u32
    }

    #[wasm_bindgen]
    pub fn active_transition_count(&self) -> u32 {
        self.transitions.len() as u32
    }

    #[wasm_bindgen]
    pub fn clear_transitions(&mut self) {
        self.transitions.clear();
    }

    fn start_transition(&mut self, transition: Transition) {
        self.transitions
            .retain(|existing| existing.target != transition.target);
        if transition.duration <= 0.0 || (transition.to - transition.from).abs() < 1e-6 {
            let mut instant = transition;
            instant.elapsed = instant.duration.max(1e-6);
            let value = instant.to;
            match instant.target {
                TransitionTarget::Au(id) => {
                    let balance = instant
                        .balance
                        .unwrap_or_else(|| *self.au_balances.get(&id).unwrap_or(&0.0));
                    self.set_au_signed(id, value, balance);
                }
                TransitionTarget::Viseme(index) => {
                    self.set_viseme(index, value);
                    self.set_viseme_jaw_scale(index, instant.jaw_scale);
                }
            }
            return;
        }
        self.transitions.push(transition);
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
    pub fn set_viseme_jaw_scale(&mut self, index: u32, jaw_scale: f32) {
        let index = index as usize;
        if index >= self.viseme_jaw_scales.len() {
            return;
        }
        self.viseme_jaw_scales[index] = finite_or(jaw_scale, 1.0);
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

        let mut next_scales = vec![1.0; count];
        let copy_scales = self.viseme_jaw_scales.len().min(count);
        next_scales[..copy_scales].copy_from_slice(&self.viseme_jaw_scales[..copy_scales]);
        self.viseme_jaw_scales = next_scales;
    }

    #[wasm_bindgen]
    pub fn clear(&mut self) {
        self.au_values.clear();
        self.au_balances.clear();
        self.mix_weights.clear();
        for value in &mut self.viseme_values {
            *value = 0.0;
        }
        for scale in &mut self.viseme_jaw_scales {
            *scale = 1.0;
        }
        self.transitions.clear();
    }

    /// Packed rows: `[bone_id, px, py, pz, qx, qy, qz, qw] * N`
    #[wasm_bindgen]
    pub fn load_bone_rest_transforms(&mut self, values: &[f32]) {
        self.bone_rest_transforms.clear();
        let stride = BONE_REST_TRANSFORM_STRIDE;
        let mut index = 0;
        while index + stride <= values.len() {
            self.bone_rest_transforms.insert(
                values[index] as u32,
                RestTransform {
                    position: [values[index + 1], values[index + 2], values[index + 3]],
                    rotation: crate::bones::normalize_quat([
                        values[index + 4],
                        values[index + 5],
                        values[index + 6],
                        finite_or(values[index + 7], 1.0),
                    ]),
                },
            );
            index += stride;
        }
    }

    /// Variable-length blocks, one per composite axis:
    /// header `[bone_id, axis, has_directional, value_rows, binding_rows, 0, 0, 0]`,
    /// then value rows `[au_id, group, side] * value_rows`,
    /// then binding rows `[au_id, group, side, channel, scale, max_degrees] * binding_rows`.
    /// Axes must be packed grouped per bone in application order (yaw, pitch, roll).
    #[wasm_bindgen]
    pub fn load_composite_axes(&mut self, values: &[f32]) {
        let mut axes = Vec::new();
        let mut index = 0;
        while index + COMPOSITE_AXIS_HEADER_STRIDE <= values.len() {
            let bone_id = values[index] as u32;
            let axis = values[index + 1] as u8;
            let has_directional_groups = values[index + 2] as u8 == 1;
            let value_row_count = values[index + 3] as usize;
            let binding_row_count = values[index + 4] as usize;
            index += COMPOSITE_AXIS_HEADER_STRIDE;

            let values_end = index + value_row_count * COMPOSITE_AXIS_VALUE_ROW_STRIDE;
            let bindings_end = values_end + binding_row_count * COMPOSITE_AXIS_BINDING_ROW_STRIDE;
            if bindings_end > values.len() {
                break;
            }

            let mut value_rows = Vec::with_capacity(value_row_count);
            while index < values_end {
                value_rows.push(AxisValueRow {
                    au_id: values[index] as u32,
                    group: values[index + 1] as u8,
                    side: values[index + 2] as u8,
                });
                index += COMPOSITE_AXIS_VALUE_ROW_STRIDE;
            }

            let mut binding_rows = Vec::with_capacity(binding_row_count);
            while index < bindings_end {
                binding_rows.push(AxisBindingRow {
                    au_id: values[index] as u32,
                    group: values[index + 1] as u8,
                    side: values[index + 2] as u8,
                    channel: values[index + 3] as u8,
                    scale: finite_or(values[index + 4], 1.0),
                    max_degrees: finite_or(values[index + 5], 0.0),
                });
                index += COMPOSITE_AXIS_BINDING_ROW_STRIDE;
            }

            axes.push(CompositeAxis {
                bone_id,
                axis,
                has_directional_groups,
                value_rows,
                binding_rows,
            });
        }
        self.composite_axes = axes;
    }

    /// Packed rows: `[au_id, bone_id, axis(0=x,1=y,2=z), scale, max_units] * N`
    #[wasm_bindgen]
    pub fn load_bone_translations(&mut self, values: &[f32]) {
        let stride = BONE_TRANSLATION_ROW_STRIDE;
        let mut rows = Vec::with_capacity(values.len() / stride.max(1));
        let mut index = 0;
        while index + stride <= values.len() {
            rows.push(TranslationRow {
                au_id: values[index] as u32,
                bone_id: values[index + 1] as u32,
                axis: values[index + 2] as u8,
                scale: finite_or(values[index + 3], 1.0),
                max_units: finite_or(values[index + 4], 0.0),
            });
            index += stride;
        }
        self.translation_rows = rows;
    }

    /// Packed row: `[bone_id, channel, scale, max_degrees]`; empty slice clears.
    #[wasm_bindgen]
    pub fn load_jaw_binding(&mut self, values: &[f32]) {
        if values.len() < JAW_BINDING_STRIDE {
            self.jaw_binding = None;
            return;
        }
        self.jaw_binding = Some(JawBinding {
            bone_id: values[0] as u32,
            channel: values[1] as u8,
            scale: finite_or(values[2], 1.0),
            max_degrees: finite_or(values[3], 0.0),
        });
    }

    #[wasm_bindgen]
    pub fn load_viseme_jaw_amounts(&mut self, values: &[f32]) {
        self.viseme_jaw_amounts = values.to_vec();
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

    /// Packed bone FrameDelta rows: `[bone_id, px, py, pz, qx, qy, qz, qw, flags] * N`
    /// flags: bit0 = has_position, bit1 = has_rotation. Mirrors
    /// TsRuntimeCore.collectBoneWrites: composite rotations relative to rest,
    /// AU-driven translations added to rest position, and viseme jaw rotation.
    #[wasm_bindgen]
    pub fn evaluate_bone_frame_delta(&self) -> Box<[f32]> {
        let mut order: Vec<u32> = Vec::new();
        let mut writes: HashMap<u32, (Option<[f32; 3]>, Option<[f32; 4]>)> = HashMap::new();
        let mut upsert = |bone_id: u32,
                          position: Option<[f32; 3]>,
                          rotation: Option<[f32; 4]>,
                          order: &mut Vec<u32>| {
            let entry = writes.entry(bone_id).or_insert_with(|| {
                order.push(bone_id);
                (None, None)
            });
            if position.is_some() {
                entry.0 = position;
            }
            if rotation.is_some() {
                entry.1 = rotation;
            }
        };

        let effective_value = |au_id: u32, side: u8| -> f32 {
            let raw = clamp01(*self.au_values.get(&au_id).unwrap_or(&0.0));
            if raw <= 1e-6 {
                return 0.0;
            }
            let balance = *self.au_balances.get(&au_id).unwrap_or(&0.0);
            raw * side_scale(balance, side)
        };

        // Composite rotations: per bone, apply axes in packed order to the
        // rest rotation. A write is emitted even when all axes are neutral so
        // hosts reset bones to rest when AUs return to zero.
        let mut composite_index = 0;
        while composite_index < self.composite_axes.len() {
            let bone_id = self.composite_axes[composite_index].bone_id;
            let mut rotation = self
                .bone_rest_transforms
                .get(&bone_id)
                .map(|rest| rest.rotation)
                .unwrap_or([0.0, 0.0, 0.0, 1.0]);

            while composite_index < self.composite_axes.len()
                && self.composite_axes[composite_index].bone_id == bone_id
            {
                let axis = &self.composite_axes[composite_index];
                let direction = composite_axis_value(axis, effective_value);
                if direction.abs() > 1e-6 {
                    if let Some(binding) = select_axis_binding(axis, direction, effective_value) {
                        if binding.max_degrees.abs() > 0.0 {
                            rotation = multiply_quat(
                                rotation,
                                quat_from_channel(
                                    binding.channel,
                                    binding.max_degrees.to_radians()
                                        * direction.abs()
                                        * binding.scale,
                                ),
                            );
                        }
                    }
                }
                composite_index += 1;
            }

            upsert(bone_id, None, Some(rotation), &mut order);
        }

        // AU translations: per-component offsets against the rest position.
        let mut offsets: Vec<(u32, [f32; 3])> = Vec::new();
        for row in &self.translation_rows {
            let value = clamp01(*self.au_values.get(&row.au_id).unwrap_or(&0.0));
            if value <= 1e-6 {
                continue;
            }
            let offset = (value * row.scale).clamp(-1.0, 1.0) * row.max_units;
            let entry = if let Some(existing) =
                offsets.iter_mut().find(|(bone_id, _)| *bone_id == row.bone_id)
            {
                existing
            } else {
                offsets.push((row.bone_id, [0.0, 0.0, 0.0]));
                offsets.last_mut().unwrap()
            };
            entry.1[row.axis.min(2) as usize] = offset;
        }
        for (bone_id, offset) in offsets {
            let rest = self
                .bone_rest_transforms
                .get(&bone_id)
                .map(|rest| rest.position)
                .unwrap_or([0.0, 0.0, 0.0]);
            upsert(
                bone_id,
                Some([rest[0] + offset[0], rest[1] + offset[1], rest[2] + offset[2]]),
                None,
                &mut order,
            );
        }

        // Viseme-driven jaw rotation.
        let jaw_amount = self.active_viseme_jaw_amount();
        if jaw_amount > 1e-6 {
            if let Some(jaw) = &self.jaw_binding {
                let rest = self
                    .bone_rest_transforms
                    .get(&jaw.bone_id)
                    .map(|rest| rest.rotation)
                    .unwrap_or([0.0, 0.0, 0.0, 1.0]);
                let rotation = multiply_quat(
                    rest,
                    quat_from_channel(
                        jaw.channel,
                        jaw.max_degrees.to_radians() * jaw_amount * jaw.scale,
                    ),
                );
                upsert(jaw.bone_id, None, Some(rotation), &mut order);
            }
        }

        let mut out = Vec::with_capacity(order.len() * PACKED_BONE_FRAME_DELTA_STRIDE as usize);
        for bone_id in order {
            let (position, rotation) = writes[&bone_id];
            let mut flags = 0u32;
            if position.is_some() {
                flags |= FLAG_HAS_POSITION;
            }
            if rotation.is_some() {
                flags |= FLAG_HAS_ROTATION;
            }
            let position = position.unwrap_or([0.0, 0.0, 0.0]);
            let rotation = rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]);
            out.push(bone_id as f32);
            out.extend_from_slice(&position);
            out.extend_from_slice(&rotation);
            out.push(flags as f32);
        }
        out.into_boxed_slice()
    }

    fn active_viseme_jaw_amount(&self) -> f32 {
        let mut jaw_amount = 0.0f32;
        for (index, value) in self.viseme_values.iter().enumerate() {
            let value = clamp01(*value);
            if value <= 1e-6 {
                continue;
            }
            let jaw_scale = *self.viseme_jaw_scales.get(index).unwrap_or(&1.0);
            if jaw_scale.abs() <= 1e-6 {
                continue;
            }
            let amount = *self.viseme_jaw_amounts.get(index).unwrap_or(&0.0);
            jaw_amount = jaw_amount.max(amount * value * jaw_scale);
        }
        jaw_amount
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

    #[test]
    fn evaluates_composite_head_yaw_against_rest() {
        let mut core = RuntimeCore::new(0);
        // HEAD bone id 1 with identity rest.
        core.load_bone_rest_transforms(&[1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0]);
        // Yaw axis: negative AU 30 (max 20deg), positive AU 31 (max 20deg), ry channel.
        core.load_composite_axes(&[
            // header: bone 1, axis yaw(1), directional, 2 value rows, 2 binding rows
            1.0, 1.0, 1.0, 2.0, 2.0, 0.0, 0.0, 0.0,
            // value rows [au, group, side]
            30.0, 0.0, 0.0, // negative
            31.0, 1.0, 0.0, // positive
            // binding rows [au, group, side, channel, scale, max_degrees]
            30.0, 0.0, 0.0, 1.0, -1.0, 20.0,
            31.0, 1.0, 0.0, 1.0, 1.0, 20.0,
        ]);

        core.set_au(30, 0.5, 0.0); // yaw -10 degrees
        let packed = core.evaluate_bone_frame_delta();
        assert_eq!(packed.len(), PACKED_BONE_FRAME_DELTA_STRIDE as usize);
        assert_eq!(packed[0], 1.0);
        let expected_half = (-10.0f32).to_radians() / 2.0;
        assert!((packed[5] - expected_half.sin()).abs() < 1e-6); // qy
        assert!((packed[8] - 2.0).abs() < 1e-6); // rotation-only flags

        core.set_au(30, 0.0, 0.0);
        core.set_au(31, 0.25, 0.0); // yaw +5 degrees
        let packed = core.evaluate_bone_frame_delta();
        let expected_half = (5.0f32).to_radians() / 2.0;
        assert!((packed[5] - expected_half.sin()).abs() < 1e-6);
    }

    #[test]
    fn emits_rest_rotation_when_composite_axes_are_neutral() {
        let mut core = RuntimeCore::new(0);
        core.load_bone_rest_transforms(&[1.0, 0.0, 0.0, 0.0, 0.1, 0.2, 0.3, 0.9]);
        core.load_composite_axes(&[
            1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, // plain axis, 1 value + 1 binding row
            51.0, 2.0, 0.0,
            51.0, 2.0, 0.0, 1.0, 1.0, 30.0,
        ]);

        let packed = core.evaluate_bone_frame_delta();
        assert_eq!(packed.len(), PACKED_BONE_FRAME_DELTA_STRIDE as usize);
        // Normalized rest rotation is emitted so hosts reset to rest.
        let len = (0.1f32 * 0.1 + 0.2 * 0.2 + 0.3 * 0.3 + 0.9 * 0.9).sqrt();
        assert!((packed[4] - 0.1 / len).abs() < 1e-6);
        assert!((packed[8] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn evaluates_translations_and_viseme_jaw() {
        let mut core = RuntimeCore::new(2);
        core.load_bone_rest_transforms(&[
            2.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, // bone 2 rest position (1,2,3)
            3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // jaw bone 3
        ]);
        // AU 40 -> bone 2 ty, max 0.5 units.
        core.load_bone_translations(&[40.0, 2.0, 1.0, 1.0, 0.5]);
        core.load_jaw_binding(&[3.0, 0.0, 1.0, 30.0]); // rx, 30 degrees
        core.load_viseme_jaw_amounts(&[1.0, 0.4]);

        core.set_au(40, 0.5, 0.0);
        core.set_viseme(0, 0.5); // jaw amount 0.5
        core.set_viseme(1, 1.0); // jaw amount 0.4

        let packed = core.evaluate_bone_frame_delta();
        assert_eq!(packed.len(), 2 * PACKED_BONE_FRAME_DELTA_STRIDE as usize);

        // Bone 2: position = rest + (0, 0.25, 0), position-only flags.
        assert_eq!(packed[0], 2.0);
        assert!((packed[2] - 2.25).abs() < 1e-6);
        assert!((packed[8] - 1.0).abs() < 1e-6);

        // Bone 3: jaw rotation for max(0.5, 0.4) * 30 degrees = 15 degrees around x.
        assert_eq!(packed[9], 3.0);
        let expected_half = (15.0f32).to_radians() / 2.0;
        assert!((packed[13] - expected_half.sin()).abs() < 1e-6);
        assert!((packed[17] - 2.0).abs() < 1e-6);
    }

    #[test]
    fn configures_from_profile_and_model_json() {
        let profile = r#"{
            "auToMorphs": { "12": { "left": [], "right": [], "center": ["Smile"] } },
            "auToBones": { "26": [{ "node": "JAW", "channel": "rx", "scale": 1, "maxDegrees": 30 }] },
            "boneNodes": { "JAW": "Jaw" },
            "morphToMesh": { "face": ["FaceMesh"] },
            "continuumPairs": {
                "61": { "pairId": 62, "isNegative": true },
                "62": { "pairId": 61, "isNegative": false }
            },
            "visemeKeys": ["Aah"],
            "visemeJawAmounts": [1.0]
        }"#;
        let model = r#"{
            "meshes": [{ "id": 1, "name": "FaceMesh", "morphTargetIds": [7] }],
            "morphTargets": [{ "id": 7, "meshId": 1, "name": "Smile", "hostIndex": 0 }],
            "bones": [{ "id": 4, "name": "Jaw" }]
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure(profile, model).unwrap();

        core.set_au(12, 0.75, 0.0);
        let packed = core.evaluate_morph_frame_delta();
        let rows = unpack_rows(&packed);
        assert_eq!(rows, vec![(1, 7, 0.75)]);

        // Continuum pair compiled: negative set routes to the pair AU.
        core.set_au_signed(62, -0.5, 0.0);
        assert!((core.get_au(61) - 0.5).abs() < 1e-6);
        assert_eq!(core.get_au(62), 0.0);

        // Viseme drives the jaw bone compiled from AU 26.
        core.set_viseme(0, 1.0);
        let bones = core.evaluate_bone_frame_delta();
        assert_eq!(bones[0], 4.0);
        let expected_half = (30.0f32).to_radians() / 2.0;
        assert!((bones[4] - expected_half.sin()).abs() < 1e-4);
    }

    #[test]
    fn transitions_ease_au_values_via_update() {
        let mut core = RuntimeCore::new(0);
        core.transition_au(12, 1.0, 200.0, f32::NAN);
        assert_eq!(core.active_transition_count(), 1);

        // Halfway: easeInOutQuad(0.5) = 0.5.
        core.update(0.1);
        assert!((core.get_au(12) - 0.5).abs() < 1e-6);

        // Completion clamps at the target and removes the transition.
        core.update(0.2);
        assert!((core.get_au(12) - 1.0).abs() < 1e-6);
        assert_eq!(core.active_transition_count(), 0);
    }

    #[test]
    fn zero_duration_transition_applies_instantly() {
        let mut core = RuntimeCore::new(1);
        core.transition_viseme(0, 0.8, 0.0, 1.5);
        assert_eq!(core.active_transition_count(), 0);
        let packed = core.evaluate_morph_frame_delta();
        // No viseme bindings loaded, so no rows, but state is set.
        assert!(packed.is_empty());
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
