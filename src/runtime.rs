use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

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
    CurvePoint as SnippetCurvePoint, CurveTarget, SnippetCompileInput, SnippetCompileOptions,
    SnippetCurve, VisemeMorphBinding as SnippetVisemeMorphBinding,
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
    mix_weights: HashMap<u32, f32>,
    face_curves: BTreeMap<String, Vec<RuntimeCurvePoint>>,
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

/// Loom3 parity: `config.compositeRotations || CC4_COMPOSITE_ROTATIONS`.
///
/// Saved character profiles carry `auToBones` rotation bindings but rarely
/// embed a composite rotation table. Loom3 fell back to the built-in CC4
/// composites; without the same fallback every such profile loses AU bone
/// rotations in live frames and in compiled snippet clips (only morph tracks
/// come out of snippet-to-clip). Composite nodes that don't resolve against
/// the model are skipped during table compilation, so this is safe for
/// non-CC4 rigs. Explicit arrays, including [], never use this fallback.
fn apply_composite_rotation_fallback(profile: &mut ProfileData) {
    if !profile.composite_rotations.is_unspecified() {
        return;
    }
    if let Ok(cc4) = presets::load_profile("cc4") {
        profile.composite_rotations = cc4.composite_rotations.clone();
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
    viseme_tongue_targets: Vec<HashMap<u32, f32>>,
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
    procedural_bone_flags: HashMap<u32, u32>,
    procedural_morph_targets: BTreeSet<(u32, u32)>,
    body_controls_json: String,
    body_control_au_ids: BTreeSet<u32>,
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
            viseme_tongue_targets: Vec::new(),
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
            procedural_bone_flags: HashMap::new(),
            procedural_morph_targets: BTreeSet::new(),
            body_controls_json: "[]".into(),
            body_control_au_ids: BTreeSet::new(),
        }
    }

    /// Configure the core from the profile and model descriptor JSON hosts
    /// already have. All binding compilation (mesh/morph/bone name resolution,
    /// composite axes, translations, jaw, viseme slots, mix defaults,
    /// continuum pairs) happens here, inside the core.
    #[wasm_bindgen]
    pub fn configure(&mut self, profile_json: &str, model_json: &str) -> Result<(), JsError> {
        let mut profile: ProfileData = deserialize_json(profile_json, "Invalid profile JSON")
            .map_err(|err| JsError::new(&err))?;
        apply_composite_rotation_fallback(&mut profile);
        let model: ModelData = deserialize_json(model_json, "Invalid model descriptor JSON")
            .map_err(|err| JsError::new(&err))?;
        let tables = compile_tables(&profile, &model);
        self.apply_profile_model(profile, model, tables);
        Ok(())
    }

    /// Configure from a resolved profile without applying an embedded preset.
    ///
    /// Empty profiles and mappings that do not match the current model are
    /// non-fatal. Static imports can render before authoring any bindings,
    /// without silently substituting an embedded preset.
    #[wasm_bindgen]
    pub fn configure_with_profile(
        &mut self,
        profile_json: &str,
        model_json: &str,
    ) -> Result<(), JsError> {
        let mut profile: ProfileData =
            deserialize_json(profile_json, "Invalid resolved profile JSON")
                .map_err(|err| JsError::new(&err))?;
        if profile.has_runtime_mappings() {
            apply_composite_rotation_fallback(&mut profile);
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
        let mut profile = extend_preset_with_profile(base, extension);
        apply_composite_rotation_fallback(&mut profile);
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
        self.reset_procedural_frame_tracking();
        self.body_controls_json = crate::body_controls::resolve(&profile, Some(&model)).to_string();
        self.body_control_au_ids = profile.body_controls.values()
            .flat_map(|control| std::iter::once(control.au_id).chain(control.negative_au_id))
            .collect();
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
        self.viseme_tongue_targets = tables.viseme_tongue_targets;
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

    /// Stored live AU balance in [-1, 1], or neutral zero when unset or cleared.
    #[wasm_bindgen]
    pub fn get_au_balance(&self, id: u32) -> f32 {
        *self.au_balances.get(&id).unwrap_or(&0.0)
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

    /// Profile-derived motions and resolved model support for prompt/pose editors.
    #[wasm_bindgen]
    pub fn get_semantic_pose_catalog_json(&self) -> String {
        self.profile.as_ref().map(|profile| crate::semantic_pose::catalog(profile,self.model.as_ref()).to_string()).unwrap_or_else(||"[]".into())
    }

    /// Full Body property writes, including neutral reference values. Hosts use
    /// this once when an explicit pose replaces direct legacy bone edits.
    #[wasm_bindgen]
    pub fn evaluate_semantic_body_bone_frame(&self)->Box<[f32]>{
        let (Some(profile),Some(model))=(&self.profile,&self.model) else{return Vec::new().into_boxed_slice();};
        let resolver=crate::profile::NameResolver::new(profile,model);
        let mut properties:HashMap<u32,u32>=HashMap::new();
        for id in &self.body_control_au_ids {
            for binding in profile.au_to_bones.get(&id.to_string()).into_iter().flatten(){
                if let Some(bone)=resolver.resolve_bone(model,profile,&binding.node){
                    let flag=match binding.channel.as_str(){"rx"|"ry"|"rz"=>FLAG_HAS_ROTATION,"tx"|"ty"|"tz"=>FLAG_HAS_POSITION,_=>0};
                    *properties.entry(bone.id).or_default()|=flag;
                }
            }
        }
        let mut result=Vec::new();
        for row in self.evaluate_bone_frame_delta().chunks_exact(9){
            let flags=(row[8] as u32)&properties.get(&(row[0] as u32)).copied().unwrap_or(0);
            if flags!=0{result.extend_from_slice(&row[..8]);result.push(flags as f32);}
        }
        result.into_boxed_slice()
    }

    /// Captures manual semantic state; does not infer actions from a mixer pose.
    #[wasm_bindgen]
    pub fn capture_semantic_pose_json(&self) -> String {
        use crate::semantic_pose::{Pose,PoseControl,Channel};
        let controls=self.profile.as_ref().map(|profile| profile.body_controls.iter().map(|(id,control)| {
            let capture=|au| Channel{intensity:self.get_au(au),balance:self.get_au_balance(au),
                morph_strength:Some(*self.mix_weights.get(&au).unwrap_or(&1.0))};
            PoseControl{control_id:id.clone(),positive:Some(capture(control.au_id)),
                negative:control.negative_au_id.filter(|au|*au!=control.au_id).map(capture)}
        }).collect()).unwrap_or_default();
        serde_json::to_string(&Pose{version:1,controls}).unwrap()
    }

    /// Validate and fill optional settings without changing runtime or renderer state.
    #[wasm_bindgen]
    pub fn validate_semantic_pose_json(&self, json:&str) -> Result<String,JsError> {
        let mut pose:crate::semantic_pose::Pose=deserialize_json(json,"Invalid semantic pose")
            .map_err(|error|JsError::new(&error))?;
        let profile=self.profile.as_ref().ok_or_else(||JsError::new("Runtime is not configured"))?;
        let actions=crate::semantic_pose::validate_pose(profile,&pose).map_err(|error|JsError::new(&error))?;
        for row in &mut pose.controls {
            let control=&profile.body_controls[&row.control_id];
            if row.positive.is_some() {row.positive=Some(actions[&control.au_id].clone());}
            if row.negative.is_some() { row.negative=Some(actions[&control.negative_au_id.unwrap()].clone()); }
        }
        serialize_runtime_json(&pose,"semantic pose")
    }

    /// Validate every channel before replacing Body state. Other FACS state remains.
    #[wasm_bindgen]
    pub fn apply_semantic_pose_json(&mut self, json:&str) -> Result<(),JsError> {
        let pose:crate::semantic_pose::Pose=deserialize_json(json,"Invalid semantic pose")
            .map_err(|error|JsError::new(&error))?;
        let profile=self.profile.as_ref().ok_or_else(||JsError::new("Runtime is not configured"))?;
        let actions=crate::semantic_pose::validate_pose(profile,&pose).map_err(|error|JsError::new(&error))?;
        let defaults:Vec<_>=self.body_control_au_ids.iter().map(|id|(*id,profile.au_mix_defaults.get(&id.to_string()).copied().unwrap_or(1.) as f32)).collect();
        // A legacy/raw pose may have left direct overrides on these destinations.
        // Release exact resolved IDs only after the entire new pose validates.
        let managed_targets:HashSet<_>=self.au_bindings.iter()
            .filter(|binding|self.body_control_au_ids.contains(&binding.au_id))
            .map(|binding|(binding.mesh_id,binding.morph_target_id)).collect();
        self.direct_morph_values.retain(|target,_|!managed_targets.contains(target));
        self.reset_body_controls();
        for (id,weight) in defaults {self.mix_weights.insert(id,weight);}
        for (id,value) in actions { self.set_au(id,value.intensity,value.balance);self.set_au_mix_weight(id,value.morph_strength.unwrap()); }
        Ok(())
    }

    /// Compile semantic motions and optional facial curves together without changing live state.
    #[wasm_bindgen]
    pub fn build_semantic_clip(&mut self,name:&str,json:&str,options_json:&str)->Result<String,JsError>{
        let clip=self.compile_semantic_animation(name,json,options_json)?;
        let result=serialize_runtime_json(&clip,"semantic clip")?;
        self.animation.insert_clip(clip,"snippet").map_err(|error|JsError::new(&error))?;
        Ok(result)
    }

    /// Compile and validate without registering a clip or changing live controls.
    #[wasm_bindgen]
    pub fn validate_semantic_animation_json(&self,json:&str,options_json:&str)->Result<(),JsError>{
        self.compile_semantic_animation("semantic-validation",json,options_json).map(|_|())
    }

    fn compile_semantic_animation(&self,name:&str,json:&str,options_json:&str)->Result<ClipIR,JsError>{
        let animation:crate::semantic_pose::Animation=deserialize_json(json,"Invalid semantic animation")
            .map_err(|error|JsError::new(&error))?;
        let profile=self.profile.as_ref().ok_or_else(||JsError::new("Runtime is not configured"))?;
        let tracks=crate::semantic_pose::validate_animation(profile,self.model.as_ref(),&animation)
            .map_err(|error|JsError::new(&error))?;
        let mut options:ClipBuildOptions=parse_runtime_json(options_json,"semantic clip options")?;
        let mut curves=std::mem::take(&mut options.face_curves);
        for (key,points) in &curves {
            let id=key.parse::<u32>().map_err(|_|JsError::new("Facial curves must use numeric AU IDs"))?;
            if self.body_control_au_ids.contains(&id) {return Err(JsError::new("Body actions must use semantic tracks"));}
            if !profile.au_info.contains_key(key) && !profile.au_to_morphs.contains_key(key) && !profile.au_to_bones.contains_key(key) {return Err(JsError::new("Unknown facial action"));}
            if points.is_empty()||points.iter().any(|p|!p.time.is_finite()||p.time<0.||p.time>animation.duration_seconds||!p.intensity.is_finite()||p.intensity<0.||p.intensity>1.)||points.windows(2).any(|p|p[0].time>=p[1].time) {return Err(JsError::new("Invalid facial curve"));}
        }
        options.snippet_category=None;
        for (id,value,points) in tracks {
            options.balance_map.insert(id.to_string(),value.balance);
            options.mix_weights.insert(id,value.morph_strength.unwrap());
            curves.insert(id.to_string(),points.into_iter().map(|p|RuntimeCurvePoint{time:p.time,intensity:p.intensity as f64,inherit:false}).collect());
        }
        let mut clip=self.compile_curves(name,curves,&options)?;
        clip.tracks=crate::snippet_compile::merge_semantic_morph_tracks(clip.tracks).map_err(|error|JsError::new(&error))?;
        clip.duration_seconds=animation.duration_seconds;
        Ok(clip)
    }

    /// Resolved Body descriptors for the configured profile/model. Model
    /// inspection and descriptor resolution are cached until reconfiguration.
    #[wasm_bindgen]
    pub fn get_body_controls_json(&self) -> String {
        self.body_controls_json.clone()
    }

    /// Clear each unique configured Body action and bilateral balance together.
    /// Shared facial aliases are Body actions too. Preserve other actions,
    /// visemes, direct morph overrides, and authored/current morph mix weights.
    #[wasm_bindgen]
    pub fn reset_body_controls(&mut self) {
        for id in &self.body_control_au_ids {
            self.au_values.remove(id);
            self.au_balances.remove(id);
        }
    }

    /// Forget ownership when renderer bindings are discarded. Before replacing
    /// bindings, apply release_procedural_morph_frame through the old IDs.
    /// Normal clear/reset deliberately retain tracking for the next frame.
    #[wasm_bindgen]
    pub fn reset_procedural_frame_tracking(&mut self) {
        self.procedural_bone_flags.clear();
        self.procedural_morph_targets.clear();
    }

    /// Release owned morphs through the old renderer binding IDs before rebind.
    #[wasm_bindgen]
    pub fn release_procedural_morph_frame(&mut self) -> Box<[f32]> {
        let mut out = Vec::with_capacity(self.procedural_morph_targets.len() * 4);
        for (mesh_id, target_id) in &self.procedural_morph_targets {
            out.extend_from_slice(&[*mesh_id as f32, *target_id as f32, 0.0, 0.0]);
        }
        self.reset_procedural_frame_tracking();
        out.into_boxed_slice()
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

    /// Release a direct morph override so AU/viseme/mixer ownership can resume.
    /// A deliberate `set_morph(..., 0, ...)` still owns and masks the target;
    /// preview cleanup must release instead of installing a permanent zero.
    /// Target selection matches `set_morph`; returns overrides actually removed.
    #[wasm_bindgen]
    pub fn release_morph(&mut self, morph_name: &str, mesh_names_json: &str) -> u32 {
        let targets = self.resolve_morph_targets(morph_name, None, mesh_names_json);
        targets.iter().filter(|target| self.direct_morph_values.remove(target).is_some()).count() as u32
    }

    /// Index counterpart to `release_morph`, with `set_morph_index` selection.
    #[wasm_bindgen]
    pub fn release_morph_index(&mut self, morph_index: i32, mesh_names_json: &str) -> u32 {
        let targets = self.resolve_morph_targets("", Some(morph_index), mesh_names_json);
        targets.iter().filter(|target| self.direct_morph_values.remove(target).is_some()).count() as u32
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
        let mut clip: ClipIR = deserialize_json(clip_json, "Invalid animation clip JSON")
            .map_err(|error| JsError::new(&error))?;
        if source == "baked" {
            self.classify_baked_clip(&mut clip);
        }
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
        if let Some(easing) = params.get("easing").and_then(serde_json::Value::as_str) {
            self.set_animation_easing(clip_name, easing)?;
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
    pub fn set_animation_easing(
        &mut self,
        clip_name: &str,
        easing: &str,
    ) -> Result<(), JsError> {
        match easing {
            "linear" | "easeIn" | "easeOut" | "easeInOut" | "easeInOutCubic" => {
                self.animation.set_easing(clip_name, easing);
                Ok(())
            }
            _ => Err(JsError::new(
                "Animation easing must be linear, easeIn, easeOut, easeInOut, or easeInOutCubic.",
            )),
        }
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
        self.morph_frame_writes(false)
    }

    /// Same rows as `evaluate_morph_frame_delta`, but only channels with a
    /// non-zero live value or an explicit direct override (including zero).
    /// Hosts re-apply this after mixer playback so live
    /// AU/viseme state wins over clip tracks (Loom3 parity) without resetting
    /// channels the mixer owns.
    #[wasm_bindgen]
    pub fn evaluate_active_morph_frame(&self) -> Box<[f32]> {
        self.morph_frame_writes(true)
    }

    /// Emit active morphs plus one neutral release for previously owned
    /// targets. Direct overrides, including explicit zero, retain ownership.
    /// Untouched targets are omitted so constant mixer tracks keep their pose.
    #[wasm_bindgen]
    pub fn evaluate_procedural_morph_frame(&mut self) -> Box<[f32]> {
        let dense = self.morph_frame_writes(false);
        let mut previous = std::mem::take(&mut self.procedural_morph_targets);
        let mut out = Vec::new();
        for row in dense.chunks_exact(PACKED_MORPH_FRAME_DELTA_STRIDE as usize) {
            let target = (row[0] as u32, row[1] as u32);
            let active = row[2] > 1e-6 || self.direct_morph_values.contains_key(&target);
            let was_owned = previous.remove(&target);
            if active { self.procedural_morph_targets.insert(target); }
            if active || was_owned { out.extend_from_slice(row); }
        }
        // Direct-only targets vanish from dense evaluation when cleared.
        for (mesh_id, target_id) in previous {
            out.extend_from_slice(&[mesh_id as f32, target_id as f32, 0.0, 0.0]);
        }
        out.into_boxed_slice()
    }

    fn morph_frame_writes(&self, active_only: bool) -> Box<[f32]> {
        let mut writes: BTreeMap<(u32, u32), f32> = BTreeMap::new();

        for binding in &self.au_bindings {
            let value = *self.au_values.get(&binding.au_id).unwrap_or(&0.0);
            let balance = self.au_balances.get(&binding.au_id).copied().unwrap_or(0.0);
            let mix_weight = if self.mixed_aus.contains_key(&binding.au_id) {
                *self.mix_weights.get(&binding.au_id).unwrap_or(&1.0)
            } else {
                1.0
            };
            let manual_base = clamp01(value) * clamp01(mix_weight);
            let (left, right) = bilateral_values(manual_base, balance);
            let manual_side_value = match binding.side {
                SIDE_LEFT => left,
                SIDE_RIGHT => right,
                SIDE_CENTER => manual_base,
                _ => manual_base,
            };
            let side_value = manual_side_value.max(self.active_viseme_au_amount(binding.au_id));
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
            if active_only && value <= 1e-6
                && !self.direct_morph_values.contains_key(&(mesh_id, morph_target_id)) {
                continue;
            }
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
        self.bone_frame_writes(false)
    }

    /// Same rows as `evaluate_bone_frame_delta`, but only bones an active AU,
    /// translation, or viseme jaw value is currently rotating or moving.
    /// Neutral bones are omitted (no rest reset), so hosts can re-apply this
    /// after mixer playback without freezing clip-driven bones (Loom3 parity).
    #[wasm_bindgen]
    pub fn evaluate_active_bone_frame(&self) -> Box<[f32]> {
        self.bone_frame_writes(true)
    }

    /// Emit only currently/previously owned bone properties. Position and
    /// rotation ownership are separate; inactive properties release once.
    #[wasm_bindgen]
    pub fn evaluate_procedural_bone_frame(&mut self) -> Box<[f32]> {
        let (frame, active) = self.bone_frame_writes_tracked(false, Some(&self.procedural_bone_flags));
        self.procedural_bone_flags = active;
        frame
    }

    fn bone_frame_writes(&self, active_only: bool) -> Box<[f32]> {
        self.bone_frame_writes_tracked(active_only, None).0
    }

    fn bone_frame_writes_tracked(&self, active_only: bool, previous: Option<&HashMap<u32, u32>>)
        -> (Box<[f32]>, HashMap<u32, u32>) {
        let mut active_flags: HashMap<u32, u32> = HashMap::new();
        let mut order: Vec<u32> = Vec::new();
        let mut writes: HashMap<u32, BoneWrite> = HashMap::new();

        let effective_value = |au_id: u32, side: u8| -> f32 {
            let raw = clamp01(*self.au_values.get(&au_id).unwrap_or(&0.0));
            let balance = self.au_balances.get(&au_id).copied().unwrap_or(0.0);
            (raw * side_scale(balance, side)).max(self.active_viseme_au_amount(au_id))
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
            let mut bone_active = false;

            while composite_index < self.composite_axes.len()
                && self.composite_axes[composite_index].bone_id == bone_id
            {
                let axis = &self.composite_axes[composite_index];
                let direction = composite_axis_value(axis, effective_value);
                if direction.abs() > 1e-6 {
                    if let Some(binding) = select_axis_binding(axis, direction, effective_value) {
                        if binding.max_degrees.abs() > 0.0 {
                            bone_active = true;
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

            if previous.is_some() && bone_active { *active_flags.entry(bone_id).or_default() |= FLAG_HAS_ROTATION; }
            if !active_only || bone_active {
                upsert_bone_write(&mut writes, &mut order, bone_id, None, Some(rotation));
            }
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
            let value = clamp01(
                (*self.au_values.get(&row.au_id).unwrap_or(&0.0))
                    .max(self.active_viseme_au_amount(row.au_id)),
            );
            if value <= 1e-6 {
                continue;
            }
            let offset = (value * row.scale).clamp(-1.0, 1.0) * row.max_units;
            entry.1[row.axis.min(2) as usize] = offset;
        }
        for (bone_id, offset) in offsets {
            if previous.is_some() && offset.iter().any(|component| component.abs() > 1e-6) {
                *active_flags.entry(bone_id).or_default() |= FLAG_HAS_POSITION;
            }
            if active_only && offset.iter().all(|component| component.abs() <= 1e-6) {
                continue;
            }
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
                if previous.is_some() {
                    *active_flags.entry(jaw.bone_id).or_default() |= FLAG_HAS_ROTATION;
                }
                let rotation = multiply_quat(
                    rest,
                    quat_from_channel(
                        jaw.channel,
                        jaw.max_degrees.to_radians() * jaw_amount * jaw.scale,
                    ),
                );
                upsert_bone_write(&mut writes, &mut order, jaw.bone_id, None, Some(rotation));
            } else if !active_only
                && writes
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
            if let Some(previous) = previous {
                flags &= active_flags.get(&bone_id).copied().unwrap_or(0)
                    | previous.get(&bone_id).copied().unwrap_or(0);
                if flags == 0 { continue; }
            }
            let position = position.unwrap_or([0.0, 0.0, 0.0]);
            let rotation = rotation.unwrap_or([0.0, 0.0, 0.0, 1.0]);
            out.push(bone_id as f32);
            out.extend_from_slice(&position);
            out.extend_from_slice(&rotation);
            out.push(flags as f32);
        }
        (out.into_boxed_slice(), active_flags)
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
        let snippet_curves = curves
            .into_iter()
            .map(|(id, points)| {
                let target = if let Some(numeric_id) = id
                    .parse::<u32>()
                    .ok()
                    .filter(|_| id.chars().all(|c| c.is_ascii_digit()))
                {
                    if options.snippet_category.as_deref() == Some("visemeSnippet")
                        && (numeric_id as usize) < self.viseme_values.len()
                    {
                        CurveTarget::Viseme(numeric_id)
                    } else {
                        CurveTarget::Au {
                            id: numeric_id,
                            balance: options
                                .balance_map
                                .get(&id)
                                .copied()
                                .unwrap_or(options.balance.unwrap_or(0.0)),
                        }
                    }
                } else {
                    CurveTarget::Morph(id)
                };
                SnippetCurve {
                    target,
                    points: points
                        .into_iter()
                        .map(|point| SnippetCurvePoint {
                            time: point.time,
                            intensity: point.intensity,
                            inherit: point.inherit,
                        })
                        .collect(),
                }
            })
            .collect();
        self.compile_snippet_curves(clip_name, snippet_curves, options, false)
    }

    fn compile_snippet_curves(
        &self,
        clip_name: &str,
        snippet_curves: Vec<SnippetCurve>,
        options: &ClipBuildOptions,
        merge_duplicate_channels: bool,
    ) -> Result<ClipIR, JsError> {
        let mesh_names_json = serde_json::to_string(&options.mesh_names).unwrap_or_default();
        let mut named_morph_targets = HashMap::new();
        for curve in &snippet_curves {
            if let CurveTarget::Morph(name) = &curve.target {
                let targets = self.resolve_morph_targets(name, None, &mesh_names_json);
                if !targets.is_empty() {
                    named_morph_targets.insert(name.clone(), targets);
                }
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
            merge_duplicate_channels,
            intensity_scale: options.intensity_scale.unwrap_or(1.0),
            auto_viseme_jaw: options.auto_viseme_jaw.unwrap_or(true),
            jaw_scale: options.jaw_scale.unwrap_or(1.0),
        };
        let mut mix_weights = self.mix_weights.clone();
        mix_weights.extend(options.mix_weights.clone());
        let tracks = compile_snippet_tracks(SnippetCompileInput {
            curves: &snippet_curves,
            au_bindings: &au_bindings,
            viseme_bindings: &viseme_bindings,
            viseme_slot_count: self.viseme_values.len(),
            mix_weights: &mix_weights,
            mixed_aus: &mixed_aus,
            composite_axes: &self.composite_axes,
            translation_rows: &self.translation_rows,
            jaw_binding: self.jaw_binding.as_ref(),
            viseme_jaw_amounts: &self.viseme_jaw_amounts,
            bone_rest_transforms: &self.bone_rest_transforms,
            named_morph_targets: &named_morph_targets,
            options: &compile_options,
        })
        .map_err(|error| JsError::new(&error))?;
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

        // Preserve each channel's namespace, balance and curve until concrete
        // targets are resolved. Numeric id alone is not a channel identity.
        let mut semantic_curves = Vec::new();
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
            if matches!(target_type, "au" | "lipSync" | "viseme") {
                let Some(id) = channel
                    .target
                    .get("id")
                    .and_then(serde_json::Value::as_u64)
                    .and_then(|id| u32::try_from(id).ok())
                else {
                    continue;
                };
                let target = if target_type == "viseme" {
                    CurveTarget::Viseme(id)
                } else {
                    let balance = channel
                        .target
                        .get("balance")
                        .and_then(serde_json::Value::as_f64)
                        .map(|value| value as f32)
                        .or_else(|| options.balance_map.get(&id.to_string()).copied())
                        .unwrap_or(options.balance.unwrap_or(0.0));
                    CurveTarget::Au { id, balance }
                };
                semantic_curves.push(SnippetCurve {
                    target,
                    points: channel
                        .keyframes
                        .iter()
                        .map(|point| SnippetCurvePoint {
                            time: point.time,
                            intensity: point.intensity * channel.intensity_scale.unwrap_or(1.0),
                            inherit: point.inherit,
                        })
                        .collect(),
                });
            } else {
                let scale = global_scale * channel.intensity_scale.unwrap_or(1.0);
                remaining.push((channel, scale));
            }
        }
        if !semantic_curves.is_empty() {
            let compiled =
                self.compile_snippet_curves(clip_name, semantic_curves, options, true)?;
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

    fn active_viseme_au_amount(&self, au_id: u32) -> f32 {
        self.viseme_values
            .iter()
            .enumerate()
            .filter_map(|(index, value)| {
                let amount = self.viseme_tongue_targets.get(index)?.get(&au_id)?;
                Some(clamp01(*value) * clamp01(*amount))
            })
            .fold(0.0, f32::max)
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
    fn reads_canonical_au_balance_through_updates_and_clear() {
        let mut core = RuntimeCore::new(0);
        assert_eq!(core.get_au_balance(43), 0.0);
        assert!(core.au_balances.is_empty(), "reading an unset AU is pure");

        core.set_au(43, 0.75, -0.25);
        assert_eq!(core.get_au_balance(43), -0.25);
        assert_eq!(core.get_au(43), 0.75);
        assert_eq!(core.get_au_balance(12), 0.0);
        core.set_au_signed(43, 0.5, 0.5);
        assert_eq!(core.get_au_balance(43), 0.5);
        core.transition_au(43, 0.0, 200.0, f32::NAN);
        assert_eq!(
            core.get_au_balance(43),
            0.5,
            "zero intensity retains its stored balance"
        );

        for (input, expected) in [
            (2.0, 1.0),
            (-2.0, -1.0),
            (f32::NAN, 0.0),
            (f32::INFINITY, 0.0),
        ] {
            core.set_au(43, 1.0, input);
            assert_eq!(core.get_au_balance(43), expected);
        }
        core.set_continuum(61, 62, -0.5, -0.75);
        assert_eq!(core.get_au_balance(61), -0.75);
        assert_eq!(core.get_au_balance(62), -0.75);
        core.clear();
        for id in [43, 61, 62] {
            assert_eq!(core.get_au_balance(id), 0.0);
        }
        core.set_au(43, 0.5, 1.0);
        assert_eq!(core.get_au_balance(43), 1.0);
    }

    fn bilateral_channels(inherit: bool) -> Vec<TypedChannel> {
        serde_json::from_value(serde_json::json!([
            { "target": { "type": "au", "id": 43, "balance": -1 },
              "keyframes": [{ "time": 0, "intensity": 0, "inherit": inherit }, { "time": 1, "intensity": 0.3 }] },
            { "target": { "type": "au", "id": 43, "balance": 1 },
              "keyframes": [{ "time": 0, "intensity": 0, "inherit": inherit }, { "time": 1, "intensity": 0.7 }] }
        ])).unwrap()
    }

    #[test]
    fn typed_bilateral_channels_preserve_independent_morph_curves() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[43.0, 0.0, 1.0, 100.0, 1.0, 43.0, 1.0, 1.0, 101.0, 1.0]);
        for inherit in [false, true] {
            for reverse in [false, true] {
                let mut channels = bilateral_channels(inherit);
                if reverse {
                    channels.reverse();
                }
                let clip = core
                    .compile_typed_channels("wink", channels, &ClipBuildOptions::default())
                    .unwrap();
                assert_eq!(clip.tracks.len(), 2, "one track per concrete eyelid");
                for (id, expected) in [(100, 0.3), (101, 0.7)] {
                    let track = clip
                        .tracks
                        .iter()
                        .find(|track| track.target["morphTargetId"] == id)
                        .unwrap();
                    assert_eq!(track.values, vec![0.0, expected]);
                    assert_eq!(track.inherit_start, inherit);
                }
            }
        }
    }

    #[test]
    fn opposite_side_does_not_change_authored_start_or_key_times() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[43.0, 0.0, 1.0, 100.0, 1.0, 43.0, 1.0, 1.0, 101.0, 1.0]);
        let mut channels = bilateral_channels(true);
        channels[0].keyframes[0].inherit = false;
        channels[0].keyframes[0].intensity = 0.8;
        channels[0].keyframes[1].intensity = 0.8;
        channels[1].keyframes[1].time = 0.5;
        let clip = core
            .compile_typed_channels("wink", channels, &ClipBuildOptions::default())
            .unwrap();
        let left = clip
            .tracks
            .iter()
            .find(|track| track.target["morphTargetId"] == 100)
            .unwrap();
        assert!(
            !left.inherit_start,
            "an inactive opposite-side release cannot claim this anchor"
        );
        assert_eq!(left.times, vec![0.0, 1.0]);
        assert_eq!(left.values, vec![0.8, 0.8]);
        let right = clip
            .tracks
            .iter()
            .find(|track| track.target["morphTargetId"] == 101)
            .unwrap();
        assert!(right.inherit_start);
        assert_eq!(right.times, vec![0.0, 0.5]);
    }

    #[test]
    fn typed_bilateral_channels_preserve_independent_bone_curves() {
        let mut core = RuntimeCore::new(0);
        for (bone_id, side) in [(1, crate::bones::SIDE_LEFT), (2, crate::bones::SIDE_RIGHT)] {
            core.composite_axes.push(CompositeAxis {
                bone_id,
                has_directional_groups: false,
                value_rows: vec![AxisValueRow {
                    au_id: 43,
                    group: crate::bones::GROUP_PLAIN,
                    side,
                }],
                binding_rows: vec![AxisBindingRow {
                    au_id: 43,
                    group: crate::bones::GROUP_PLAIN,
                    side,
                    channel: 0,
                    scale: 1.0,
                    max_degrees: 60.0,
                }],
            });
        }
        let clip = core
            .compile_typed_channels(
                "gills",
                bilateral_channels(false),
                &ClipBuildOptions::default(),
            )
            .unwrap();
        assert_eq!(clip.tracks.len(), 2);
        for (id, amount) in [(1, 0.3), (2, 0.7)] {
            let track = clip
                .tracks
                .iter()
                .find(|track| track.target["boneId"] == id)
                .unwrap();
            let expected = quat_from_channel(0, 60.0_f32.to_radians() * amount);
            for (actual, expected) in track.values[4..].iter().zip(expected) {
                assert!((actual - f64::from(expected)).abs() < 1e-6);
            }
        }
    }

    #[test]
    fn typed_au_and_viseme_keep_separate_namespaces() {
        let mut core = RuntimeCore::new(2);
        core.load_au_morph_bindings(&[1.0, 2.0, 1.0, 100.0, 1.0]);
        core.load_viseme_morph_bindings(&[1.0, 1.0, 101.0, 1.0]);
        let channels = serde_json::from_value(serde_json::json!([
            { "target": { "type": "au", "id": 1 }, "keyframes": [{ "time": 0, "intensity": 0.3 }, { "time": 1, "intensity": 0.3 }] },
            { "target": { "type": "viseme", "id": 1 }, "keyframes": [{ "time": 0, "intensity": 0.7 }, { "time": 1, "intensity": 0.7 }] }
        ])).unwrap();
        let clip = core
            .compile_typed_channels("talk", channels, &ClipBuildOptions::default())
            .unwrap();
        assert_eq!(clip.tracks.len(), 2);
        for (id, value) in [(100, 0.3), (101, 0.7)] {
            assert_eq!(
                clip.tracks
                    .iter()
                    .find(|track| track.target["morphTargetId"] == id)
                    .unwrap()
                    .values,
                vec![value, value]
            );
        }
    }

    #[test]
    fn legacy_and_distinct_au_shared_targets_keep_separate_tracks() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[43.0, 2.0, 1.0, 100.0, 1.0, 44.0, 2.0, 1.0, 100.0, 1.0]);
        let curves = serde_json::from_value(serde_json::json!({
            "43": [{ "time": 0, "intensity": 0.3 }, { "time": 1, "intensity": 0.3 }],
            "44": [{ "time": 0, "intensity": 0.7, "inherit": true }, { "time": 1, "intensity": 0.7 }]
        })).unwrap();
        let legacy = core
            .compile_curves("shared", curves, &ClipBuildOptions::default())
            .unwrap();
        let channels = serde_json::from_value(serde_json::json!([
            { "target": { "type": "au", "id": 43 }, "keyframes": [{ "time": 0, "intensity": 0.3 }, { "time": 1, "intensity": 0.3 }] },
            { "target": { "type": "au", "id": 44 }, "keyframes": [{ "time": 0, "intensity": 0.7, "inherit": true }, { "time": 1, "intensity": 0.7 }] }
        ])).unwrap();
        let typed = core
            .compile_typed_channels("shared", channels, &ClipBuildOptions::default())
            .unwrap();
        for clip in [&legacy, &typed] {
            assert_eq!(clip.tracks.len(), 2);
            assert_eq!(clip.tracks[0].target, clip.tracks[1].target);
            assert_eq!(clip.tracks[0].values, vec![0.3, 0.3]);
            assert!(!clip.tracks[0].inherit_start);
            assert_eq!(clip.tracks[1].values, vec![0.7, 0.7]);
            assert!(clip.tracks[1].inherit_start);
        }
    }

    #[test]
    fn one_typed_channel_keeps_repeated_profile_binding_tracks() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[43.0, 0.0, 1.0, 100.0, 1.0, 43.0, 1.0, 1.0, 100.0, 1.0]);
        let channels = serde_json::from_value(serde_json::json!([
            { "target": { "type": "au", "id": 43, "balance": 0 }, "keyframes": [{ "time": 0, "intensity": 0, "inherit": true }, { "time": 1, "intensity": 0.8 }] }
        ])).unwrap();
        let clip = core
            .compile_typed_channels("shared", channels, &ClipBuildOptions::default())
            .unwrap();
        assert_eq!(clip.tracks.len(), 2);
        assert_eq!(clip.tracks[0].target, clip.tracks[1].target);
        assert!(clip
            .tracks
            .iter()
            .all(|track| track.inherit_start && track.values == vec![0.0, 0.8]));
    }

    fn mixed_animation_clip(name: &str) -> serde_json::Value {
        use serde_json::json;

        let targets = [
            json!({ "kind": "morphTarget", "meshId": 1, "morphTargetId": 7 }),
            json!({ "kind": "boneTransform", "boneId": 4, "property": "position" }),
            json!({ "kind": "boneTransform", "boneId": 5, "property": "position" }),
            json!({ "kind": "boneTransform", "boneId": 6, "property": "position" }),
            json!({ "kind": "objectTransform", "objectId": 10, "property": "position" }),
            json!({ "kind": "objectTransform", "objectId": 11, "property": "position" }),
            json!({ "kind": "objectTransform", "objectId": 12, "property": "position" }),
            json!({ "kind": "meshVisibility", "meshId": 1 }),
        ];
        let tracks = targets
            .into_iter()
            .enumerate()
            .map(|(index, target)| {
                let transform = matches!(
                    target["kind"].as_str(),
                    Some("boneTransform" | "objectTransform")
                );
                json!({
                    "id": index + 1,
                    "channelId": 42,
                    "target": target,
                    "valueType": if transform { "vec3" } else { "scalar" },
                    "times": [0, 1],
                    "values": if transform { vec![0, 0, 0, 1, 0, 0] } else { vec![0, 1] },
                    "sourceName": format!("track-{index}")
                })
            })
            .collect::<Vec<_>>();
        json!({
            "name": name,
            "durationSeconds": 1,
            "channels": [{ "id": 42, "kind": "custom", "name": "authored channel" }],
            "tracks": tracks,
            "metadata": { "author": "saved-animation" }
        })
    }

    fn animation_test_runtime() -> RuntimeCore {
        let mut core = RuntimeCore::new(0);
        core.configure(
            "{}",
            r#"{
            "bones": [
                { "id": 4, "name": "Head" },
                { "id": 5, "name": "UpperArm" },
                { "id": 6, "name": "CustomControl" }
            ],
            "objects": [
                { "id": 10, "name": "Eye", "isBone": true },
                { "id": 11, "name": "Prop" },
                { "id": 12, "name": "Viewpoint", "isCamera": true }
            ]
        }"#,
        )
        .unwrap();
        // Nonstandard names still use the configured facial bindings.
        core.load_jaw_binding(&[6.0, 0.0, 1.0, 30.0]);
        core
    }

    #[test]
    fn additive_baked_registration_matches_bulk_channel_classification() {
        let clip = mixed_animation_clip("optional");
        let mut bulk = animation_test_runtime();
        let mut additive = animation_test_runtime();
        bulk.load_animation_clips(&serde_json::json!([clip]).to_string())
            .unwrap();
        additive
            .register_animation_clip(&clip.to_string(), "baked")
            .unwrap();

        let registered = additive.animation.clip("optional").unwrap();
        assert_eq!(
            registered
                .tracks
                .iter()
                .map(|track| track.channel_id)
                .collect::<Vec<_>>(),
            vec![1, 1, 2, 1, 1, 2, 3, 2]
        );
        assert_eq!(
            serde_json::to_value(registered).unwrap(),
            serde_json::to_value(bulk.animation.clip("optional").unwrap()).unwrap()
        );
        assert_eq!(
            additive.get_animation_clips().unwrap(),
            bulk.get_animation_clips().unwrap()
        );
        assert_eq!(
            registered.metadata.as_ref().unwrap()["author"],
            "saved-animation"
        );
    }

    #[test]
    fn additive_baked_registration_preserves_existing_clips_and_playback() {
        let mut core = animation_test_runtime();
        core.load_animation_clips(&serde_json::json!([mixed_animation_clip("idle")]).to_string())
            .unwrap();
        core.register_animation_clip(&mixed_animation_clip("gesture").to_string(), "snippet")
            .unwrap();
        core.animation
            .play("idle", Default::default(), |_| vec![])
            .unwrap();
        core.animation
            .play("gesture", Default::default(), |_| vec![])
            .unwrap();
        core.animation.update(0.25);
        let catalog_before = core.animation.list();
        let playing_before = serde_json::to_value(core.animation.playing()).unwrap();
        core.animation.drain_events();

        core.register_animation_clip(&mixed_animation_clip("optional").to_string(), "baked")
            .unwrap();

        let catalog_after = core.animation.list();
        assert_eq!(catalog_after.len(), 3);
        for previous in catalog_before {
            let current = catalog_after
                .iter()
                .find(|clip| clip.name == previous.name)
                .unwrap();
            assert_eq!(
                serde_json::to_value(current).unwrap(),
                serde_json::to_value(previous).unwrap()
            );
        }
        assert_eq!(
            serde_json::to_value(core.animation.playing()).unwrap(),
            playing_before
        );
        assert!(core.animation.drain_events().is_empty());
        core.animation.update(0.25);
        assert_eq!(core.animation.state("idle").unwrap().time, 0.5);
        assert_eq!(core.animation.state("gesture").unwrap().time, 0.5);
    }

    #[test]
    fn non_baked_registration_preserves_authored_channels() {
        for source in ["snippet", "procedural", ""] {
            let mut core = animation_test_runtime();
            let clip = mixed_animation_clip("authored");
            core.register_animation_clip(&clip.to_string(), source)
                .unwrap();
            let stored = core.animation.clip("authored").unwrap();
            assert_eq!(
                serde_json::to_value(&stored.channels).unwrap(),
                clip["channels"]
            );
            assert!(stored.tracks.iter().all(|track| track.channel_id == 42));
            assert_eq!(
                core.animation.list()[0].source,
                if source.is_empty() { "clip" } else { source }
            );
        }
    }

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
    fn procedural_bone_ownership_releases_properties_once_without_touching_mixer_channels() {
        let mut core = RuntimeCore::new(1);
        core.load_bone_rest_transforms(&[
            1.0, 2.0, 3.0, 4.0, 0.0, 0.0, 0.0, 1.0,
            2.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0,
        ]);
        core.load_composite_axes(&[
            1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0,
            51.0, 2.0, 0.0, 51.0, 2.0, 0.0, 1.0, 1.0, 30.0,
        ]);
        core.load_bone_translations(&[40.0, 1.0, 1.0, 1.0, 0.5]);
        core.load_jaw_binding(&[2.0, 0.0, 1.0, 30.0]);
        core.load_viseme_jaw_amounts(&[1.0]);
        assert!(core.evaluate_procedural_bone_frame().is_empty());
        core.set_au(51, 0.5, 0.0);
        let rotation = core.evaluate_procedural_bone_frame();
        assert_eq!(rotation.len(), 9);
        assert_eq!(rotation[8], FLAG_HAS_ROTATION as f32);
        let active = core.evaluate_active_bone_frame();
        assert_eq!(active[0], rotation[0]);
        assert_eq!(&active[4..], &rotation[4..]); // position is unowned
        core.set_au(40, 0.5, 0.0);
        assert_eq!(core.evaluate_procedural_bone_frame()[8], 3.0);
        core.set_au(51, 0.0, 0.0);
        // Pure post-mixer reads must not consume the pending neutral release.
        assert_eq!(core.evaluate_active_bone_frame()[8], 1.0);
        let release = core.evaluate_procedural_bone_frame();
        assert_eq!(release[8], 3.0);
        assert_eq!(&release[4..8], &[0.0, 0.0, 0.0, 1.0]);
        assert_eq!(core.evaluate_procedural_bone_frame()[8], 1.0);
        core.set_viseme(0, 0.5);
        assert_eq!(core.evaluate_procedural_bone_frame().len(), 18);
        core.clear();
        assert!(core.evaluate_active_bone_frame().is_empty());
        let release = core.evaluate_procedural_bone_frame();
        assert_eq!(release.len(), 18);
        assert_eq!(release[8], 1.0);
        assert_eq!(&release[1..4], &[2.0, 3.0, 4.0]);
        assert_eq!(release[17], 2.0);
        assert!(core.evaluate_procedural_bone_frame().is_empty());
    }

    #[test]
    fn procedural_morphs_preserve_bilateral_mix_and_release_direct_only_targets_once() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[
            1.0, 0.0, 10.0, 100.0, 1.0,
            1.0, 1.0, 10.0, 101.0, 1.0,
            2.0, 2.0, 10.0, 102.0, 1.0,
        ]);
        assert!(core.evaluate_procedural_morph_frame().is_empty());
        core.mixed_aus.insert(1, true);
        core.set_au_mix_weight(1, 0.5);
        core.set_au(1, 0.8, -1.0);
        let active = core.evaluate_procedural_morph_frame();
        assert_eq!(&*active, &[10.0, 100.0, 0.4, 0.0]);
        assert_eq!(core.evaluate_active_morph_frame(), active);
        core.set_au(1, 0.8, 1.0);
        assert_eq!(&*core.evaluate_procedural_morph_frame(),
            &[10.0, 100.0, 0.0, 0.0, 10.0, 101.0, 0.4, 0.0]);
        assert_eq!(&*core.evaluate_procedural_morph_frame(), &[10.0, 101.0, 0.4, 0.0]);
        core.direct_morph_values.insert((9, 2), 0.0);
        core.direct_morph_values.insert((9, 1), 0.75);
        let stable = core.evaluate_procedural_morph_frame();
        assert_eq!(core.evaluate_procedural_morph_frame(), stable);
        assert_eq!(&stable[..8], &[9.0, 1.0, 0.75, 0.0, 9.0, 2.0, 0.0, 0.0]);
        core.clear();
        assert!(core.evaluate_active_morph_frame().is_empty());
        assert_eq!(&*core.evaluate_procedural_morph_frame(),
            &[10.0, 101.0, 0.0, 0.0, 9.0, 1.0, 0.0, 0.0, 9.0, 2.0, 0.0, 0.0]);
        assert!(core.evaluate_procedural_morph_frame().is_empty());
    }

    #[test]
    fn procedural_rebind_releases_old_ids_and_reconfigure_cannot_write_reused_ids() {
        let mut core = RuntimeCore::new(0);
        let model = r#"{"meshes":[{"id":1,"name":"Body","morphTargetIds":[7]}],"morphTargets":[{"id":7,"meshId":1,"name":"Flex","hostIndex":0}]}"#;
        core.configure_with_profile("{}", model).unwrap();
        core.set_morph("Flex", 0.75, "[]");
        assert_eq!(&*core.evaluate_procedural_morph_frame(), &[1.0, 7.0, 0.75, 0.0]);
        assert_eq!(&*core.release_procedural_morph_frame(), &[1.0, 7.0, 0.0, 0.0]);
        assert!(core.release_procedural_morph_frame().is_empty());
        // Reconfigure also clears ownership even if a caller discards the old
        // renderer instead of applying a release to it.
        core.evaluate_procedural_morph_frame();
        core.configure_with_profile("{}", &model.replace("Flex", "DifferentTarget")).unwrap();
        assert!(core.evaluate_procedural_morph_frame().is_empty());
        assert!(core.release_procedural_morph_frame().is_empty());
        core.load_bone_translations(&[40.0, 1.0, 1.0, 1.0, 0.5]);
        core.set_au(40, 1.0, 0.0);
        assert!(!core.evaluate_procedural_bone_frame().is_empty());
        core.configure_with_profile("{}", "{}").unwrap();
        core.set_au(40, 0.0, 0.0);
        core.load_bone_translations(&[40.0, 1.0, 1.0, 1.0, 0.5]);
        assert!(core.evaluate_procedural_bone_frame().is_empty());
    }

    #[test]
    fn configured_body_descriptors_match_authoring_resolution_and_refresh_on_configure() {
        let mut core = RuntimeCore::new(0);
        assert_eq!(core.get_body_controls_json(), "[]");
        let model = r#"{"bones":[{"id":1,"name":"CC_Base_L_Forearm"}]}"#;
        core.configure_with_preset("cc4", "{}", model).unwrap();
        let expected = crate::body_controls::resolve(core.profile.as_ref().unwrap(), core.model.as_ref());
        assert_eq!(serde_json::from_str::<serde_json::Value>(&core.get_body_controls_json()).unwrap(), expected);
        assert_eq!(expected.as_array().unwrap().len(), 58);
        let elbow = expected.as_array().unwrap().iter().find(|control| control["id"] == "body.elbowFlex").unwrap();
        assert_eq!(elbow["hasBones"], true);
        assert_eq!(elbow["hasMorphs"], false);
        core.configure_with_preset("cc4", "{}", "{}").unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&core.get_body_controls_json()).unwrap()
            .as_array().unwrap().iter().all(|control| control["available"] == false));
        core.configure_with_profile("{}", model).unwrap();
        assert_eq!(core.get_body_controls_json(), "[]");
    }

    #[test]
    fn body_reset_uses_unique_configured_actions_preserves_face_and_mix_and_releases_frame() {
        let mut core = RuntimeCore::new(0);
        core.configure_with_preset("cc4", "{}", r#"{"bones":[{"id":1,"name":"CC_Base_L_Forearm"}]}"#).unwrap();
        core.set_au(1001, 0.8, -1.0);
        core.set_continuum(1003, 1004, -0.5, 0.75);
        core.set_au(51, 0.5, 0.5); // Shared facial action is in the Body catalog.
        core.set_au(12, 0.9, -0.25); // Unrelated face control is preserved.
        core.set_au_mix_weight(1001, 0.25);
        core.direct_morph_values.insert((10, 9), 0.8);
        assert!(!core.evaluate_procedural_bone_frame().is_empty());
        core.reset_body_controls();
        for id in [1001, 1003, 1004, 51] {
            assert_eq!(core.get_au(id), 0.0);
            assert_eq!(core.get_au_balance(id), 0.0);
        }
        assert_eq!(core.get_au(12), 0.9);
        assert_eq!(core.get_au_balance(12), -0.25);
        assert_eq!(core.mix_weights.get(&1001), Some(&0.25));
        assert_eq!(core.direct_morph_values.get(&(10, 9)), Some(&0.8));
        assert_eq!(core.evaluate_procedural_bone_frame()[8], 2.0);
        assert!(core.evaluate_procedural_bone_frame().is_empty());
        // Replacing the catalog makes the prior default actions unrelated.
        core.configure_with_profile(r#"{"bodyControls":{"custom":{"label":"Custom","auId":12},"alias":{"label":"Alias","auId":12,"negativeAuId":12}}}"#, "{}").unwrap();
        assert_eq!(core.body_control_au_ids.len(), 1);
        core.set_au(1001, 0.6, 0.5);
        core.reset_body_controls();
        assert_eq!(core.get_au(12), 0.0);
        assert_eq!(core.get_au(1001), 0.6);
        assert_eq!(core.get_au_balance(1001), 0.5);
    }

    #[test]
    fn release_morph_restores_au_output_and_preserves_other_direct_overrides() {
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(r#"{
            "bodyControls":{"body.elbowFlex":{"label":"Flex","auId":1001}},
            "auToMorphs":{"1001":{"center":["Flex"]}},
            "auInfo":{"1001":{"facePart":"Body"}},
            "auFacePartToMeshCategory":{"Body":"body"},
            "morphToMesh":{"body":["Skin"],"face":["Skin"]},
            "auMixDefaults":{"1001":0.25}
        }"#, r#"{
            "meshes":[{"id":1,"name":"Skin","morphTargetIds":[2,3,4]},
                      {"id":5,"name":"Clothing","morphTargetIds":[6]}],
            "morphTargets":[{"id":2,"meshId":1,"name":"Flex","hostIndex":0},
                {"id":3,"meshId":1,"name":"Other","hostIndex":1},
                {"id":4,"meshId":1,"name":"PreviewOnly","hostIndex":2},
                {"id":6,"meshId":5,"name":"Flex","hostIndex":0}]
        }"#).unwrap();
        core.set_au(1001, 0.8, 0.0);
        core.set_morph("Flex", 1.0, r#"["Skin"]"#);
        core.set_morph("Other", 0.6, r#"["Skin"]"#);
        core.set_morph("Flex", 0.7, r#"["Clothing"]"#);
        assert_eq!(unpack_rows(&core.evaluate_procedural_morph_frame()),
            vec![(1, 2, 1.0), (1, 3, 0.6), (5, 6, 0.7)]);
        assert_eq!(core.release_morph("Flex", r#"["Skin"]"#), 1);
        assert_eq!(unpack_rows(&core.evaluate_procedural_morph_frame()),
            vec![(1, 2, 0.2), (1, 3, 0.6), (5, 6, 0.7)]);
        assert_eq!(core.release_morph("Flex", r#"["Skin"]"#), 0);
        core.set_morph_index(0, 0.0, r#"["Skin"]"#);
        assert_eq!(unpack_rows(&core.evaluate_active_morph_frame()),
            vec![(1, 2, 0.0), (1, 3, 0.6), (5, 6, 0.7)], "explicit zero still owns its target");
        assert_eq!(core.release_morph_index(0, r#"["Skin"]"#), 1);
        assert_eq!(unpack_rows(&core.evaluate_active_morph_frame()),
            vec![(1, 2, 0.2), (1, 3, 0.6), (5, 6, 0.7)]);
        // Empty selection follows set_morph's existing profile-face default.
        core.set_morph("PreviewOnly", 0.5, "[]");
        assert!(unpack_rows(&core.evaluate_procedural_morph_frame()).contains(&(1, 4, 0.5)));
        assert_eq!(core.release_morph("PreviewOnly", "[]"), 1);
        assert!(unpack_rows(&core.evaluate_procedural_morph_frame()).contains(&(1, 4, 0.0)));
        assert!(!unpack_rows(&core.evaluate_procedural_morph_frame()).iter().any(|row| row.1 == 4));
        assert_eq!(core.release_morph("Missing", "[]"), 0);
        assert_eq!(core.get_au(1001), 0.8);
    }

    #[test]
    fn explicit_zero_morph_override_is_active_until_cleared() {
        let mut core = RuntimeCore::new(0);
        core.configure(r#"{"auToMorphs":{"12":{"center":["Flex"]}},"morphToMesh":{"face":["Body"]}}"#,
            r#"{"meshes":[{"id":1,"name":"Body","morphTargetIds":[7]}],"morphTargets":[{"id":7,"meshId":1,"name":"Flex","hostIndex":0}]}"#).unwrap();
        assert!(core.evaluate_active_morph_frame().is_empty());
        assert_eq!(core.set_morph("Flex", 0.0, "[]"), 1);
        assert_eq!(&*core.evaluate_active_morph_frame(), &[1.0, 7.0, 0.0, 0.0]);
        core.clear();
        assert!(core.evaluate_active_morph_frame().is_empty());
    }

    #[test]
    fn active_bone_frame_omits_neutral_bones_but_keeps_active_ones() {
        let mut core = RuntimeCore::new(2);
        core.load_bone_rest_transforms(&[
            1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // head bone 1
            3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, // jaw bone 3
        ]);
        core.load_composite_axes(&[
            1.0, 1.0, 0.0, 1.0, 1.0, 0.0, 0.0, 0.0, // head yaw axis
            51.0, 2.0, 0.0, 51.0, 2.0, 0.0, 1.0, 1.0, 30.0,
        ]);
        core.load_jaw_binding(&[3.0, 0.0, 1.0, 30.0]);
        core.load_viseme_jaw_amounts(&[1.0, 1.0]);

        // Neutral state: full frame resets to rest, active frame emits nothing.
        assert_eq!(
            core.evaluate_bone_frame_delta().len(),
            2 * PACKED_BONE_FRAME_DELTA_STRIDE as usize
        );
        assert_eq!(core.evaluate_active_bone_frame().len(), 0);

        // Active AU: both frames agree on the rotated bone; the active frame
        // omits the still-neutral jaw.
        core.set_au(51, 0.5, 0.0);
        let active = core.evaluate_active_bone_frame();
        assert_eq!(active.len(), PACKED_BONE_FRAME_DELTA_STRIDE as usize);
        assert_eq!(active[0], 1.0);
        let expected_half = (15.0f32).to_radians() / 2.0;
        assert!((active[5] - expected_half.sin()).abs() < 1e-6);

        // Active viseme jaw joins the active frame.
        core.set_viseme(0, 0.5);
        let active = core.evaluate_active_bone_frame();
        assert_eq!(active.len(), 2 * PACKED_BONE_FRAME_DELTA_STRIDE as usize);

        // Back to neutral: active frame is empty again.
        core.set_au(51, 0.0, 0.0);
        core.set_viseme(0, 0.0);
        assert_eq!(core.evaluate_active_bone_frame().len(), 0);
    }

    #[test]
    fn active_morph_frame_omits_zero_values() {
        let mut core = RuntimeCore::new(0);
        core.load_au_morph_bindings(&[
            1.0, 2.0, 10.0, 100.0, 1.0, // AU 1 center -> morph 100
            2.0, 2.0, 10.0, 101.0, 1.0, // AU 2 center -> morph 101, inactive
        ]);
        core.set_au(1, 0.8, 0.0);

        let active = unpack_rows(&core.evaluate_active_morph_frame());
        assert_eq!(active, vec![(10, 100, 0.8)]);

        // The full frame still resets the inactive morph to zero.
        let full = unpack_rows(&core.evaluate_morph_frame_delta());
        assert_eq!(full.len(), 2);
        assert!(full.contains(&(10, 101, 0.0)));

        core.set_au(1, 0.0, 0.0);
        assert_eq!(core.evaluate_active_morph_frame().len(), 0);
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
    fn cc4_preset_drives_head_bone_rotation_from_au() {
        // Regression: CC4 must ship compositeRotations so AU→bone yaw/pitch/roll
        // activates like morph targets. Loom3 fell back to built-in composites;
        // Rust has no such fallback when the embedded preset omits them.
        let model = r#"{
            "meshes": [{ "id": 1, "name": "CC_Base_Body", "morphTargetIds": [] }],
            "morphTargets": [],
            "bones": [
                {
                    "id": 2,
                    "name": "CC_Base_Head",
                    "restTransform": {
                        "position": { "x": 0, "y": 1.5, "z": 0 },
                        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 }
                    }
                },
                {
                    "id": 3,
                    "name": "CC_Base_JawRoot",
                    "restTransform": {
                        "position": { "x": 0, "y": 1.4, "z": 0.05 },
                        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 }
                    }
                }
            ]
        }"#;
        let mut core = RuntimeCore::new(0);
        core.configure_with_preset("cc4", "", model).unwrap();

        core.set_au(51, 1.0, 0.0);
        let packed = core.evaluate_bone_frame_delta();
        assert!(
            packed.len() >= PACKED_BONE_FRAME_DELTA_STRIDE as usize,
            "expected packed bone writes from CC4 compositeRotations"
        );

        let stride = PACKED_BONE_FRAME_DELTA_STRIDE as usize;
        let head = packed
            .chunks(stride)
            .find(|row| row[0] == 2.0)
            .expect("HEAD bone write missing");
        assert_eq!(head[8] as u32 & FLAG_HAS_ROTATION, FLAG_HAS_ROTATION);
        // AU 51 → Head yaw on ry at 60° → quat y = sin(30°)
        let expected = (60.0f32).to_radians() / 2.0;
        assert!(
            (head[5] - expected.sin()).abs() < 1e-4,
            "expected non-identity head yaw quat, got {:?}",
            &head[4..8]
        );

        core.set_au(26, 1.0, 0.0);
        let jaw_packed = core.evaluate_bone_frame_delta();
        let jaw = jaw_packed
            .chunks(stride)
            .find(|row| row[0] == 3.0)
            .expect("JAW bone write missing");
        assert_eq!(jaw[8] as u32 & FLAG_HAS_ROTATION, FLAG_HAS_ROTATION);
        let jaw_half = (30.0f32).to_radians() / 2.0;
        assert!(
            (jaw[6] - jaw_half.sin()).abs() < 1e-4,
            "expected non-identity jaw pitch quat, got {:?}",
            &jaw[4..8]
        );
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
    fn configured_viseme_drives_preset_tongue_aus_and_jaw_together() {
        let profile = r#"{
            "auToMorphs": {
                "37": { "left": [], "right": [], "center": ["Tongue_Up"] },
                "73": { "left": [], "right": [], "center": ["Tongue_Narrow"] },
                "76": { "left": [], "right": [], "center": ["Tongue_Tip_Up"] }
            },
            "auToBones": {
                "26": [{ "node": "JAW", "channel": "rz", "scale": 1, "maxDegrees": 30 }],
                "37": [{ "node": "TONGUE", "channel": "rz", "scale": 1, "maxDegrees": 20 }]
            },
            "boneNodes": { "JAW": "Jaw", "TONGUE": "Tongue" },
            "morphToMesh": { "face": ["TongueMesh"] },
            "compositeRotations": [
                {
                    "node": "TONGUE",
                    "pitch": { "aus": [37], "axis": "rz" },
                    "yaw": null,
                    "roll": null
                }
            ],
            "visemeKeys": ["T_L_D_N"],
            "visemeJawAmounts": [0.3],
            "visemeTongueTargets": [{ "37": 0.42, "73": 0.36, "76": 0.44 }]
        }"#;
        let model = r#"{
            "meshes": [{ "id": 1, "name": "TongueMesh", "morphTargetIds": [7, 8, 9] }],
            "morphTargets": [
                { "id": 7, "meshId": 1, "name": "Tongue_Up", "hostIndex": 0 },
                { "id": 8, "meshId": 1, "name": "Tongue_Narrow", "hostIndex": 1 },
                { "id": 9, "meshId": 1, "name": "Tongue_Tip_Up", "hostIndex": 2 }
            ],
            "bones": [
                { "id": 4, "name": "Jaw" },
                { "id": 5, "name": "Tongue" }
            ]
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure(profile, model).unwrap();
        core.set_viseme(0, 0.5);

        let morphs = unpack_rows(&core.evaluate_morph_frame_delta());
        assert!(morphs.contains(&(1, 7, 0.21)));
        assert!(morphs.contains(&(1, 8, 0.18)));
        assert!(morphs.contains(&(1, 9, 0.22)));

        let bones = core.evaluate_bone_frame_delta();
        let stride = PACKED_BONE_FRAME_DELTA_STRIDE as usize;
        let jaw = bones
            .chunks_exact(stride)
            .find(|row| row[0] == 4.0)
            .expect("jaw row");
        let tongue = bones
            .chunks_exact(stride)
            .find(|row| row[0] == 5.0)
            .expect("tongue row");
        let jaw_half_angle = (30.0f32 * 0.3 * 0.5).to_radians() / 2.0;
        let tongue_half_angle = (20.0f32 * 0.42 * 0.5).to_radians() / 2.0;
        assert!((jaw[6] - jaw_half_angle.sin()).abs() < 1e-4);
        assert!((tongue[6] - tongue_half_angle.sin()).abs() < 1e-4);

        // Explicit AU input and viseme-derived input share the same control
        // without mutating each other; the stronger value wins.
        core.set_au(37, 0.6, 0.0);
        let morphs = unpack_rows(&core.evaluate_morph_frame_delta());
        assert!(morphs.contains(&(1, 7, 0.6)));

        core.set_au(37, 0.0, 0.0);
        core.set_viseme(0, 0.0);
        assert!(core.evaluate_active_morph_frame().is_empty());
        assert!(core.evaluate_active_bone_frame().is_empty());
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
    fn resolved_profile_without_composites_falls_back_to_cc4_bone_rotations() {
        // Saved characters store auToBones rotation bindings but usually not
        // compositeRotations, and serialize unset fields as explicit null.
        // Loom3 parity: fall back to the CC4 composite table and treat null
        // like a missing key, so AU bone rotations work in live frames and in
        // snippet-to-clip decomposition.
        let profile = r#"{
            "auToBones": {
                "51": [{ "node": "CC_Base_Head", "channel": "ry", "scale": 1, "maxDegrees": 60 }],
                "52": [{ "node": "CC_Base_Head", "channel": "ry", "scale": -1, "maxDegrees": 60 }]
            },
            "boneNodes": { "HEAD": "Head" },
            "bonePrefix": "CC_Base_",
            "compositeRotations": null,
            "disabledRegions": null,
            "annotationRegions": null
        }"#;
        let model = r#"{
            "meshes": [],
            "morphTargets": [],
            "bones": [
                {
                    "id": 2,
                    "name": "CC_Base_Head",
                    "restTransform": {
                        "position": { "x": 0, "y": 1.5, "z": 0 },
                        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 }
                    }
                }
            ]
        }"#;

        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(profile, model).unwrap();

        // Live frame path: AU 51 must produce a HEAD rotation write.
        core.set_au(51, 1.0, 0.0);
        let stride = PACKED_BONE_FRAME_DELTA_STRIDE as usize;
        let packed = core.evaluate_bone_frame_delta();
        let head = packed
            .chunks(stride)
            .find(|row| row[0] == 2.0)
            .expect("HEAD bone write missing without profile compositeRotations");
        assert_eq!(head[8] as u32 & FLAG_HAS_ROTATION, FLAG_HAS_ROTATION);
        let expected = (60.0f32).to_radians() / 2.0;
        assert!(
            (head[5] - expected.sin()).abs() < 1e-4,
            "expected non-identity head yaw quat, got {:?}",
            &head[4..8]
        );

        // Snippet-to-clip path: the compiled clip must decompose the AU curve
        // into a boneTransform quaternion track, not just morph tracks.
        let clip_json = core
            .build_clip(
                "head-turn",
                r#"{"51": [{"time": 0, "intensity": 0}, {"time": 0.5, "intensity": 1}]}"#,
                "{}",
            )
            .unwrap();
        let clip: serde_json::Value = serde_json::from_str(&clip_json).unwrap();
        let tracks = clip["tracks"].as_array().unwrap();
        let bone_track = tracks
            .iter()
            .find(|track| track["target"]["kind"] == "boneTransform")
            .expect("compiled snippet clip is missing bone rotation tracks");
        assert_eq!(bone_track["valueType"], "quat");
        assert_eq!(bone_track["target"]["boneId"], 2);
        let values = bone_track["values"].as_array().unwrap();
        let last_y = values[values.len() - 3].as_f64().unwrap();
        assert!(
            (last_y - f64::from(expected.sin())).abs() < 1e-4,
            "expected final keyframe head yaw quat, got {last_y}"
        );
    }

    #[test]
    fn preset_override_with_empty_composites_disables_preset_bone_rotations() {
        let model = r#"{
            "meshes": [{ "id": 1, "name": "CC_Base_Body", "morphTargetIds": [] }],
            "morphTargets": [],
            "bones": [
                {
                    "id": 2,
                    "name": "CC_Base_Head",
                    "restTransform": {
                        "position": { "x": 0, "y": 1.5, "z": 0 },
                        "rotation": { "x": 0, "y": 0, "z": 0, "w": 1 }
                    }
                }
            ]
        }"#;
        let mut core = RuntimeCore::new(0);
        core.configure_with_preset("cc4", r#"{"compositeRotations": []}"#, model)
            .unwrap();
        core.set_au(51, 1.0, 0.0);
        let packed = core.evaluate_bone_frame_delta();
        assert!(
            packed.is_empty(),
            "explicit empty compositeRotations must disable preset bone rotations"
        );
    }

    #[test]
    fn au_balance_reports_authoritative_manual_state_across_reconfiguration_and_clear() {
        let mut core = RuntimeCore::new(0);
        assert_eq!(core.get_au_balance(1001), 0.0);
        core.set_au(1001, 0.5, -0.75);
        assert_eq!(core.get_au_balance(1001), -0.75);
        core.set_au(1002, 0.4, 2.0);
        assert_eq!(core.get_au_balance(1002), 1.0);
        core.set_continuum(1003, 1004, -0.5, 0.25);
        assert_eq!(core.get_au_balance(1003), 0.25);
        assert_eq!(core.get_au_balance(1004), 0.25);
        core.configure_with_preset("cc4", "{}", "{}").unwrap();
        assert_eq!(core.get_au(1001), 0.5);
        assert_eq!(core.get_au_balance(1001), -0.75);
        core.set_au_signed(1004, -0.5, -0.5);
        assert_eq!(core.get_au_balance(1003), -0.5);
        assert_eq!(core.get_au_balance(1004), -0.5);
        core.transition_au(1001, 0.25, 0.0, f32::NAN);
        assert_eq!(core.get_au_balance(1001), -0.75);
        core.clear();
        assert_eq!(core.get_au_balance(1001), 0.0);
        assert_eq!(core.get_au_balance(1003), 0.0);
        assert_eq!(core.get_au_balance(1004), 0.0);
    }

    #[test]
    fn resolved_profile_accepts_static_imports_without_injecting_bindings() {
        let model = r#"{"meshes":[{"id":1,"name":"Static mesh","morphTargetIds":[]}],"morphTargets":[],"bones":[]}"#;
        for profile in [
            "{}",
            r#"{"name":"metadata only"}"#,
            r#"{"auToMorphs":{},"auToBones":{}}"#,
        ] {
            let mut core = RuntimeCore::new(0);
            core.configure_with_profile(profile, model).unwrap();
            assert!(core.profile.as_ref().unwrap().composite_rotations.is_empty());
            core.set_au(51, 1.0, 0.0);
            assert!(core.evaluate_morph_frame_delta().is_empty());
            assert!(core.evaluate_bone_frame_delta().is_empty());
        }
    }

    #[test]
    fn resolved_profile_keeps_unmatched_mappings_available_for_authoring() {
        let empty_model = r#"{"meshes":[],"morphTargets":[],"bones":[]}"#;
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(
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
        .unwrap();
        assert!(core.profile.as_ref().unwrap().au_to_bones.contains_key("42"));
        core.set_au(42, 1.0, 0.0);
        assert!(core.evaluate_morph_frame_delta().is_empty());
        assert!(core.evaluate_bone_frame_delta().is_empty());
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
