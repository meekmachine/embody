use std::collections::{BTreeMap, HashMap, HashSet};

use serde::Deserialize;
use wasm_bindgen::prelude::*;

use crate::abi::{PACKED_BONE_FRAME_DELTA_STRIDE, PACKED_MORPH_FRAME_DELTA_STRIDE};
use crate::animation::{AnimationCore, BlendMode, LoopMode};
use crate::bones::{
    composite_axis_value, multiply_quat, quat_from_channel, select_axis_binding, side_scale,
    AxisBindingRow, AxisValueRow, CompositeAxis, JawBinding, RestTransform, TranslationRow,
    BONE_REST_TRANSFORM_STRIDE, BONE_TRANSLATION_ROW_STRIDE, COMPOSITE_AXIS_BINDING_ROW_STRIDE,
    COMPOSITE_AXIS_HEADER_STRIDE, COMPOSITE_AXIS_VALUE_ROW_STRIDE, FLAG_HAS_POSITION,
    FLAG_HAS_ROTATION, JAW_BINDING_STRIDE,
};
use crate::clip::{ClipChannel, ClipIR, ClipTrackIR};
use crate::math::{clamp01, finite_or};
use crate::presets;
use crate::profile::{compile_tables, deserialize_json, CompiledTables, ModelData, ProfileData};
use crate::profile_merge::{extend_preset_with_profile, parse_profile_patch};
use crate::snippet_compile::{
    compile_snippet_tracks, AuMorphBinding as SnippetAuMorphBinding,
    CurvePoint as SnippetCurvePoint, SnippetCompileInput, SnippetCompileOptions,
    VisemeMorphBinding as SnippetVisemeMorphBinding,
};

pub const AU_MORPH_BINDING_STRIDE: u32 = 5;
pub const VISEME_MORPH_BINDING_STRIDE: u32 = 4;

const SIDE_LEFT: u8 = 0;
const SIDE_RIGHT: u8 = 1;
const SIDE_CENTER: u8 = 2;

type BoneWrite = (Option<[f32; 3]>, Option<[f32; 4]>);

fn upsert_bone_write(
    writes: &mut HashMap<u32, BoneWrite>,
    order: &mut Vec<u32>,
    bone_id: u32,
    position: Option<[f32; 3]>,
    rotation: Option<[f32; 4]>,
) {
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
}

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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeCurvePoint {
    time: f64,
    intensity: f64,
    #[serde(default)]
    inherit: bool,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct ClipBuildOptions {
    intensity_scale: Option<f64>,
    balance: Option<f32>,
    balance_map: HashMap<String, f32>,
    mesh_names: Vec<String>,
    snippet_category: Option<String>,
    source: Option<String>,
    #[serde(default)]
    auto_viseme_jaw: Option<bool>,
    #[serde(default)]
    jaw_scale: Option<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TypedChannel {
    target: serde_json::Value,
    keyframes: Vec<RuntimeCurvePoint>,
    #[serde(default)]
    intensity_scale: Option<f64>,
}

#[cfg(test)]
fn compile_resolved_profile_tables(
    profile_json: &str,
    model_json: &str,
) -> Result<CompiledTables, String> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid resolved profile JSON")?;
    if !profile.has_runtime_mappings() {
        return Err(
            "Resolved profile is incomplete: expected at least one AU, bone, or viseme mapping"
                .to_string(),
        );
    }

    let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")?;
    let tables = compile_tables(&profile, &model);
    if !tables.has_runtime_bindings() {
        return Err(format!(
            "Resolved profile is incompatible with the model descriptor: no runtime bindings resolved against {} meshes, {} morph targets, and {} bones",
            model.meshes.len(),
            model.morph_targets.len(),
            model.bones.len(),
        ));
    }

    Ok(tables)
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
    profile: Option<ProfileData>,
    model: Option<ModelData>,
    direct_morph_values: HashMap<(u32, u32), f32>,
    initial_morph_values: HashMap<(u32, u32), f32>,
    bone_rest_scales: HashMap<u32, [f32; 3]>,
    object_rest_positions: HashMap<u32, [f32; 3]>,
    object_rest_rotations: HashMap<u32, [f32; 4]>,
    object_rest_scales: HashMap<u32, [f32; 3]>,
    mesh_visibility: HashMap<u32, bool>,
    animation: AnimationCore,
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
            profile: None,
            model: None,
            direct_morph_values: HashMap::new(),
            initial_morph_values: HashMap::new(),
            bone_rest_scales: HashMap::new(),
            object_rest_positions: HashMap::new(),
            object_rest_rotations: HashMap::new(),
            object_rest_scales: HashMap::new(),
            mesh_visibility: HashMap::new(),
            animation: AnimationCore::new(),
        }
    }

    /// Configure the core from the profile and model descriptor JSON hosts
    /// already have. All binding compilation (mesh/morph/bone name resolution,
    /// composite axes, translations, jaw, viseme slots, mix defaults,
    /// continuum pairs) happens here, inside the core.
    #[wasm_bindgen]
    pub fn configure(&mut self, profile_json: &str, model_json: &str) -> Result<(), JsError> {
        let profile: ProfileData = deserialize_json(profile_json, "Invalid profile JSON")
            .map_err(|err| JsError::new(&err))?;
        let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")
            .map_err(|err| JsError::new(&err))?;
        let tables = compile_tables(&profile, &model);
        self.apply_profile_model(profile, model, tables);
        Ok(())
    }

    /// Configure from a resolved profile without applying an embedded preset.
    ///
    /// The profile must contain runtime mappings, but mappings that do not match
    /// the current model are non-fatal. The character can still render and be
    /// repaired in the authoring UI without silently substituting a preset.
    #[wasm_bindgen]
    pub fn configure_with_profile(
        &mut self,
        profile_json: &str,
        model_json: &str,
    ) -> Result<(), JsError> {
        let profile: ProfileData = deserialize_json(profile_json, "Invalid resolved profile JSON")
            .map_err(|err| JsError::new(&err))?;
        if !profile.has_runtime_mappings() {
            return Err(JsError::new(
                "Resolved profile is incomplete: expected at least one AU, bone, or viseme mapping",
            ));
        }
        let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")
            .map_err(|err| JsError::new(&err))?;
        let tables = compile_tables(&profile, &model);
        self.apply_profile_model(profile, model, tables);
        Ok(())
    }

    /// Configure from an embedded preset id + optional override JSON + model
    /// descriptor JSON. The CC4 (etc.) preset data lives in the Wasm core;
    /// hosts only pass the preset id and overrides.
    #[wasm_bindgen]
    pub fn configure_with_preset(
        &mut self,
        preset_id: &str,
        override_json: &str,
        model_json: &str,
    ) -> Result<(), JsError> {
        let base = presets::load_profile(preset_id).map_err(|err| JsError::new(&err))?;
        let extension = parse_profile_patch(override_json).map_err(|err| JsError::new(&err))?;
        let profile = extend_preset_with_profile(base, extension);
        let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")
            .map_err(|err| JsError::new(&err))?;
        let tables = compile_tables(&profile, &model);
        self.apply_profile_model(profile, model, tables);
        Ok(())
    }

    fn apply_profile_model(
        &mut self,
        profile: ProfileData,
        model: ModelData,
        tables: CompiledTables,
    ) {
        self.initial_morph_values.clear();
        self.bone_rest_scales.clear();
        self.object_rest_positions.clear();
        self.object_rest_rotations.clear();
        self.object_rest_scales.clear();
        self.mesh_visibility.clear();
        for morph in &model.morph_targets {
            self.initial_morph_values.insert(
                (morph.mesh_id, morph.id),
                finite_or(morph.initial_value, 0.0),
            );
        }
        for bone in &model.bones {
            let scale = bone
                .rest_transform
                .as_ref()
                .and_then(|transform| transform.scale.as_ref())
                .map(|value| [value.x, value.y, value.z])
                .unwrap_or([1.0, 1.0, 1.0]);
            self.bone_rest_scales.insert(bone.id, scale);
        }
        for mesh in &model.meshes {
            self.mesh_visibility.insert(mesh.id, mesh.visible);
        }
        for object in &model.objects {
            let transform = object.rest_transform.as_ref();
            self.object_rest_positions.insert(
                object.id,
                transform
                    .and_then(|transform| transform.position.as_ref())
                    .map(|value| [value.x, value.y, value.z])
                    .unwrap_or([0.0, 0.0, 0.0]),
            );
            self.object_rest_rotations.insert(
                object.id,
                transform
                    .and_then(|transform| transform.rotation.as_ref())
                    .map(|value| [value.x, value.y, value.z, value.w])
                    .unwrap_or([0.0, 0.0, 0.0, 1.0]),
            );
            self.object_rest_scales.insert(
                object.id,
                transform
                    .and_then(|transform| transform.scale.as_ref())
                    .map(|value| [value.x, value.y, value.z])
                    .unwrap_or([1.0, 1.0, 1.0]),
            );
        }
        self.direct_morph_values.clear();
        self.profile = Some(profile);
        self.model = Some(model);
        self.apply_compiled_tables(tables);
    }

    fn apply_compiled_tables(&mut self, tables: crate::profile::CompiledTables) {
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
                let (neg_au, pos_au) = if is_negative {
                    (id, pair_id)
                } else {
                    (pair_id, id)
                };
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

    /// Set an AU immediately. Duration is ignored — host mixers own timed fades.
    #[wasm_bindgen]
    pub fn transition_au(&mut self, id: u32, to: f32, _duration_ms: f32, balance: f32) {
        let resolved_balance = if balance.is_finite() {
            balance
        } else {
            *self.au_balances.get(&id).unwrap_or(&0.0)
        };
        self.set_au_signed(id, to, resolved_balance);
    }

    /// Set a viseme immediately. Duration is ignored — host mixers own timed fades.
    #[wasm_bindgen]
    pub fn transition_viseme(&mut self, index: u32, to: f32, _duration_ms: f32, jaw_scale: f32) {
        self.set_viseme(index, to);
        self.set_viseme_jaw_scale(index, finite_or(jaw_scale, 1.0));
    }

    /// Tick hook for hosts. Clip playback/lerp lives in the host animation
    /// library; Rust only exposes live AU/viseme state for packed frames.
    #[wasm_bindgen]
    pub fn update(&mut self, _dt_seconds: f32) -> u32 {
        0
    }

    #[wasm_bindgen]
    pub fn active_transition_count(&self) -> u32 {
        0
    }

    #[wasm_bindgen]
    pub fn clear_transitions(&mut self) {}

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
        self.direct_morph_values.clear();
        self.animation.stop_all();
    }

    #[wasm_bindgen]
    pub fn set_morph(&mut self, morph_name: &str, value: f32, mesh_names_json: &str) -> u32 {
        let targets = self.resolve_morph_targets(morph_name, None, mesh_names_json);
        for target in &targets {
            self.direct_morph_values.insert(*target, clamp01(value));
        }
        targets.len() as u32
    }

    #[wasm_bindgen]
    pub fn set_morph_index(&mut self, morph_index: i32, value: f32, mesh_names_json: &str) -> u32 {
        let targets = self.resolve_morph_targets("", Some(morph_index), mesh_names_json);
        for target in &targets {
            self.direct_morph_values.insert(*target, clamp01(value));
        }
        targets.len() as u32
    }

    /// Set morph(s) immediately. Duration is ignored — host mixers own timed fades.
    #[wasm_bindgen]
    pub fn transition_morph(
        &mut self,
        morph_name: &str,
        to: f32,
        _duration_ms: f32,
        mesh_names_json: &str,
    ) -> u32 {
        self.set_morph(morph_name, to, mesh_names_json)
    }

    /// Set morph index target(s) immediately. Duration is ignored.
    #[wasm_bindgen]
    pub fn transition_morph_index(
        &mut self,
        morph_index: i32,
        to: f32,
        _duration_ms: f32,
        mesh_names_json: &str,
    ) -> u32 {
        self.set_morph_index(morph_index, to, mesh_names_json)
    }

    #[wasm_bindgen]
    pub fn load_animation_clips(&mut self, clips_json: &str) -> Result<(), JsError> {
        let mut clips: Vec<ClipIR> = deserialize_json(clips_json, "Invalid animation clips JSON")
            .map_err(|error| JsError::new(&error))?;
        for clip in &mut clips {
            self.classify_baked_clip(clip);
        }
        self.animation
            .replace_clips(clips, "baked")
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen]
    pub fn register_animation_clip(
        &mut self,
        clip_json: &str,
        source: &str,
    ) -> Result<(), JsError> {
        let clip: ClipIR = deserialize_json(clip_json, "Invalid animation clip JSON")
            .map_err(|error| JsError::new(&error))?;
        self.animation
            .insert_clip(clip, if source.is_empty() { "clip" } else { source })
            .map_err(|error| JsError::new(&error))
    }

    #[wasm_bindgen]
    pub fn build_clip(
        &mut self,
        clip_name: &str,
        curves_json: &str,
        options_json: &str,
    ) -> Result<String, JsError> {
        let curves: BTreeMap<String, Vec<RuntimeCurvePoint>> =
            deserialize_json(curves_json, "Invalid snippet curves JSON")
                .map_err(|error| JsError::new(&error))?;
        let options: ClipBuildOptions = parse_runtime_json(options_json, "clip options")?;
        let clip = self.compile_curves(clip_name, curves, &options)?;
        let serialized = serialize_runtime_json(&clip, "compiled clip")?;
        self.animation
            .insert_clip(clip, options.source.as_deref().unwrap_or("snippet"))
            .map_err(|error| JsError::new(&error))?;
        Ok(serialized)
    }

    #[wasm_bindgen]
    pub fn build_typed_clip(
        &mut self,
        clip_name: &str,
        channels_json: &str,
        options_json: &str,
    ) -> Result<String, JsError> {
        let channels: Vec<TypedChannel> =
            deserialize_json(channels_json, "Invalid typed snippet channels JSON")
                .map_err(|error| JsError::new(&error))?;
        let options: ClipBuildOptions = parse_runtime_json(options_json, "clip options")?;
        let clip = self.compile_typed_channels(clip_name, channels, &options)?;
        let serialized = serialize_runtime_json(&clip, "compiled typed clip")?;
        self.animation
            .insert_clip(clip, options.source.as_deref().unwrap_or("snippet"))
            .map_err(|error| JsError::new(&error))?;
        Ok(serialized)
    }

    #[wasm_bindgen]
    pub fn play_snippet(
        &mut self,
        clip_name: &str,
        curves_json: &str,
        options_json: &str,
    ) -> Result<String, JsError> {
        self.build_clip(clip_name, curves_json, options_json)?;
        self.play_animation(clip_name, options_json)
    }

    #[wasm_bindgen]
    pub fn play_typed_snippet(
        &mut self,
        clip_name: &str,
        channels_json: &str,
        options_json: &str,
    ) -> Result<String, JsError> {
        self.build_typed_clip(clip_name, channels_json, options_json)?;
        self.play_animation(clip_name, options_json)
    }

    #[wasm_bindgen]
    pub fn update_clip_params(
        &mut self,
        clip_name: &str,
        params_json: &str,
    ) -> Result<bool, JsError> {
        if self.animation.state(clip_name).is_none() {
            return Ok(false);
        }
        let params: serde_json::Value = parse_runtime_json(params_json, "clip parameters")?;
        if let Some(weight) = params
            .get("weight")
            .or_else(|| params.get("intensity"))
            .or_else(|| params.get("mixerWeight"))
            .and_then(serde_json::Value::as_f64)
        {
            self.animation.set_weight(clip_name, weight as f32);
        }
        if let Some(speed) = params
            .get("speed")
            .or_else(|| params.get("playbackRate"))
            .and_then(serde_json::Value::as_f64)
        {
            self.animation.set_speed(clip_name, speed as f32);
        }
        if let Some(reverse) = params.get("reverse").and_then(serde_json::Value::as_bool) {
            self.animation.set_reverse(clip_name, reverse);
        }
        if let Some(mode) = params.get("blendMode").and_then(serde_json::Value::as_str) {
            self.set_animation_blend_mode(clip_name, mode)?;
        }
        if let Some(mode) = params.get("loopMode").and_then(serde_json::Value::as_str) {
            let repeat_count = params
                .get("repeatCount")
                .and_then(serde_json::Value::as_u64)
                .map(|value| value as u32);
            self.animation
                .set_loop(clip_name, parse_loop_mode(mode)?, repeat_count);
        }
        if let Some(time) = params.get("time").and_then(serde_json::Value::as_f64) {
            self.animation.seek(clip_name, time as f32);
        }
        Ok(true)
    }

    #[wasm_bindgen]
    pub fn cleanup_snippet(&mut self, clip_name: &str) -> bool {
        self.animation.remove_clip(clip_name)
    }

    #[wasm_bindgen]
    pub fn get_animation_clips(&self) -> Result<String, JsError> {
        serialize_runtime_json(&self.animation.list(), "animation clip list")
    }

    #[wasm_bindgen]
    pub fn remove_animation_clip(&mut self, clip_name: &str) -> bool {
        self.animation.remove_clip(clip_name)
    }

    /// Registry lookup only. Host animation libraries own play/lerp; this returns
    /// a host-owned action id marker when the clip exists in the registry.
    #[wasm_bindgen]
    pub fn play_animation(
        &mut self,
        clip_name: &str,
        _options_json: &str,
    ) -> Result<String, JsError> {
        if self.animation.clip(clip_name).is_none() {
            return Err(JsError::new(&format!(
                "Unknown animation clip \"{clip_name}\"."
            )));
        }
        Ok(format!("host:{clip_name}"))
    }

    /// Host-owned crossfade marker. Rust does not lerp; the host mixer should fade.
    #[wasm_bindgen]
    pub fn crossfade_to(
        &mut self,
        clip_name: &str,
        _duration: f32,
        options_json: &str,
    ) -> Result<String, JsError> {
        self.play_animation(clip_name, options_json)
    }

    #[wasm_bindgen]
    pub fn stop_animation(&mut self, clip_name: &str) {
        self.animation.stop(clip_name);
    }

    #[wasm_bindgen]
    pub fn stop_all_animations(&mut self) {
        self.animation.stop_all();
    }

    #[wasm_bindgen]
    pub fn pause_animation(&mut self, clip_name: &str) {
        self.animation.pause(clip_name, true);
    }

    #[wasm_bindgen]
    pub fn resume_animation(&mut self, clip_name: &str) {
        self.animation.pause(clip_name, false);
    }

    #[wasm_bindgen]
    pub fn pause_all_animations(&mut self) {
        self.animation.pause_all(true);
    }

    #[wasm_bindgen]
    pub fn resume_all_animations(&mut self) {
        self.animation.pause_all(false);
    }

    #[wasm_bindgen]
    pub fn set_animation_speed(&mut self, clip_name: &str, speed: f32) {
        self.animation.set_speed(clip_name, speed);
    }

    #[wasm_bindgen]
    pub fn set_animation_intensity(&mut self, clip_name: &str, intensity: f32) {
        self.animation.set_weight(clip_name, intensity);
    }

    #[wasm_bindgen]
    pub fn set_animation_loop_mode(
        &mut self,
        clip_name: &str,
        loop_mode: &str,
    ) -> Result<(), JsError> {
        let mode = parse_loop_mode(loop_mode)?;
        let repeat_count = self
            .animation
            .state(clip_name)
            .and_then(|state| state.repeat_count);
        self.animation.set_loop(clip_name, mode, repeat_count);
        Ok(())
    }

    #[wasm_bindgen]
    pub fn set_animation_repeat_count(&mut self, clip_name: &str, repeat_count: i32) {
        let mode = self
            .animation
            .state(clip_name)
            .map(|state| state.loop_mode)
            .unwrap_or(LoopMode::Repeat);
        self.animation.set_loop(
            clip_name,
            mode,
            (repeat_count >= 0).then_some(repeat_count as u32),
        );
    }

    #[wasm_bindgen]
    pub fn set_animation_reverse(&mut self, clip_name: &str, reverse: bool) {
        self.animation.set_reverse(clip_name, reverse);
    }

    #[wasm_bindgen]
    pub fn set_animation_blend_mode(
        &mut self,
        clip_name: &str,
        blend_mode: &str,
    ) -> Result<(), JsError> {
        let mode = match blend_mode {
            "replace" => BlendMode::Replace,
            "additive" => BlendMode::Additive,
            _ => {
                return Err(JsError::new(
                    "Animation blend mode must be replace or additive.",
                ))
            }
        };
        self.animation.set_blend_mode(clip_name, mode);
        Ok(())
    }

    #[wasm_bindgen]
    pub fn seek_animation(&mut self, clip_name: &str, time: f32) {
        self.animation.seek(clip_name, time);
    }

    #[wasm_bindgen]
    pub fn set_animation_time_scale(&mut self, time_scale: f32) {
        self.animation.set_time_scale(time_scale);
    }

    #[wasm_bindgen]
    pub fn get_animation_state(&self, clip_name: &str) -> Result<String, JsError> {
        serialize_runtime_json(&self.animation.state(clip_name), "animation state")
    }

    #[wasm_bindgen]
    pub fn get_playing_animations(&self) -> Result<String, JsError> {
        serialize_runtime_json(&self.animation.playing(), "playing animations")
    }

    #[wasm_bindgen]
    pub fn drain_animation_events(&mut self) -> Result<String, JsError> {
        serialize_runtime_json(&self.animation.drain_events(), "animation events")
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
            let _axis = values[index + 1] as u8;
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
    /// Live AU/viseme/direct morph state only — clip playback is host-owned.
    #[wasm_bindgen]
    pub fn evaluate_morph_frame_delta(&self) -> Box<[f32]> {
        let mut writes: HashMap<(u32, u32), f32> = HashMap::new();

        for binding in &self.au_bindings {
            let value = *self.au_values.get(&binding.au_id).unwrap_or(&0.0);
            let balance = self.au_balances.get(&binding.au_id).copied().unwrap_or(0.0);
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

        for (target, value) in &self.direct_morph_values {
            writes.insert(*target, clamp01(*value));
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
    /// flags: bit0 = has_position, bit1 = has_rotation. Composite rotations are
    /// relative to rest, AU-driven translations are added to rest position, and
    /// viseme jaw rotation is applied as an absolute packed frame write.
    #[wasm_bindgen]
    pub fn evaluate_bone_frame_delta(&self) -> Box<[f32]> {
        let mut order: Vec<u32> = Vec::new();
        let mut writes: HashMap<u32, BoneWrite> = HashMap::new();

        let effective_value = |au_id: u32, side: u8| -> f32 {
            let raw = clamp01(*self.au_values.get(&au_id).unwrap_or(&0.0));
            if raw <= 1e-6 {
                return 0.0;
            }
            let balance = self.au_balances.get(&au_id).copied().unwrap_or(0.0);
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

            upsert_bone_write(&mut writes, &mut order, bone_id, None, Some(rotation));
        }

        // AU translations: per-component offsets against the rest position.
        let mut offsets: Vec<(u32, [f32; 3])> = Vec::new();
        for row in &self.translation_rows {
            let entry = if let Some(existing) = offsets
                .iter_mut()
                .find(|(bone_id, _)| *bone_id == row.bone_id)
            {
                existing
            } else {
                offsets.push((row.bone_id, [0.0, 0.0, 0.0]));
                offsets.last_mut().unwrap()
            };
            let value = clamp01(*self.au_values.get(&row.au_id).unwrap_or(&0.0));
            if value <= 1e-6 {
                continue;
            }
            let offset = (value * row.scale).clamp(-1.0, 1.0) * row.max_units;
            entry.1[row.axis.min(2) as usize] = offset;
        }
        for (bone_id, offset) in offsets {
            let rest = self
                .bone_rest_transforms
                .get(&bone_id)
                .map(|rest| rest.position)
                .unwrap_or([0.0, 0.0, 0.0]);
            upsert_bone_write(
                &mut writes,
                &mut order,
                bone_id,
                Some([
                    rest[0] + offset[0],
                    rest[1] + offset[1],
                    rest[2] + offset[2],
                ]),
                None,
            );
        }

        // Viseme-driven jaw rotation. When no viseme is active, emit rest if
        // no composite rotation already owns the jaw so the previous frame
        // cannot leave the Three.js bone open.
        let jaw_amount = self.active_viseme_jaw_amount();
        if let Some(jaw) = &self.jaw_binding {
            let rest = self
                .bone_rest_transforms
                .get(&jaw.bone_id)
                .map(|rest| rest.rotation)
                .unwrap_or([0.0, 0.0, 0.0, 1.0]);
            if jaw_amount > 1e-6 {
                let rotation = multiply_quat(
                    rest,
                    quat_from_channel(
                        jaw.channel,
                        jaw.max_degrees.to_radians() * jaw_amount * jaw.scale,
                    ),
                );
                upsert_bone_write(&mut writes, &mut order, jaw.bone_id, None, Some(rotation));
            } else if writes
                .get(&jaw.bone_id)
                .and_then(|(_, rotation)| *rotation)
                .is_none()
            {
                upsert_bone_write(&mut writes, &mut order, jaw.bone_id, None, Some(rest));
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

    /// Scene extras for live state. Clip-driven scale/visibility/object writes
    /// are owned by the host mixer, so this returns an empty frame.
    #[wasm_bindgen]
    pub fn evaluate_scene_frame(&self) -> Result<String, JsError> {
        serialize_runtime_json(
            &serde_json::json!({
                "boneScales": [],
                "objects": [],
                "meshes": [],
            }),
            "scene frame",
        )
    }

    fn resolve_morph_targets(
        &self,
        morph_name: &str,
        morph_index: Option<i32>,
        mesh_names_json: &str,
    ) -> Vec<(u32, u32)> {
        let Some(model) = &self.model else {
            return Vec::new();
        };
        let explicit_names: Vec<String> = if mesh_names_json.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(mesh_names_json).unwrap_or_default()
        };
        let profile_names = self
            .profile
            .as_ref()
            .and_then(|profile| profile.morph_to_mesh.get("face"))
            .cloned()
            .unwrap_or_default();
        let requested = if !explicit_names.is_empty() {
            explicit_names
        } else if !profile_names.is_empty() {
            profile_names
        } else {
            model.meshes.iter().map(|mesh| mesh.name.clone()).collect()
        };
        let mesh_ids = model
            .meshes
            .iter()
            .filter(|mesh| requested.iter().any(|name| name == &mesh.name))
            .map(|mesh| mesh.id)
            .collect::<Vec<_>>();
        model
            .morph_targets
            .iter()
            .filter(|morph| {
                mesh_ids.contains(&morph.mesh_id)
                    && morph_index.map_or_else(
                        || morph.name == morph_name,
                        |index| morph.host_index == Some(index as i64),
                    )
            })
            .map(|morph| (morph.mesh_id, morph.id))
            .collect()
    }

    fn compile_curves(
        &self,
        clip_name: &str,
        curves: BTreeMap<String, Vec<RuntimeCurvePoint>>,
        options: &ClipBuildOptions,
    ) -> Result<ClipIR, JsError> {
        if clip_name.trim().is_empty() {
            return Err(JsError::new("Clip name cannot be empty."));
        }
        let mesh_names_json = serde_json::to_string(&options.mesh_names).unwrap_or_default();
        let snippet_curves = curves
            .iter()
            .map(|(id, points)| {
                (
                    id.clone(),
                    points
                        .iter()
                        .map(|point| SnippetCurvePoint {
                            time: point.time,
                            intensity: point.intensity,
                        })
                        .collect::<Vec<_>>(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut named_morph_targets = HashMap::new();
        for curve_id in snippet_curves.keys() {
            if curve_id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let targets = self.resolve_morph_targets(curve_id, None, &mesh_names_json);
            if !targets.is_empty() {
                named_morph_targets.insert(curve_id.clone(), targets);
            }
        }
        let au_bindings = self
            .au_bindings
            .iter()
            .map(|binding| SnippetAuMorphBinding {
                au_id: binding.au_id,
                side: binding.side,
                mesh_id: binding.mesh_id,
                morph_target_id: binding.morph_target_id,
                weight: binding.weight,
            })
            .collect::<Vec<_>>();
        let viseme_bindings = self
            .viseme_bindings
            .iter()
            .map(|binding| SnippetVisemeMorphBinding {
                viseme_index: binding.viseme_index,
                mesh_id: binding.mesh_id,
                morph_target_id: binding.morph_target_id,
                weight: binding.weight,
            })
            .collect::<Vec<_>>();
        let mixed_aus = self.mixed_aus.keys().copied().collect::<HashSet<_>>();
        let compile_options = SnippetCompileOptions {
            intensity_scale: options.intensity_scale.unwrap_or(1.0),
            balance: options.balance.unwrap_or(0.0),
            balance_map: options.balance_map.clone(),
            snippet_category: options.snippet_category.clone(),
            auto_viseme_jaw: options.auto_viseme_jaw.unwrap_or(true),
            jaw_scale: options.jaw_scale.unwrap_or(1.0),
        };
        let tracks = compile_snippet_tracks(SnippetCompileInput {
            curves: &snippet_curves,
            au_bindings: &au_bindings,
            viseme_bindings: &viseme_bindings,
            viseme_slot_count: self.viseme_values.len(),
            mix_weights: &self.mix_weights,
            mixed_aus: &mixed_aus,
            composite_axes: &self.composite_axes,
            translation_rows: &self.translation_rows,
            jaw_binding: self.jaw_binding.as_ref(),
            viseme_jaw_amounts: &self.viseme_jaw_amounts,
            bone_rest_transforms: &self.bone_rest_transforms,
            named_morph_targets: &named_morph_targets,
            options: &compile_options,
        });
        clip_from_tracks(clip_name, tracks)
    }

    fn classify_baked_clip(&self, clip: &mut ClipIR) {
        clip.channels = vec![
            ClipChannel {
                id: 1,
                kind: "face".to_string(),
                name: Some("face".to_string()),
            },
            ClipChannel {
                id: 2,
                kind: "body".to_string(),
                name: Some("body".to_string()),
            },
            ClipChannel {
                id: 3,
                kind: "scene".to_string(),
                name: Some("scene".to_string()),
            },
        ];
        let face_bones = self
            .composite_axes
            .iter()
            .map(|axis| axis.bone_id)
            .chain(self.translation_rows.iter().map(|row| row.bone_id))
            .chain(self.jaw_binding.iter().map(|jaw| jaw.bone_id))
            .collect::<HashSet<_>>();
        let object_data = self
            .model
            .as_ref()
            .map(|model| {
                model
                    .objects
                    .iter()
                    .map(|object| (object.id, object))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        let bone_names = self
            .model
            .as_ref()
            .map(|model| {
                model
                    .bones
                    .iter()
                    .map(|bone| (bone.id, bone.name.to_ascii_lowercase()))
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        for track in &mut clip.tracks {
            let kind = track
                .target
                .get("kind")
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            track.channel_id = match kind {
                "morphTarget" => 1,
                "boneTransform" => {
                    let id = track
                        .target
                        .get("boneId")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or_default() as u32;
                    let name = bone_names.get(&id).map(String::as_str).unwrap_or_default();
                    if face_bones.contains(&id) || is_face_transform_name(name) {
                        1
                    } else {
                        2
                    }
                }
                "objectTransform" => {
                    let id = track
                        .target
                        .get("objectId")
                        .and_then(serde_json::Value::as_u64)
                        .unwrap_or_default() as u32;
                    let object = object_data.get(&id);
                    let name = object.map(|value| value.name.as_str()).unwrap_or_default();
                    if object.is_some_and(|value| value.is_camera) || is_scene_transform_name(name)
                    {
                        3
                    } else if object.is_some_and(|value| value.is_bone)
                        && is_face_transform_name(name)
                    {
                        1
                    } else {
                        2
                    }
                }
                "meshVisibility" => 2,
                _ => 3,
            };
        }
    }

    fn compile_typed_channels(
        &self,
        clip_name: &str,
        channels: Vec<TypedChannel>,
        options: &ClipBuildOptions,
    ) -> Result<ClipIR, JsError> {
        if clip_name.trim().is_empty() {
            return Err(JsError::new("Clip name cannot be empty."));
        }
        let mut tracks = Vec::new();
        let mut next_track_id = 1u32;
        let global_scale = options.intensity_scale.unwrap_or(1.0);

        // Batch AU/viseme channels into one concrete ClipIR expansion so composite
        // bones and jaw tracks are emitted once.
        let mut semantic_curves: BTreeMap<String, Vec<RuntimeCurvePoint>> = BTreeMap::new();
        let mut balance_map = options.balance_map.clone();
        let mut has_viseme = false;
        let mut remaining = Vec::new();
        for channel in channels {
            if channel.keyframes.is_empty() {
                continue;
            }
            let target_type = channel
                .target
                .get("type")
                .or_else(|| channel.target.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            let scale = global_scale * channel.intensity_scale.unwrap_or(1.0);
            match target_type {
                "au" | "lipSync" => {
                    let Some(id) = channel.target.get("id").and_then(serde_json::Value::as_u64)
                    else {
                        continue;
                    };
                    if let Some(balance) = channel
                        .target
                        .get("balance")
                        .and_then(serde_json::Value::as_f64)
                        .map(|value| value as f32)
                    {
                        balance_map.insert(id.to_string(), balance);
                    }
                    semantic_curves.insert(
                        id.to_string(),
                        channel
                            .keyframes
                            .iter()
                            .map(|point| RuntimeCurvePoint {
                                time: point.time,
                                intensity: point.intensity * (scale / global_scale.max(1e-9)),
                                inherit: point.inherit,
                            })
                            .collect(),
                    );
                }
                "viseme" => {
                    let Some(id) = channel.target.get("id").and_then(serde_json::Value::as_u64)
                    else {
                        continue;
                    };
                    has_viseme = true;
                    semantic_curves.insert(
                        id.to_string(),
                        channel
                            .keyframes
                            .iter()
                            .map(|point| RuntimeCurvePoint {
                                time: point.time,
                                intensity: point.intensity * (scale / global_scale.max(1e-9)),
                                inherit: point.inherit,
                            })
                            .collect(),
                    );
                }
                _ => remaining.push((channel, scale)),
            }
        }
        if !semantic_curves.is_empty() {
            let mut semantic_options = options.clone();
            semantic_options.balance_map = balance_map;
            if has_viseme {
                semantic_options.snippet_category = Some("visemeSnippet".to_string());
            }
            let compiled = self.compile_curves(clip_name, semantic_curves, &semantic_options)?;
            for mut track in compiled.tracks {
                track.id = next_track_id;
                next_track_id += 1;
                tracks.push(track);
            }
        }

        for (channel, scale) in remaining {
            let target_type = channel
                .target
                .get("type")
                .or_else(|| channel.target.get("kind"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or_default();
            match target_type {
                "morph" => {
                    let mesh_names = channel
                        .target
                        .get("meshNames")
                        .cloned()
                        .unwrap_or_else(|| serde_json::json!(options.mesh_names));
                    let mesh_names_json = serde_json::to_string(&mesh_names).unwrap_or_default();
                    let targets = if let Some(name) =
                        channel.target.get("id").and_then(serde_json::Value::as_str)
                    {
                        self.resolve_morph_targets(name, None, &mesh_names_json)
                    } else if let Some(index) =
                        channel.target.get("id").and_then(serde_json::Value::as_i64)
                    {
                        self.resolve_morph_targets("", Some(index as i32), &mesh_names_json)
                    } else {
                        Vec::new()
                    };
                    for (mesh_id, morph_target_id) in targets {
                        tracks.push(scalar_track(
                            next_track_id,
                            serde_json::json!({
                                "kind": "morphTarget",
                                "meshId": mesh_id,
                                "morphTargetId": morph_target_id,
                            }),
                            &channel.keyframes,
                            scale,
                        ));
                        next_track_id += 1;
                    }
                }
                "bone" => {
                    let Some(node_key) =
                        channel.target.get("id").and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let Some(bone_id) = self.resolve_bone_id(node_key) else {
                        continue;
                    };
                    let Some(transform_channel) = channel
                        .target
                        .get("channel")
                        .and_then(serde_json::Value::as_str)
                    else {
                        continue;
                    };
                    let direction = channel
                        .target
                        .get("scale")
                        .and_then(serde_json::Value::as_f64)
                        .unwrap_or(1.0) as f32;
                    let rest =
                        self.bone_rest_transforms
                            .get(&bone_id)
                            .copied()
                            .unwrap_or(RestTransform {
                                position: [0.0, 0.0, 0.0],
                                rotation: [0.0, 0.0, 0.0, 1.0],
                            });
                    if matches!(transform_channel, "rx" | "ry" | "rz") {
                        let max_degrees = channel
                            .target
                            .get("maxDegrees")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(60.0) as f32;
                        let channel_id = match transform_channel {
                            "rx" => 0,
                            "ry" => 1,
                            _ => 2,
                        };
                        let values = channel
                            .keyframes
                            .iter()
                            .flat_map(|point| {
                                let amount = point.intensity as f32 * scale as f32;
                                multiply_quat(
                                    rest.rotation,
                                    quat_from_channel(
                                        channel_id,
                                        max_degrees.to_radians() * amount * direction,
                                    ),
                                )
                            })
                            .map(f64::from)
                            .collect();
                        tracks.push(vector_track(
                            next_track_id,
                            serde_json::json!({
                                "kind": "boneTransform",
                                "boneId": bone_id,
                                "property": "rotation",
                            }),
                            "quat",
                            &channel.keyframes,
                            values,
                        ));
                        next_track_id += 1;
                    } else if matches!(transform_channel, "tx" | "ty" | "tz") {
                        let max_units = channel
                            .target
                            .get("maxUnits")
                            .and_then(serde_json::Value::as_f64)
                            .unwrap_or(1.0) as f32;
                        let axis = match transform_channel {
                            "tx" => 0,
                            "ty" => 1,
                            _ => 2,
                        };
                        let values = channel
                            .keyframes
                            .iter()
                            .flat_map(|point| {
                                let mut value = rest.position;
                                value[axis] +=
                                    point.intensity as f32 * scale as f32 * max_units * direction;
                                value
                            })
                            .map(f64::from)
                            .collect();
                        tracks.push(vector_track(
                            next_track_id,
                            serde_json::json!({
                                "kind": "boneTransform",
                                "boneId": bone_id,
                                "property": "position",
                            }),
                            "vec3",
                            &channel.keyframes,
                            values,
                        ));
                        next_track_id += 1;
                    }
                }
                _ => {}
            }
        }
        clip_from_tracks(clip_name, tracks)
    }

    fn resolve_bone_id(&self, node_key: &str) -> Option<u32> {
        let model = self.model.as_ref()?;
        let profile = self.profile.as_ref()?;
        let configured = profile
            .bone_nodes
            .get(node_key)
            .map(String::as_str)
            .unwrap_or(node_key);
        let prefix = profile.bone_prefix.as_deref().unwrap_or_default();
        let suffix = profile.bone_suffix.as_deref().unwrap_or_default();
        let prefixed = if !prefix.is_empty() && !configured.starts_with(prefix) {
            format!("{prefix}{configured}")
        } else {
            configured.to_string()
        };
        let full = if !suffix.is_empty() && !prefixed.ends_with(suffix) {
            format!("{prefixed}{suffix}")
        } else {
            prefixed
        };
        model
            .bones
            .iter()
            .find(|bone| bone.name == node_key || bone.name == configured || bone.name == full)
            .map(|bone| bone.id)
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

fn parse_runtime_json<T>(json: &str, label: &str) -> Result<T, JsError>
where
    T: serde::de::DeserializeOwned + Default,
{
    if json.trim().is_empty() {
        return Ok(T::default());
    }
    serde_json::from_str(json)
        .map_err(|error| JsError::new(&format!("Invalid {label} JSON: {error}")))
}

fn serialize_runtime_json<T>(value: &T, label: &str) -> Result<String, JsError>
where
    T: serde::Serialize,
{
    serde_json::to_string(value)
        .map_err(|error| JsError::new(&format!("Failed to serialize {label}: {error}")))
}

fn parse_loop_mode(value: &str) -> Result<LoopMode, JsError> {
    match value {
        "once" => Ok(LoopMode::Once),
        "repeat" => Ok(LoopMode::Repeat),
        "pingpong" => Ok(LoopMode::Pingpong),
        _ => Err(JsError::new(
            "Animation loop mode must be once, repeat, or pingpong.",
        )),
    }
}

fn scalar_track(
    id: u32,
    target: serde_json::Value,
    points: &[RuntimeCurvePoint],
    scale: f64,
) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target,
        value_type: "scalar".to_string(),
        times: points.iter().map(|point| point.time).collect(),
        values: points
            .iter()
            .map(|point| (point.intensity * scale).clamp(0.0, 2.0))
            .collect(),
        interpolation: Some("linear".to_string()),
        inherit_start: points.first().is_some_and(|point| point.inherit),
        source_name: None,
    }
}

fn vector_track(
    id: u32,
    target: serde_json::Value,
    value_type: &str,
    points: &[RuntimeCurvePoint],
    values: Vec<f64>,
) -> ClipTrackIR {
    ClipTrackIR {
        id,
        channel_id: 1,
        target,
        value_type: value_type.to_string(),
        times: points.iter().map(|point| point.time).collect(),
        values,
        interpolation: Some("linear".to_string()),
        inherit_start: points.first().is_some_and(|point| point.inherit),
        source_name: None,
    }
}

fn clip_from_tracks(clip_name: &str, tracks: Vec<ClipTrackIR>) -> Result<ClipIR, JsError> {
    if tracks.is_empty() {
        return Err(JsError::new(&format!(
            "No runtime tracks could be resolved for clip \"{clip_name}\"."
        )));
    }
    let duration = tracks
        .iter()
        .flat_map(|track| track.times.iter())
        .copied()
        .fold(0.0f64, f64::max);
    Ok(ClipIR {
        id: None,
        name: clip_name.to_string(),
        duration_seconds: duration,
        channels: vec![ClipChannel {
            id: 1,
            kind: "face".to_string(),
            name: Some("runtime".to_string()),
        }],
        tracks,
        metadata: None,
    })
}

fn is_face_transform_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let body = [
        "root", "armature", "hip", "pelvis", "spine", "waist", "chest", "torso", "shoulder", "arm",
        "forearm", "hand", "finger", "leg", "thigh", "calf", "knee", "foot", "toe", "tail", "wing",
        "fin", "body", "abdomen", "clavicle",
    ];
    if body.iter().any(|token| name.contains(token)) || is_scene_transform_name(&name) {
        return false;
    }
    [
        "head", "neck", "jaw", "eye", "brow", "lid", "mouth", "lip", "face", "cheek", "nose",
        "tongue", "teeth",
    ]
    .iter()
    .any(|token| name.contains(token))
}

fn is_scene_transform_name(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "camera", "cam", "scene", "world", "global", "origin", "pivot", "cube",
    ]
    .iter()
    .any(|token| name.contains(token))
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
            0.0, 20.0, 200.0, 1.0, 0.0, 20.0, 201.0, 0.5, 1.0, 20.0, 200.0, 0.25,
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
            1.0, 1.0, 1.0, 2.0, 2.0, 0.0, 0.0, 0.0, // value rows [au, group, side]
            30.0, 0.0, 0.0, // negative
            31.0, 1.0, 0.0, // positive
            // binding rows [au, group, side, channel, scale, max_degrees]
            30.0, 0.0, 0.0, 1.0, -1.0, 20.0, 31.0, 1.0, 0.0, 1.0, 1.0, 20.0,
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
            51.0, 2.0, 0.0, 51.0, 2.0, 0.0, 1.0, 1.0, 30.0,
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
    fn inactive_controls_emit_rest_transforms_without_composite_axes() {
        let mut core = RuntimeCore::new(1);
        core.load_bone_rest_transforms(&[
            2.0, 1.0, 2.0, 3.0, 0.0, 0.0, 0.0, 1.0, // translated bone
            3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // jaw
        ]);
        core.load_bone_translations(&[40.0, 2.0, 1.0, 1.0, 0.5]);
        core.load_jaw_binding(&[3.0, 0.0, 1.0, 30.0]);
        core.load_viseme_jaw_amounts(&[1.0]);

        core.set_au(40, 1.0, 0.0);
        core.set_viseme(0, 1.0);
        let active = core.evaluate_bone_frame_delta();
        assert_eq!(active.len(), 2 * PACKED_BONE_FRAME_DELTA_STRIDE as usize);

        core.set_au(40, 0.0, 0.0);
        core.set_viseme(0, 0.0);
        let neutral = core.evaluate_bone_frame_delta();
        assert_eq!(neutral.len(), 2 * PACKED_BONE_FRAME_DELTA_STRIDE as usize);

        assert_eq!(neutral[0], 2.0);
        assert!((neutral[1] - 1.0).abs() < 1e-6);
        assert!((neutral[2] - 2.0).abs() < 1e-6);
        assert!((neutral[3] - 3.0).abs() < 1e-6);
        assert_eq!(neutral[8], FLAG_HAS_POSITION as f32);

        assert_eq!(neutral[9], 3.0);
        assert!((neutral[13]).abs() < 1e-6);
        assert!((neutral[14]).abs() < 1e-6);
        assert!((neutral[15]).abs() < 1e-6);
        assert!((neutral[16] - 1.0).abs() < 1e-6);
        assert_eq!(neutral[17], FLAG_HAS_ROTATION as f32);
    }

    #[test]
    fn configures_from_embedded_cc4_preset() {
        let model = r#"{
            "meshes": [{ "id": 1, "name": "CC_Base_Body", "morphTargetIds": [] }],
            "morphTargets": [],
            "bones": [{ "id": 1, "name": "CC_Base_JawRoot" }]
        }"#;
        let mut core = RuntimeCore::new(0);
        // Override empty is fine; embedded CC4 must merge + compile without error.
        core.configure_with_preset("cc4", "", model).unwrap();
        assert!(core.viseme_slot_index("aa") >= -1);
    }

    #[test]
    fn configures_from_registered_fish_preset() {
        let model = r#"{
            "meshes": [{ "id": 1, "name": "EYES_0", "morphTargetIds": [] }],
            "morphTargets": [],
            "bones": [
                {
                    "id": 4,
                    "name": "Bone.001_Armature",
                    "restTransform": {
                        "position": { "x": 0, "y": 0, "z": 0 },
                        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 }
                    }
                }
            ]
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure_with_preset("fish", "", model).unwrap();
        core.set_au(51, 0.5, 0.0);
        assert!(!core.evaluate_bone_frame_delta().is_empty());
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
    fn resolved_profile_is_not_merged_with_an_embedded_preset() {
        let profile = r#"{
            "auToMorphs": {
                "900": { "left": [], "right": [], "center": ["OnlyExact"] }
            },
            "morphToMesh": { "face": ["ExactFace"] }
        }"#;
        let model = r#"{
            "meshes": [{ "id": 1, "name": "ExactFace", "morphTargetIds": [7, 8] }],
            "morphTargets": [
                { "id": 7, "meshId": 1, "name": "OnlyExact", "hostIndex": 0 },
                { "id": 8, "meshId": 1, "name": "Mouth_Smile_L", "hostIndex": 1 }
            ],
            "bones": []
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(profile, model).unwrap();
        core.set_au(900, 0.75, 0.0);
        core.set_au(12, 1.0, 0.0);

        let rows = unpack_rows(&core.evaluate_morph_frame_delta());
        assert_eq!(rows, vec![(1, 7, 0.75)]);
    }

    #[test]
    fn resolved_profile_with_stale_bindings_does_not_block_character_loading() {
        let profile = r#"{
            "auToMorphs": {
                "900": { "left": [], "right": [], "center": ["MissingMorph"] }
            },
            "morphToMesh": { "face": ["MissingMesh"] }
        }"#;
        let model = r#"{
            "meshes": [{ "id": 1, "name": "ActualMesh", "morphTargetIds": [] }],
            "morphTargets": [],
            "bones": []
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(profile, model).unwrap();
        core.set_au(900, 1.0, 0.0);
        assert!(core.evaluate_morph_frame_delta().is_empty());
    }

    #[test]
    fn resolved_profile_rejects_incomplete_or_incompatible_profiles() {
        let empty_model = r#"{"meshes":[],"morphTargets":[],"bones":[]}"#;
        let incomplete =
            compile_resolved_profile_tables(r#"{"name":"metadata only"}"#, empty_model)
                .unwrap_err();
        assert!(incomplete.contains("Resolved profile is incomplete"));

        let incompatible = compile_resolved_profile_tables(
            r#"{
                    "auToBones": {
                        "42": [{
                            "node": "MISSING",
                            "channel": "rx",
                            "scale": 1,
                            "maxDegrees": 30
                        }]
                    }
                }"#,
            empty_model,
        )
        .unwrap_err();
        assert!(incompatible.contains("Resolved profile is incompatible"));
    }

    #[test]
    fn transition_au_applies_instantly_without_rust_lerp() {
        let mut core = RuntimeCore::new(0);
        core.transition_au(12, 1.0, 200.0, f32::NAN);
        assert_eq!(core.active_transition_count(), 0);
        assert!((core.get_au(12) - 1.0).abs() < 1e-6);
        assert_eq!(core.update(0.1), 0);
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
