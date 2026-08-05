//! Profile + model descriptor ingestion and binding compilation.
//!
//! The core consumes the same profile JSON hosts already use and compiles all
//! runtime binding tables internally: AU/viseme morph bindings, composite
//! rotation axes, bone translations, jaw binding, and rest transforms. Hosts
//! only pass data in; no mapping resolution happens in JavaScript.

use std::collections::{BTreeMap, HashMap};

use regex_lite::Regex;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::bones::{
    AXIS_PITCH, AXIS_ROLL, AXIS_YAW, GROUP_NEGATIVE, GROUP_PLAIN, GROUP_POSITIVE, SIDE_LEFT,
    SIDE_NONE, SIDE_RIGHT,
};

pub(crate) fn deserialize_json<T: DeserializeOwned>(
    json: &str,
    context: &str,
) -> Result<T, String> {
    let mut deserializer = serde_json::Deserializer::from_str(json);
    serde_path_to_error::deserialize(&mut deserializer)
        .map_err(|error| format!("{context}: {error}"))
}

/// Stored profiles serialize unset fields as explicit JSON `null` (the JS
/// runtime treated them as `field || fallback`). Deserialize `null` exactly
/// like a missing key so saved characters keep loading.
fn null_default<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de> + Default,
{
    Ok(Option::<T>::deserialize(deserializer)?.unwrap_or_default())
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum MorphRef {
    Index(i64),
    Name(String),
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum AuSelector {
    One(u32),
    Many(Vec<u32>),
}

impl AuSelector {
    fn to_list(selector: &Option<AuSelector>) -> Vec<u32> {
        match selector {
            None => Vec::new(),
            Some(AuSelector::One(id)) => vec![*id],
            Some(AuSelector::Many(ids)) => ids.clone(),
        }
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AuMorphEntry {
    #[serde(deserialize_with = "null_default")]
    pub left: Vec<MorphRef>,
    #[serde(deserialize_with = "null_default")]
    pub right: Vec<MorphRef>,
    #[serde(deserialize_with = "null_default")]
    pub center: Vec<MorphRef>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoneBindingData {
    pub node: String,
    pub channel: String,
    #[serde(default = "default_scale")]
    pub scale: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_degrees: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_units: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub side: Option<String>,
    #[serde(default, flatten)]
    pub extensions: Map<String, Value>,
}

fn default_scale() -> f64 {
    1.0
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RotationAxisData {
    #[serde(default)]
    pub aus: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub negative: Option<AuSelector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub positive: Option<AuSelector>,
    #[serde(default, flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompositeRotationData {
    pub node: String,
    #[serde(default)]
    pub pitch: Option<RotationAxisData>,
    #[serde(default)]
    pub yaw: Option<RotationAxisData>,
    #[serde(default)]
    pub roll: Option<RotationAxisData>,
    #[serde(default, flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContinuumPairData {
    pub pair_id: u32,
    #[serde(default)]
    pub is_negative: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub axis: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    #[serde(default, flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AuInfoData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub muscular_basis: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub links: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_area: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_part: Option<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum ProviderIdData {
    Integer(i64),
    Decimal(f64),
    Text(String),
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeSlotFeaturesData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jaw_open: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lip_closed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lip_round: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lip_spread: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tongue_tip: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fricative: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub nasal: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeSlotData {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<f64>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub provider_ids: HashMap<String, Vec<ProviderIdData>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub phonemes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub matchers: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<VisemeSlotFeaturesData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_jaw_amount: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeBindingTargetData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph: Option<MorphRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeBindingData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph: Option<MorphRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<VisemeBindingTargetData>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jaw_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub shared_with: Vec<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MappingSectionData {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub order: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mesh_category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub face_part: Option<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MeshMaterialData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub render_order: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transparent: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_write: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depth_test: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blending: Option<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MeshInfoData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material: Option<MeshMaterialData>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileVec3Data {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub z: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(untagged)]
pub enum LineDirectionData {
    Named(String),
    Vector(ProfileVec3Data),
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct LineConfigData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub curve: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub arrow_head: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thickness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length: Option<f64>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct MarkerStyleData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_color: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub marker_radius: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_color: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label_font_size: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line_direction: Option<LineDirectionData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub line: Option<LineConfigData>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AnnotationRegionData {
    pub name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub bones: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub meshes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub objects: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub padding_factor: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_angle: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub camera_offset: Option<ProfileVec3Data>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expand_animation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub style: Option<MarkerStyleData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_fallback: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub custom_position: Option<ProfileVec3Data>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairDirectionData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub yaw_sign: Option<i8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pitch_sign: Option<i8>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairMorphTargetData {
    pub key: String,
    pub axis: String,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairMorphTargetValueData {
    pub value: f64,
    pub axis: String,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairMorphTargetsData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sway_left: Option<HairMorphTargetData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sway_right: Option<HairMorphTargetData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sway_front: Option<HairMorphTargetData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fluff_right: Option<HairMorphTargetData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fluff_bottom: Option<HairMorphTargetData>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub head_up: HashMap<String, HairMorphTargetValueData>,
    #[serde(skip_serializing_if = "HashMap::is_empty")]
    pub head_down: HashMap<String, HairMorphTargetValueData>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct HairPhysicsData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stiffness: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub damping: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inertia: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gravity: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_sway_amount: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_sway_speed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_strength: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_direction_x: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_direction_z: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_turbulence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wind_frequency: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idle_clip_duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub impulse_clip_duration: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<HairDirectionData>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph_targets: Option<HairMorphTargetsData>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileData {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub animal_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub au_to_morphs: HashMap<String, Option<AuMorphEntry>>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub au_to_bones: HashMap<String, Vec<BoneBindingData>>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub bone_nodes: HashMap<String, String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bone_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bone_suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph_prefix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub morph_suffix: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suffix_pattern: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub left_morph_suffixes: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub right_morph_suffixes: Vec<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub morph_to_mesh: HashMap<String, Vec<String>>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub mapping_sections: Vec<MappingSectionData>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub au_info: HashMap<String, AuInfoData>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub au_face_part_to_mesh_category: HashMap<String, String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub au_mix_defaults: HashMap<String, f64>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub composite_rotations: Vec<CompositeRotationData>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub continuum_pairs: HashMap<String, Option<ContinuumPairData>>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub continuum_labels: HashMap<String, String>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub viseme_keys: Vec<MorphRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viseme_system_id: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub viseme_slots: Vec<VisemeSlotData>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub viseme_bindings: HashMap<String, VisemeBindingData>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub viseme_jaw_amounts: Vec<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub viseme_mesh_category: Option<String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub eye_mesh_nodes: HashMap<String, String>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub meshes: HashMap<String, MeshInfoData>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub annotation_regions: Vec<AnnotationRegionData>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub disabled_regions: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hair_physics: Option<HairPhysicsData>,
    // Typed legacy fish fields retained until that preset schema is normalized.
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub action_info: HashMap<String, AuInfoData>,
    #[serde(skip_serializing_if = "HashMap::is_empty", deserialize_with = "null_default")]
    pub bone_bindings: HashMap<String, Vec<BoneBindingData>>,
    #[serde(skip_serializing_if = "Vec::is_empty", deserialize_with = "null_default")]
    pub bones: Vec<String>,
    #[serde(flatten)]
    pub extensions: Map<String, Value>,
}

impl ProfileData {
    pub fn has_runtime_mappings(&self) -> bool {
        self.au_to_morphs.values().any(|entry| {
            entry.as_ref().is_some_and(|entry| {
                !entry.left.is_empty() || !entry.right.is_empty() || !entry.center.is_empty()
            })
        }) || self
            .au_to_bones
            .values()
            .any(|bindings| !bindings.is_empty())
            || !self.viseme_keys.is_empty()
            || !self.viseme_slots.is_empty()
            || !self.viseme_bindings.is_empty()
    }
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Vec3Data {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuatData {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TransformData {
    pub position: Option<Vec3Data>,
    pub rotation: Option<QuatData>,
    pub scale: Option<Vec3Data>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeshData {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub morph_target_ids: Vec<u32>,
    #[serde(default = "default_true")]
    pub visible: bool,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MorphTargetData {
    pub id: u32,
    #[allow(dead_code)]
    pub mesh_id: u32,
    pub name: String,
    #[serde(default)]
    pub host_index: Option<i64>,
    #[serde(default)]
    pub initial_value: f32,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoneData {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub parent_name: Option<String>,
    #[serde(default)]
    pub world_position: Option<Vec3Data>,
    #[serde(default)]
    pub depth: u32,
    #[serde(default)]
    pub rest_transform: Option<TransformData>,
}

#[derive(Deserialize, Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ObjectData {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub is_bone: bool,
    #[serde(default)]
    pub is_camera: bool,
    #[serde(default)]
    pub rest_transform: Option<TransformData>,
}

#[derive(Deserialize, Serialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelData {
    pub meshes: Vec<MeshData>,
    pub morph_targets: Vec<MorphTargetData>,
    pub bones: Vec<BoneData>,
    pub objects: Vec<ObjectData>,
}

fn default_true() -> bool {
    true
}

/// All packed tables the RuntimeCore loads after `configure`.
#[derive(Debug, Default)]
pub struct CompiledTables {
    pub au_morph_bindings: Vec<f32>,
    pub viseme_morph_bindings: Vec<f32>,
    pub mixed_aus: Vec<u32>,
    pub mix_defaults: Vec<(u32, f32)>,
    pub viseme_slot_count: u32,
    pub viseme_jaw_amounts: Vec<f32>,
    pub rest_transforms: Vec<f32>,
    pub composite_axes: Vec<f32>,
    pub translations: Vec<f32>,
    pub jaw_binding: Vec<f32>,
    pub continuum_pairs: HashMap<u32, (u32, bool)>,
    pub viseme_slot_ids: Vec<String>,
}

impl CompiledTables {
    #[cfg(test)]
    pub fn has_runtime_bindings(&self) -> bool {
        !self.au_morph_bindings.is_empty()
            || !self.viseme_morph_bindings.is_empty()
            || !self.composite_axes.is_empty()
            || !self.translations.is_empty()
            || !self.jaw_binding.is_empty()
    }
}

struct VisemeSlot {
    id: String,
    default_jaw_amount: Option<f64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedVisemeBindingTarget {
    pub morph: MorphRef,
    pub weight: f64,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedProfileView {
    pub viseme_slots: Vec<VisemeSlotData>,
    pub viseme_jaw_amounts: Vec<f64>,
    pub viseme_binding_targets: Vec<Vec<ResolvedVisemeBindingTarget>>,
    pub viseme_mesh_category: String,
    pub viseme_mesh_names: Vec<String>,
    pub au_mesh_names: BTreeMap<String, Vec<String>>,
    pub meshes: HashMap<String, MeshInfoData>,
    pub mapping_sections: Vec<MappingSectionData>,
    pub au_face_part_to_mesh_category: HashMap<String, String>,
    pub au_mix_defaults: HashMap<String, f64>,
    pub bone_nodes: HashMap<String, String>,
    pub au_to_bones: HashMap<String, Vec<BoneBindingData>>,
    pub composite_rotations: Vec<CompositeRotationData>,
    pub continuum_pairs: HashMap<String, Option<ContinuumPairData>>,
    pub hair_physics: Option<HairPhysicsData>,
}

pub fn resolve_profile_view(profile: &ProfileData) -> ResolvedProfileView {
    let runtime_slots = viseme_slots(profile);
    let full_slots = resolved_viseme_slots(profile);
    let au_mesh_names = resolved_au_mesh_names(profile);

    ResolvedProfileView {
        viseme_slots: full_slots,
        viseme_jaw_amounts: resolved_viseme_jaw_amounts(profile, &runtime_slots),
        viseme_binding_targets: runtime_slots
            .iter()
            .enumerate()
            .map(|(index, slot)| {
                viseme_binding_targets(profile, slot, index)
                    .into_iter()
                    .map(|(morph, weight)| ResolvedVisemeBindingTarget {
                        morph,
                        weight: weight as f64,
                    })
                    .collect()
            })
            .collect(),
        viseme_mesh_category: viseme_mesh_category(profile),
        viseme_mesh_names: mesh_names_for_visemes(profile),
        au_mesh_names,
        meshes: profile.meshes.clone(),
        mapping_sections: profile.mapping_sections.clone(),
        au_face_part_to_mesh_category: profile.au_face_part_to_mesh_category.clone(),
        au_mix_defaults: profile.au_mix_defaults.clone(),
        bone_nodes: profile.bone_nodes.clone(),
        au_to_bones: profile.au_to_bones.clone(),
        composite_rotations: profile.composite_rotations.clone(),
        continuum_pairs: profile.continuum_pairs.clone(),
        hair_physics: profile.hair_physics.clone(),
    }
}

pub fn compile_tables(profile: &ProfileData, model: &ModelData) -> CompiledTables {
    let resolver = NameResolver::new(profile, model);
    let slots = viseme_slots(profile);

    let mut tables = CompiledTables {
        viseme_slot_count: slots.len() as u32,
        viseme_slot_ids: slots.iter().map(|slot| slot.id.clone()).collect(),
        ..Default::default()
    };

    compile_au_morph_bindings(profile, &resolver, &mut tables);
    compile_viseme_morph_bindings(profile, &resolver, &slots, &mut tables);
    compile_bone_tables(profile, model, &resolver, &mut tables);
    tables.viseme_jaw_amounts = viseme_jaw_amounts(profile, &slots);

    for (au_text, weight) in &profile.au_mix_defaults {
        if let Ok(au_id) = au_text.parse::<u32>() {
            tables.mix_defaults.push((au_id, *weight as f32));
        }
    }

    for (au_text, pair) in &profile.continuum_pairs {
        if let (Ok(au_id), Some(pair)) = (au_text.parse::<u32>(), pair) {
            tables
                .continuum_pairs
                .insert(au_id, (pair.pair_id, pair.is_negative));
        }
    }

    tables
}

fn compile_au_morph_bindings(
    profile: &ProfileData,
    resolver: &NameResolver,
    tables: &mut CompiledTables,
) {
    for (au_text, entry) in &profile.au_to_morphs {
        let Ok(au_id) = au_text.parse::<u32>() else {
            continue;
        };
        let Some(entry) = entry else { continue };

        let mesh_names = mesh_names_for_au(profile, au_id);
        let has_morphs =
            !entry.left.is_empty() || !entry.right.is_empty() || !entry.center.is_empty();
        let has_bones = profile
            .au_to_bones
            .get(au_text)
            .map(|bindings| !bindings.is_empty())
            .unwrap_or(false);
        if has_morphs && has_bones {
            tables.mixed_aus.push(au_id);
        }

        for (side, morphs) in [
            (0u8, &entry.left),
            (1u8, &entry.right),
            (2u8, &entry.center),
        ] {
            for morph in morphs {
                for (mesh_id, morph_target_id) in resolver.resolve_morph(morph, &mesh_names) {
                    tables.au_morph_bindings.extend_from_slice(&[
                        au_id as f32,
                        side as f32,
                        mesh_id as f32,
                        morph_target_id as f32,
                        1.0,
                    ]);
                }
            }
        }
    }
}

fn compile_viseme_morph_bindings(
    profile: &ProfileData,
    resolver: &NameResolver,
    slots: &[VisemeSlot],
    tables: &mut CompiledTables,
) {
    let mesh_names = mesh_names_for_visemes(profile);
    for (index, slot) in slots.iter().enumerate() {
        for (morph, weight) in viseme_binding_targets(profile, slot, index) {
            for (mesh_id, morph_target_id) in resolver.resolve_morph(&morph, &mesh_names) {
                tables.viseme_morph_bindings.extend_from_slice(&[
                    index as f32,
                    mesh_id as f32,
                    morph_target_id as f32,
                    weight as f32,
                ]);
            }
        }
    }
}

fn compile_bone_tables(
    profile: &ProfileData,
    model: &ModelData,
    resolver: &NameResolver,
    tables: &mut CompiledTables,
) {
    let mut referenced: Vec<u32> = Vec::new();
    let mut find_bone = |node_key: &str| -> Option<&BoneData> {
        let bone = resolver.resolve_bone(model, profile, node_key)?;
        if !referenced.contains(&bone.id) {
            referenced.push(bone.id);
        }
        Some(bone)
    };

    let side_for_au = |au_id: u32, bone_id: u32| -> u8 {
        let side = profile
            .au_to_bones
            .get(&au_id.to_string())
            .and_then(|bindings| {
                bindings.iter().find(|candidate| {
                    resolver
                        .resolve_bone(model, profile, &candidate.node)
                        .map(|bone| bone.id == bone_id)
                        .unwrap_or(false)
                })
            })
            .and_then(|binding| binding.side.as_deref());
        match side {
            Some("left") => SIDE_LEFT,
            Some("right") => SIDE_RIGHT,
            _ => SIDE_NONE,
        }
    };

    for composite in &profile.composite_rotations {
        let Some(bone) = find_bone(&composite.node) else {
            continue;
        };
        let bone_id = bone.id;

        // Application order matches the reference runtime: yaw, pitch, roll.
        let axes: [(u8, &Option<RotationAxisData>); 3] = [
            (AXIS_YAW, &composite.yaw),
            (AXIS_PITCH, &composite.pitch),
            (AXIS_ROLL, &composite.roll),
        ];

        for (axis, config) in axes {
            let Some(config) = config else { continue };

            let negative = AuSelector::to_list(&config.negative);
            let positive = AuSelector::to_list(&config.positive);
            let has_directional = !negative.is_empty() && !positive.is_empty();

            let mut value_rows: Vec<[f32; 3]> = Vec::new();
            if has_directional {
                for au_id in &negative {
                    value_rows.push([
                        *au_id as f32,
                        GROUP_NEGATIVE as f32,
                        side_for_au(*au_id, bone_id) as f32,
                    ]);
                }
                for au_id in &positive {
                    value_rows.push([
                        *au_id as f32,
                        GROUP_POSITIVE as f32,
                        side_for_au(*au_id, bone_id) as f32,
                    ]);
                }
            } else {
                for au_id in &config.aus {
                    value_rows.push([
                        *au_id as f32,
                        GROUP_PLAIN as f32,
                        side_for_au(*au_id, bone_id) as f32,
                    ]);
                }
            }

            let mut binding_rows: Vec<[f32; 6]> = Vec::new();
            let mut push_binding_rows = |au_ids: &[u32], group: u8| {
                for au_id in au_ids {
                    let Some(binding) =
                        profile
                            .au_to_bones
                            .get(&au_id.to_string())
                            .and_then(|bindings| {
                                bindings.iter().find(|candidate| {
                                    resolver
                                        .resolve_bone(model, profile, &candidate.node)
                                        .map(|bone| bone.id == bone_id)
                                        .unwrap_or(false)
                                })
                            })
                    else {
                        continue;
                    };
                    let Some(max_degrees) = binding.max_degrees else {
                        continue;
                    };
                    let Some(channel) = rotation_channel(&binding.channel) else {
                        continue;
                    };
                    binding_rows.push([
                        *au_id as f32,
                        group as f32,
                        side_for_au(*au_id, bone_id) as f32,
                        channel as f32,
                        binding.scale as f32,
                        max_degrees as f32,
                    ]);
                }
            };
            push_binding_rows(&negative, GROUP_NEGATIVE);
            push_binding_rows(&positive, GROUP_POSITIVE);
            push_binding_rows(&config.aus, GROUP_PLAIN);

            tables.composite_axes.extend_from_slice(&[
                bone_id as f32,
                axis as f32,
                if has_directional { 1.0 } else { 0.0 },
                value_rows.len() as f32,
                binding_rows.len() as f32,
                0.0,
                0.0,
                0.0,
            ]);
            for row in value_rows {
                tables.composite_axes.extend_from_slice(&row);
            }
            for row in binding_rows {
                tables.composite_axes.extend_from_slice(&row);
            }
        }
    }

    for (au_text, bindings) in &profile.au_to_bones {
        let Ok(au_id) = au_text.parse::<u32>() else {
            continue;
        };
        for binding in bindings {
            let Some(axis) = translation_channel(&binding.channel) else {
                continue;
            };
            let Some(max_units) = binding.max_units else {
                continue;
            };
            let Some(bone) = find_bone(&binding.node) else {
                continue;
            };
            tables.translations.extend_from_slice(&[
                au_id as f32,
                bone.id as f32,
                axis as f32,
                binding.scale as f32,
                max_units as f32,
            ]);
        }
    }

    if let Some(jaw) = auto_viseme_jaw_binding(profile, model, resolver) {
        if let (Some(max_degrees), Some(channel)) =
            (jaw.max_degrees, rotation_channel(&jaw.channel))
        {
            if let Some(bone) = find_bone(&jaw.node) {
                tables.jaw_binding.extend_from_slice(&[
                    bone.id as f32,
                    channel as f32,
                    jaw.scale as f32,
                    max_degrees as f32,
                ]);
            }
        }
    }

    for bone_id in referenced {
        let Some(bone) = model.bones.iter().find(|candidate| candidate.id == bone_id) else {
            continue;
        };
        let position = bone
            .rest_transform
            .as_ref()
            .and_then(|transform| transform.position.as_ref());
        let rotation = bone
            .rest_transform
            .as_ref()
            .and_then(|transform| transform.rotation.as_ref());
        tables.rest_transforms.extend_from_slice(&[
            bone.id as f32,
            position.map(|p| p.x).unwrap_or(0.0),
            position.map(|p| p.y).unwrap_or(0.0),
            position.map(|p| p.z).unwrap_or(0.0),
            rotation.map(|q| q.x).unwrap_or(0.0),
            rotation.map(|q| q.y).unwrap_or(0.0),
            rotation.map(|q| q.z).unwrap_or(0.0),
            rotation.map(|q| q.w).unwrap_or(1.0),
        ]);
    }
}

fn rotation_channel(channel: &str) -> Option<u8> {
    match channel {
        "rx" => Some(0),
        "ry" => Some(1),
        "rz" => Some(2),
        _ => None,
    }
}

fn translation_channel(channel: &str) -> Option<u8> {
    match channel {
        "tx" => Some(0),
        "ty" => Some(1),
        "tz" => Some(2),
        _ => None,
    }
}

fn auto_viseme_jaw_binding<'a>(
    profile: &'a ProfileData,
    model: &ModelData,
    resolver: &NameResolver,
) -> Option<&'a BoneBindingData> {
    let candidates: Vec<&BoneBindingData> = ["103", "26"]
        .iter()
        .filter_map(|au| {
            profile.au_to_bones.get(*au).and_then(|bindings| {
                bindings
                    .iter()
                    .find(|binding| rotation_channel(&binding.channel).is_some())
            })
        })
        .collect();

    candidates
        .iter()
        .find(|binding| {
            resolver
                .resolve_bone(model, profile, &binding.node)
                .is_some()
        })
        .copied()
        .or_else(|| candidates.first().copied())
}

fn viseme_slots(profile: &ProfileData) -> Vec<VisemeSlot> {
    if !profile.viseme_slots.is_empty() {
        let mut slots: Vec<&VisemeSlotData> = profile.viseme_slots.iter().collect();
        slots.sort_by(|a, b| {
            (a.order.unwrap_or(0.0))
                .partial_cmp(&b.order.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        return slots
            .iter()
            .map(|slot| VisemeSlot {
                id: slot.id.clone(),
                default_jaw_amount: slot.default_jaw_amount,
            })
            .collect();
    }

    profile
        .viseme_keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let label = match key {
                MorphRef::Name(name) if !name.is_empty() => name.clone(),
                _ => format!("Viseme {index}"),
            };
            VisemeSlot {
                id: slot_id_from_label(&label, index),
                default_jaw_amount: profile.viseme_jaw_amounts.get(index).copied(),
            }
        })
        .collect()
}

fn resolved_viseme_slots(profile: &ProfileData) -> Vec<VisemeSlotData> {
    if !profile.viseme_slots.is_empty() {
        let mut slots = profile.viseme_slots.clone();
        slots.sort_by(|a, b| {
            (a.order.unwrap_or(0.0))
                .partial_cmp(&b.order.unwrap_or(0.0))
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        return slots;
    }

    profile
        .viseme_keys
        .iter()
        .enumerate()
        .map(|(index, key)| {
            let label = match key {
                MorphRef::Name(name) if !name.is_empty() => name.clone(),
                _ => format!("Viseme {index}"),
            };
            VisemeSlotData {
                id: slot_id_from_label(&label, index),
                label: Some(label),
                order: Some(index as f64),
                default_jaw_amount: profile.viseme_jaw_amounts.get(index).copied(),
                ..Default::default()
            }
        })
        .collect()
}

fn slot_id_from_label(label: &str, index: usize) -> String {
    let mut id = String::new();
    let mut last_dash = true;
    for ch in label.trim().to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            id.push(ch);
            last_dash = false;
        } else if !last_dash {
            id.push('-');
            last_dash = true;
        }
    }
    let id = id.trim_matches('-').to_string();
    if id.is_empty() {
        format!("viseme-{index}")
    } else {
        id
    }
}

fn viseme_jaw_amounts(profile: &ProfileData, slots: &[VisemeSlot]) -> Vec<f32> {
    if slots.is_empty() {
        return profile
            .viseme_jaw_amounts
            .iter()
            .map(|value| *value as f32)
            .collect();
    }
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.default_jaw_amount
                .map(|value| value as f32)
                .or_else(|| {
                    profile
                        .viseme_jaw_amounts
                        .get(index)
                        .map(|value| *value as f32)
                })
                .unwrap_or(0.0)
        })
        .collect()
}

fn resolved_viseme_jaw_amounts(profile: &ProfileData, slots: &[VisemeSlot]) -> Vec<f64> {
    if slots.is_empty() {
        return profile.viseme_jaw_amounts.clone();
    }
    slots
        .iter()
        .enumerate()
        .map(|(index, slot)| {
            slot.default_jaw_amount
                .or_else(|| profile.viseme_jaw_amounts.get(index).copied())
                .unwrap_or(0.0)
        })
        .collect()
}

fn viseme_binding_targets(
    profile: &ProfileData,
    slot: &VisemeSlot,
    index: usize,
) -> Vec<(MorphRef, f64)> {
    let binding = profile.viseme_bindings.get(&slot.id);

    if let Some(binding) = binding {
        if let Some(targets) = &binding.targets {
            let bound: Vec<(MorphRef, f64)> = targets
                .iter()
                .filter_map(|target| {
                    let morph = target.morph.clone()?;
                    if matches!(&morph, MorphRef::Name(name) if name.is_empty()) {
                        return None;
                    }
                    let weight = target
                        .weight
                        .filter(|value| value.is_finite())
                        .map(|value| value.max(0.0))
                        .unwrap_or(1.0);
                    Some((morph, weight))
                })
                .collect();
            if !bound.is_empty() {
                return bound;
            }
        }

        if let Some(morph) = &binding.morph {
            if !matches!(morph, MorphRef::Name(name) if name.is_empty()) {
                return vec![(morph.clone(), 1.0)];
            }
        }
    }

    if let Some(legacy) = profile.viseme_keys.get(index) {
        if !matches!(legacy, MorphRef::Name(name) if name.is_empty()) {
            return vec![(legacy.clone(), 1.0)];
        }
    }

    Vec::new()
}

fn mesh_names_for_au(profile: &ProfileData, au_id: u32) -> Vec<String> {
    let face_part = profile
        .au_info
        .get(&au_id.to_string())
        .and_then(|info| info.face_part.as_ref());
    let category = face_part.and_then(|part| profile.au_face_part_to_mesh_category.get(part));
    if let Some(category) = category {
        return profile
            .morph_to_mesh
            .get(category)
            .cloned()
            .unwrap_or_default();
    }
    profile
        .morph_to_mesh
        .get("face")
        .cloned()
        .unwrap_or_default()
}

fn mesh_names_for_visemes(profile: &ProfileData) -> Vec<String> {
    let category = viseme_mesh_category(profile);
    if let Some(names) = profile.morph_to_mesh.get(&category) {
        return names.clone();
    }
    if profile.viseme_mesh_category.is_some() {
        return Vec::new();
    }
    profile
        .morph_to_mesh
        .get("face")
        .cloned()
        .unwrap_or_default()
}

fn viseme_mesh_category(profile: &ProfileData) -> String {
    profile.viseme_mesh_category.clone().unwrap_or_else(|| {
        if profile.morph_to_mesh.contains_key("viseme") {
            "viseme".to_string()
        } else {
            "face".to_string()
        }
    })
}

fn resolved_au_mesh_names(profile: &ProfileData) -> BTreeMap<String, Vec<String>> {
    let mut au_ids: Vec<u32> = Vec::new();
    for key in profile
        .au_to_morphs
        .keys()
        .chain(profile.au_to_bones.keys())
        .chain(profile.au_info.keys())
    {
        let Ok(au_id) = key.parse::<u32>() else {
            continue;
        };
        if !au_ids.contains(&au_id) {
            au_ids.push(au_id);
        }
    }
    au_ids.sort_unstable();

    au_ids
        .into_iter()
        .map(|au_id| (au_id.to_string(), mesh_names_for_au(profile, au_id)))
        .collect()
}

/// Resolves morph/bone names with the profile prefix/suffix conventions,
/// including the optional suffix regex pattern.
struct NameResolver {
    morph_prefix: String,
    morph_suffix: String,
    suffix_regex: Option<Regex>,
    mesh_by_name: HashMap<String, (u32, Vec<(u32, String, Option<i64>)>)>,
    mesh_names: Vec<String>,
}

impl NameResolver {
    fn new(profile: &ProfileData, model: &ModelData) -> NameResolver {
        let suffix_regex = profile
            .suffix_pattern
            .as_ref()
            .and_then(|pattern| Regex::new(pattern).ok());

        let mut mesh_by_name = HashMap::new();
        let mut mesh_names = Vec::with_capacity(model.meshes.len());
        for mesh in &model.meshes {
            let morphs: Vec<(u32, String, Option<i64>)> = mesh
                .morph_target_ids
                .iter()
                .filter_map(|id| {
                    model
                        .morph_targets
                        .iter()
                        .find(|target| target.id == *id)
                        .map(|target| (target.id, target.name.clone(), target.host_index))
                })
                .collect();
            mesh_names.push(mesh.name.clone());
            mesh_by_name.insert(mesh.name.clone(), (mesh.id, morphs));
        }

        NameResolver {
            morph_prefix: profile.morph_prefix.clone().unwrap_or_default(),
            morph_suffix: profile.morph_suffix.clone().unwrap_or_default(),
            suffix_regex,
            mesh_by_name,
            mesh_names,
        }
    }

    fn resolve_morph(&self, morph: &MorphRef, mesh_names: &[String]) -> Vec<(u32, u32)> {
        let mut result = Vec::new();
        let candidate_names = self.resolve_mesh_names(mesh_names);
        for mesh_name in &candidate_names {
            let Some((mesh_id, morphs)) = self.mesh_by_name.get(mesh_name) else {
                continue;
            };

            let target = match morph {
                MorphRef::Index(host_index) => morphs
                    .iter()
                    .find(|(_, _, candidate)| *candidate == Some(*host_index)),
                MorphRef::Name(key) => self.resolve_morph_by_name(morphs, key),
            };

            if let Some((morph_target_id, _, _)) = target {
                result.push((*mesh_id, *morph_target_id));
            }
        }

        // Authored profiles can predate GLTFLoader's primitive suffixes or omit
        // morphToMesh entirely. Preserve the exact profile while resolving its
        // morph against model content rather than making the host fall back to a
        // different preset. Configured/family matches always take precedence.
        if result.is_empty() {
            for mesh_name in &self.mesh_names {
                if candidate_names.contains(mesh_name) {
                    continue;
                }
                let Some((mesh_id, morphs)) = self.mesh_by_name.get(mesh_name) else {
                    continue;
                };
                let target = match morph {
                    MorphRef::Index(host_index) => morphs
                        .iter()
                        .find(|(_, _, candidate)| *candidate == Some(*host_index)),
                    MorphRef::Name(key) => self.resolve_morph_by_name(morphs, key),
                };
                if let Some((morph_target_id, _, _)) = target {
                    result.push((*mesh_id, *morph_target_id));
                }
            }
        }
        result
    }

    fn resolve_mesh_names(&self, configured_names: &[String]) -> Vec<String> {
        let mut resolved = Vec::new();
        for actual_name in &self.mesh_names {
            if configured_names
                .iter()
                .any(|configured| mesh_names_are_variants(configured, actual_name))
            {
                resolved.push(actual_name.clone());
            }
        }
        resolved
    }

    fn resolve_morph_by_name<'a>(
        &self,
        morphs: &'a [(u32, String, Option<i64>)],
        key: &str,
    ) -> Option<&'a (u32, String, Option<i64>)> {
        let full_name = format!("{}{}{}", self.morph_prefix, key, self.morph_suffix);
        if let Some(exact) = morphs.iter().find(|(_, name, _)| *name == full_name) {
            return Some(exact);
        }

        let regex = self.suffix_regex.as_ref()?;
        morphs.iter().find(|(_, name, _)| {
            name.strip_prefix(&full_name)
                .map(|rest| rest.is_empty() || regex.is_match(rest))
                .unwrap_or(false)
        })
    }

    fn resolve_bone<'a>(
        &self,
        model: &'a ModelData,
        profile: &ProfileData,
        node_key: &str,
    ) -> Option<&'a BoneData> {
        let configured = profile
            .bone_nodes
            .get(node_key)
            .cloned()
            .unwrap_or_else(|| node_key.to_string());
        let prefix = profile.bone_prefix.clone().unwrap_or_default();
        let suffix = profile.bone_suffix.clone().unwrap_or_default();
        let prefixed = if !prefix.is_empty() && !configured.starts_with(&prefix) {
            format!("{prefix}{configured}")
        } else {
            configured.clone()
        };
        let full = if !suffix.is_empty() && !prefixed.ends_with(&suffix) {
            format!("{prefixed}{suffix}")
        } else {
            prefixed
        };

        model
            .bones
            .iter()
            .find(|bone| bone.name == node_key || bone.name == configured || bone.name == full)
    }
}

fn split_mesh_variant(name: &str) -> (&str, Option<u32>) {
    let digits_start = name
        .char_indices()
        .rev()
        .find(|(_, character)| !character.is_ascii_digit())
        .map(|(index, character)| index + character.len_utf8())
        .unwrap_or(0);
    if digits_start == name.len() {
        return (name, None);
    }
    let number = name[digits_start..].parse::<u32>().ok();
    let stem = name[..digits_start].trim_end_matches(['.', '_']);
    (stem, number)
}

fn mesh_names_are_variants(configured: &str, actual: &str) -> bool {
    if configured == actual {
        return true;
    }
    let (configured_stem, configured_number) = split_mesh_variant(configured);
    let (actual_stem, actual_number) = split_mesh_variant(actual);
    if configured_stem != actual_stem {
        return false;
    }
    match configured_number {
        Some(number) => actual_number == Some(number),
        None => actual_number.is_some(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_profile_json() -> &'static str {
        r#"{
            "auToMorphs": {
                "1": { "left": ["BrowUp_L"], "right": ["BrowUp_R"], "center": [] },
                "12": { "left": [], "right": [], "center": ["Smile"] }
            },
            "auToBones": {
                "12": [{ "node": "HEAD", "channel": "ry", "scale": 1, "maxDegrees": 10 }],
                "26": [{ "node": "JAW", "channel": "rz", "scale": 1, "maxDegrees": 30 }]
            },
            "boneNodes": { "HEAD": "Head", "JAW": "Jaw" },
            "morphToMesh": { "face": ["FaceMesh"], "viseme": ["VisemeMesh"] },
            "auMixDefaults": { "12": 0.5 },
            "compositeRotations": [
                { "node": "HEAD", "yaw": { "aus": [12], "axis": "ry" }, "pitch": null, "roll": null }
            ],
            "continuumPairs": { "30": { "pairId": 31, "isNegative": true } },
            "visemeKeys": ["Aah", "Wide"],
            "visemeJawAmounts": [1.0, 0.2]
        }"#
    }

    fn test_model_json() -> &'static str {
        r#"{
            "meshes": [
                { "id": 1, "name": "FaceMesh", "morphTargetIds": [1, 2, 3] },
                { "id": 2, "name": "VisemeMesh", "morphTargetIds": [4, 5] }
            ],
            "morphTargets": [
                { "id": 1, "meshId": 1, "name": "BrowUp_L", "hostIndex": 0 },
                { "id": 2, "meshId": 1, "name": "BrowUp_R", "hostIndex": 1 },
                { "id": 3, "meshId": 1, "name": "Smile", "hostIndex": 2 },
                { "id": 4, "meshId": 2, "name": "Aah", "hostIndex": 0 },
                { "id": 5, "meshId": 2, "name": "Wide", "hostIndex": 1 }
            ],
            "bones": [
                { "id": 1, "name": "Head", "restTransform": { "position": { "x": 0, "y": 1, "z": 0 } } },
                { "id": 2, "name": "Jaw" }
            ]
        }"#
    }

    #[test]
    fn parses_stored_profile_nulls_as_defaults() {
        // Stored character profiles serialize unset fields as explicit null;
        // the JS runtime treated them as `field || fallback`.
        let profile: ProfileData = deserialize_json(
            r#"{
                "auToMorphs": { "12": { "left": null, "right": null, "center": ["Smile"] } },
                "auToBones": null,
                "boneNodes": null,
                "morphToMesh": null,
                "auInfo": null,
                "auMixDefaults": null,
                "compositeRotations": null,
                "continuumPairs": null,
                "visemeKeys": null,
                "visemeJawAmounts": null,
                "meshes": null,
                "annotationRegions": null,
                "disabledRegions": null
            }"#,
            "Invalid profile JSON",
        )
        .unwrap();
        assert!(profile.disabled_regions.is_empty());
        assert!(profile.composite_rotations.is_empty());
        assert!(profile.au_to_bones.is_empty());
        let entry = profile.au_to_morphs.get("12").unwrap().as_ref().unwrap();
        assert!(entry.left.is_empty());
        assert_eq!(entry.center.len(), 1);
    }

    #[test]
    fn compiles_full_profile_from_json() {
        let profile: ProfileData = serde_json::from_str(test_profile_json()).unwrap();
        let model: ModelData = serde_json::from_str(test_model_json()).unwrap();
        let tables = compile_tables(&profile, &model);

        // Three AU morph binding rows: BrowUp_L, BrowUp_R, Smile.
        assert_eq!(tables.au_morph_bindings.len(), 3 * 5);
        // AU 12 has both morphs and bones -> mixed.
        assert_eq!(tables.mixed_aus, vec![12]);
        assert_eq!(tables.mix_defaults, vec![(12, 0.5)]);
        // Two viseme rows on VisemeMesh.
        assert_eq!(tables.viseme_morph_bindings.len(), 2 * 4);
        assert_eq!(tables.viseme_slot_count, 2);
        assert_eq!(tables.viseme_jaw_amounts, vec![1.0, 0.2]);
        // One composite axis block for HEAD yaw.
        assert!(tables.composite_axes.len() >= 8);
        assert_eq!(tables.composite_axes[0], 1.0); // head bone id
                                                   // Jaw binding from AU 26.
        assert_eq!(tables.jaw_binding, vec![2.0, 2.0, 1.0, 30.0]);
        // Continuum pair 30 <-> 31.
        assert_eq!(tables.continuum_pairs.get(&30), Some(&(31, true)));
        // Rest transforms for both referenced bones.
        assert_eq!(tables.rest_transforms.len(), 2 * 8);
    }

    #[test]
    fn resolves_profile_view_without_javascript_profile_helpers() {
        let profile: ProfileData = serde_json::from_str(
            r#"{
                "auToMorphs": {
                    "1": { "left": [], "right": [], "center": ["EyeBlink"] },
                    "12": { "left": [], "right": [], "center": ["Smile"] }
                },
                "auToBones": {
                    "51": [{ "node": "HEAD", "channel": "ry", "scale": 1, "maxDegrees": 30 }]
                },
                "boneNodes": { "HEAD": "Head" },
                "morphToMesh": {
                    "face": ["FaceMesh"],
                    "eye": ["EyeMesh"],
                    "viseme": ["MouthMesh"]
                },
                "auInfo": {
                    "1": { "facePart": "Eye" },
                    "12": { "facePart": "Mouth" }
                },
                "auFacePartToMeshCategory": {
                    "Eye": "eye"
                },
                "visemeSlots": [
                    { "id": "bmp", "label": "BMP", "order": 2, "defaultJawAmount": 0.1 },
                    { "id": "aa", "label": "AA", "order": 1, "defaultJawAmount": 0.8 }
                ],
                "visemeBindings": {
                    "aa": { "targets": [{ "morph": "Aah", "weight": 0.75 }] },
                    "bmp": { "morph": "BMP" }
                },
                "meshes": {
                    "EyeMesh": {
                        "category": "eye",
                        "morphCount": 8,
                        "material": {
                            "renderOrder": -10,
                            "transparent": true,
                            "depthWrite": false
                        }
                    }
                },
                "mappingSections": [
                    { "id": "Eye", "label": "Eye", "kind": "au", "order": 1, "meshCategory": "eye" }
                ]
            }"#,
        )
        .unwrap();

        let view = serde_json::to_value(resolve_profile_view(&profile)).unwrap();

        assert_eq!(view["visemeSlots"][0]["id"], "aa");
        assert_eq!(view["visemeJawAmounts"], serde_json::json!([0.8, 0.1]));
        assert_eq!(
            view["visemeBindingTargets"][0],
            serde_json::json!([{ "morph": "Aah", "weight": 0.75 }])
        );
        assert_eq!(view["visemeMeshCategory"], "viseme");
        assert_eq!(view["visemeMeshNames"], serde_json::json!(["MouthMesh"]));
        assert_eq!(view["auMeshNames"]["1"], serde_json::json!(["EyeMesh"]));
        assert_eq!(view["auMeshNames"]["12"], serde_json::json!(["FaceMesh"]));
        assert_eq!(view["meshes"]["EyeMesh"]["category"], "eye");
        assert_eq!(view["meshes"]["EyeMesh"]["material"]["renderOrder"], -10);
        assert_eq!(view["mappingSections"][0]["meshCategory"], "eye");
    }

    #[test]
    fn resolves_morphs_with_prefix_and_suffix_pattern() {
        let profile: ProfileData = serde_json::from_str(
            r#"{
                "auToMorphs": { "1": { "left": [], "right": [], "center": ["Brow"] } },
                "morphToMesh": { "face": ["FaceMesh"] },
                "morphPrefix": "CC_",
                "suffixPattern": "^\\.\\d+$"
            }"#,
        )
        .unwrap();
        let model: ModelData = serde_json::from_str(
            r#"{
                "meshes": [{ "id": 1, "name": "FaceMesh", "morphTargetIds": [1] }],
                "morphTargets": [{ "id": 1, "meshId": 1, "name": "CC_Brow.001", "hostIndex": 0 }],
                "bones": []
            }"#,
        )
        .unwrap();

        let tables = compile_tables(&profile, &model);
        assert_eq!(tables.au_morph_bindings.len(), 5);
        assert_eq!(tables.au_morph_bindings[3], 1.0); // morph target id resolved
    }

    #[test]
    fn resolves_gltf_primitive_mesh_variants_before_content_fallback() {
        let profile: ProfileData = serde_json::from_str(
            r#"{
                "auToMorphs": { "12": { "left": [], "right": [], "center": ["Smile"] } },
                "morphToMesh": { "face": ["CC_Base_Body"] }
            }"#,
        )
        .unwrap();
        let model: ModelData = serde_json::from_str(
            r#"{
                "meshes": [
                    { "id": 1, "name": "CC_Base_Body_1", "morphTargetIds": [1] },
                    { "id": 2, "name": "CC_Base_Body_2", "morphTargetIds": [2] },
                    { "id": 3, "name": "Eyebrow_1", "morphTargetIds": [3] }
                ],
                "morphTargets": [
                    { "id": 1, "meshId": 1, "name": "Smile", "hostIndex": 0 },
                    { "id": 2, "meshId": 2, "name": "Smile", "hostIndex": 0 },
                    { "id": 3, "meshId": 3, "name": "Smile", "hostIndex": 0 }
                ]
            }"#,
        )
        .unwrap();

        let tables = compile_tables(&profile, &model);
        assert_eq!(tables.au_morph_bindings.len(), 2 * 5);
        assert_eq!(tables.au_morph_bindings[2], 1.0);
        assert_eq!(tables.au_morph_bindings[7], 2.0);
    }

    #[test]
    fn resolves_morph_by_content_when_profile_has_no_mesh_mapping() {
        let profile: ProfileData = serde_json::from_str(
            r#"{
                "auToMorphs": { "12": { "left": [], "right": [], "center": ["Smile"] } }
            }"#,
        )
        .unwrap();
        let model: ModelData = serde_json::from_str(
            r#"{
                "meshes": [{ "id": 4, "name": "CustomFace", "morphTargetIds": [9] }],
                "morphTargets": [{ "id": 9, "meshId": 4, "name": "Smile", "hostIndex": 0 }]
            }"#,
        )
        .unwrap();

        let tables = compile_tables(&profile, &model);
        assert_eq!(tables.au_morph_bindings.len(), 5);
        assert_eq!(tables.au_morph_bindings[2], 4.0);
        assert_eq!(tables.au_morph_bindings[3], 9.0);
    }
}
