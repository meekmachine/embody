//! Profile + model descriptor ingestion and binding compilation.
//!
//! The core consumes the same profile JSON hosts already use and compiles all
//! runtime binding tables internally: AU/viseme morph bindings, composite
//! rotation axes, bone translations, jaw binding, and rest transforms. Hosts
//! only pass data in; no mapping resolution happens in JavaScript.

use std::collections::HashMap;

use regex_lite::Regex;
use serde::Deserialize;

use crate::bones::{
    AXIS_PITCH, AXIS_ROLL, AXIS_YAW, GROUP_NEGATIVE, GROUP_PLAIN, GROUP_POSITIVE, SIDE_LEFT,
    SIDE_NONE, SIDE_RIGHT,
};

#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum MorphRef {
    Index(i64),
    Name(String),
}

#[derive(Deserialize, Debug, Clone)]
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

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AuMorphEntry {
    pub left: Vec<MorphRef>,
    pub right: Vec<MorphRef>,
    pub center: Vec<MorphRef>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoneBindingData {
    pub node: String,
    pub channel: String,
    #[serde(default = "default_scale")]
    pub scale: f32,
    #[serde(default)]
    pub max_degrees: Option<f32>,
    #[serde(default)]
    pub max_units: Option<f32>,
    #[serde(default)]
    pub side: Option<String>,
}

fn default_scale() -> f32 {
    1.0
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RotationAxisData {
    #[serde(default)]
    pub aus: Vec<u32>,
    #[serde(default)]
    pub negative: Option<AuSelector>,
    #[serde(default)]
    pub positive: Option<AuSelector>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CompositeRotationData {
    pub node: String,
    #[serde(default)]
    pub pitch: Option<RotationAxisData>,
    #[serde(default)]
    pub yaw: Option<RotationAxisData>,
    #[serde(default)]
    pub roll: Option<RotationAxisData>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ContinuumPairData {
    pub pair_id: u32,
    #[serde(default)]
    pub is_negative: bool,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct AuInfoData {
    pub face_part: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeSlotData {
    pub id: String,
    #[serde(default)]
    pub order: Option<f32>,
    #[serde(default)]
    pub default_jaw_amount: Option<f32>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeBindingTargetData {
    pub morph: Option<MorphRef>,
    pub weight: Option<f32>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct VisemeBindingData {
    pub morph: Option<MorphRef>,
    pub targets: Option<Vec<VisemeBindingTargetData>>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ProfileData {
    pub au_to_morphs: HashMap<String, Option<AuMorphEntry>>,
    pub au_to_bones: HashMap<String, Vec<BoneBindingData>>,
    pub bone_nodes: HashMap<String, String>,
    pub bone_prefix: Option<String>,
    pub bone_suffix: Option<String>,
    pub morph_prefix: Option<String>,
    pub morph_suffix: Option<String>,
    pub suffix_pattern: Option<String>,
    pub morph_to_mesh: HashMap<String, Vec<String>>,
    pub au_info: HashMap<String, AuInfoData>,
    pub au_face_part_to_mesh_category: HashMap<String, String>,
    pub au_mix_defaults: HashMap<String, f32>,
    pub composite_rotations: Vec<CompositeRotationData>,
    pub continuum_pairs: HashMap<String, Option<ContinuumPairData>>,
    pub viseme_keys: Vec<MorphRef>,
    pub viseme_slots: Vec<VisemeSlotData>,
    pub viseme_bindings: HashMap<String, VisemeBindingData>,
    pub viseme_jaw_amounts: Vec<f32>,
    pub viseme_mesh_category: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Vec3Data {
    pub x: f32,
    pub y: f32,
    pub z: f32,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct QuatData {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TransformData {
    pub position: Option<Vec3Data>,
    pub rotation: Option<QuatData>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MeshData {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub morph_target_ids: Vec<u32>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MorphTargetData {
    pub id: u32,
    #[allow(dead_code)]
    pub mesh_id: u32,
    pub name: String,
    #[serde(default)]
    pub host_index: Option<i64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BoneData {
    pub id: u32,
    pub name: String,
    #[serde(default)]
    pub rest_transform: Option<TransformData>,
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct ModelData {
    pub meshes: Vec<MeshData>,
    pub morph_targets: Vec<MorphTargetData>,
    pub bones: Vec<BoneData>,
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

struct VisemeSlot {
    id: String,
    default_jaw_amount: Option<f32>,
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
            tables.mix_defaults.push((au_id, *weight));
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

        for (side, morphs) in [(0u8, &entry.left), (1u8, &entry.right), (2u8, &entry.center)] {
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
                    weight,
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

    let side_for_au = |au_id: u32, node_key: &str| -> u8 {
        let side = profile
            .au_to_bones
            .get(&au_id.to_string())
            .and_then(|bindings| bindings.iter().find(|candidate| candidate.node == node_key))
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
                        side_for_au(*au_id, &composite.node) as f32,
                    ]);
                }
                for au_id in &positive {
                    value_rows.push([
                        *au_id as f32,
                        GROUP_POSITIVE as f32,
                        side_for_au(*au_id, &composite.node) as f32,
                    ]);
                }
            } else {
                for au_id in &config.aus {
                    value_rows.push([
                        *au_id as f32,
                        GROUP_PLAIN as f32,
                        side_for_au(*au_id, &composite.node) as f32,
                    ]);
                }
            }

            let mut binding_rows: Vec<[f32; 6]> = Vec::new();
            let mut push_binding_rows = |au_ids: &[u32], group: u8| {
                for au_id in au_ids {
                    let Some(binding) = profile
                        .au_to_bones
                        .get(&au_id.to_string())
                        .and_then(|bindings| {
                            bindings.iter().find(|candidate| candidate.node == composite.node)
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
                        side_for_au(*au_id, &composite.node) as f32,
                        channel as f32,
                        binding.scale,
                        max_degrees,
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
                binding.scale,
                max_units,
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
                    jaw.scale,
                    max_degrees,
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
        .find(|binding| resolver.resolve_bone(model, profile, &binding.node).is_some())
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
) -> Vec<(MorphRef, f32)> {
    let binding = profile.viseme_bindings.get(&slot.id);

    if let Some(binding) = binding {
        if let Some(targets) = &binding.targets {
            let bound: Vec<(MorphRef, f32)> = targets
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
    let category =
        face_part.and_then(|part| profile.au_face_part_to_mesh_category.get(part));
    if let Some(category) = category {
        return profile
            .morph_to_mesh
            .get(category)
            .cloned()
            .unwrap_or_default();
    }
    profile.morph_to_mesh.get("face").cloned().unwrap_or_default()
}

fn mesh_names_for_visemes(profile: &ProfileData) -> Vec<String> {
    let category = profile
        .viseme_mesh_category
        .clone()
        .unwrap_or_else(|| {
            if profile.morph_to_mesh.contains_key("viseme") {
                "viseme".to_string()
            } else {
                "face".to_string()
            }
        });
    if let Some(names) = profile.morph_to_mesh.get(&category) {
        return names.clone();
    }
    if profile.viseme_mesh_category.is_some() {
        return Vec::new();
    }
    profile.morph_to_mesh.get("face").cloned().unwrap_or_default()
}

/// Resolves morph/bone names with the profile prefix/suffix conventions,
/// including the optional suffix regex pattern.
struct NameResolver {
    morph_prefix: String,
    morph_suffix: String,
    suffix_regex: Option<Regex>,
    mesh_by_name: HashMap<String, (u32, Vec<(u32, String, Option<i64>)>)>,
}

impl NameResolver {
    fn new(profile: &ProfileData, model: &ModelData) -> NameResolver {
        let suffix_regex = profile
            .suffix_pattern
            .as_ref()
            .and_then(|pattern| Regex::new(pattern).ok());

        let mut mesh_by_name = HashMap::new();
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
            mesh_by_name.insert(mesh.name.clone(), (mesh.id, morphs));
        }

        NameResolver {
            morph_prefix: profile.morph_prefix.clone().unwrap_or_default(),
            morph_suffix: profile.morph_suffix.clone().unwrap_or_default(),
            suffix_regex,
            mesh_by_name,
        }
    }

    fn resolve_morph(&self, morph: &MorphRef, mesh_names: &[String]) -> Vec<(u32, u32)> {
        let mut result = Vec::new();
        for mesh_name in mesh_names {
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
        result
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

        model.bones.iter().find(|bone| {
            bone.name == node_key || bone.name == configured || bone.name == full
        })
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
}
