//! Typed preset/profile composition.
//!
//! JSON is an ABI transport only. It is deserialized into `ProfileData` and
//! `ProfilePatch` before any merge rule runs, keeping profile semantics in Rust
//! and preventing renderer hosts from becoming a second profile engine.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::sync::OnceLock;

use serde::Deserialize;

use crate::profile::{
    deserialize_json, AnnotationRegionData, AuInfoData, AuMorphEntry, BoneBindingData,
    CompositeRotationData, ContinuumPairData, HairDirectionData,
    HumanoidCharacterizationData,
    HairMorphTargetData, HairMorphTargetValueData, HairMorphTargetsData, HairPhysicsData,
    LineConfigData, MappingSectionData, MarkerStyleData, MeshInfoData,
    MeshMaterialData, MorphRef, ProfileData, ProfileVec3Data, VisemeBindingData, VisemeSlotData,
};

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct ProfilePatch {
    name: Option<String>,
    animal_type: Option<String>,
    emoji: Option<String>,
    au_to_morphs: Option<HashMap<String, Option<AuMorphEntry>>>,
    au_to_bones: Option<HashMap<String, Option<Vec<BoneBindingData>>>>,
    bone_nodes: Option<HashMap<String, Option<String>>>,
    bone_prefix: Option<String>,
    bone_suffix: Option<String>,
    morph_prefix: Option<String>,
    morph_suffix: Option<String>,
    suffix_pattern: Option<String>,
    left_morph_suffixes: Option<Vec<String>>,
    right_morph_suffixes: Option<Vec<String>>,
    morph_to_mesh: Option<HashMap<String, Option<Vec<String>>>>,
    mapping_sections: Option<Vec<MappingSectionData>>,
    au_info: Option<HashMap<String, Option<AuInfoData>>>,
    au_face_part_to_mesh_category: Option<HashMap<String, Option<String>>>,
    au_mix_defaults: Option<HashMap<String, Option<f64>>>,
    composite_rotations: Option<Vec<CompositeRotationData>>,
    continuum_pairs: Option<HashMap<String, Option<ContinuumPairData>>>,
    continuum_labels: Option<HashMap<String, Option<String>>>,
    viseme_keys: Option<Vec<MorphRef>>,
    viseme_system_id: Option<String>,
    viseme_slots: Option<Vec<VisemeSlotData>>,
    viseme_bindings: Option<HashMap<String, Option<VisemeBindingData>>>,
    viseme_jaw_amounts: Option<Vec<f64>>,
    viseme_tongue_targets: Option<Vec<BTreeMap<String, f64>>>,
    viseme_mesh_category: Option<String>,
    eye_mesh_nodes: Option<HashMap<String, String>>,
    meshes: Option<HashMap<String, Option<MeshInfoData>>>,
    annotation_regions: Option<Vec<AnnotationRegionPatch>>,
    disabled_regions: Option<Vec<String>>,
    #[serde(deserialize_with = "optional_nullable")]
    hair_physics: Option<Option<HairPhysicsPatch>>,
    humanoid_characterization: Option<HumanoidCharacterizationData>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct HairPhysicsPatch {
    #[serde(deserialize_with = "optional_nullable")]
    morph_targets: Option<Option<HairMorphTargetsPatch>>,
    #[serde(flatten)]
    values: HairPhysicsData,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct HairMorphTargetsPatch {
    #[serde(deserialize_with = "optional_nullable")]
    sway_left: Option<Option<HairMorphTargetData>>,
    #[serde(deserialize_with = "optional_nullable")]
    sway_right: Option<Option<HairMorphTargetData>>,
    #[serde(deserialize_with = "optional_nullable")]
    sway_front: Option<Option<HairMorphTargetData>>,
    #[serde(deserialize_with = "optional_nullable")]
    fluff_right: Option<Option<HairMorphTargetData>>,
    #[serde(deserialize_with = "optional_nullable")]
    fluff_bottom: Option<Option<HairMorphTargetData>>,
    #[serde(deserialize_with = "optional_nullable")]
    head_up: Option<Option<HashMap<String, Option<HairMorphTargetValueData>>>>,
    #[serde(deserialize_with = "optional_nullable")]
    head_down: Option<Option<HashMap<String, Option<HairMorphTargetValueData>>>>,
    #[serde(flatten)]
    extensions: serde_json::Map<String, serde_json::Value>,
}

impl HairMorphTargetsPatch {
    fn is_empty(&self) -> bool {
        self.sway_left.is_none() && self.sway_right.is_none() && self.sway_front.is_none()
            && self.fluff_right.is_none() && self.fluff_bottom.is_none()
            && self.head_up.is_none() && self.head_down.is_none() && self.extensions.is_empty()
    }
}

fn optional_nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where D: serde::Deserializer<'de>, T: Deserialize<'de> {
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct AnnotationRegionPatch {
    name: String,
    bones: Option<Vec<String>>,
    meshes: Option<Vec<String>>,
    objects: Option<Vec<String>>,
    padding_factor: Option<f64>,
    camera_angle: Option<f64>,
    camera_offset: Option<ProfileVec3Data>,
    parent: Option<String>,
    children: Option<Vec<String>>,
    expand_animation: Option<String>,
    style: Option<MarkerStyleData>,
    group_id: Option<String>,
    is_fallback: Option<bool>,
    custom_position: Option<ProfileVec3Data>,
    #[serde(flatten)]
    extensions: serde_json::Map<String, serde_json::Value>,
}

pub(crate) fn parse_profile_patch(json: &str) -> Result<Option<ProfilePatch>, String> {
    let trimmed = json.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(None);
    }
    deserialize_json(trimmed, "Invalid profile override JSON").map(Some)
}

fn legacy_cc4_profile() -> &'static ProfileData {
    static LEGACY: OnceLock<ProfileData> = OnceLock::new();
    LEGACY.get_or_init(|| {
        serde_json::from_str(include_str!("../assets/legacy/cc4-body-profile.json"))
            .expect("embedded legacy CC4 profile must be valid")
    })
}

pub(crate) fn extend_preset_with_profile(
    base: &ProfileData,
    extension: Option<ProfilePatch>,
) -> ProfileData {
    let Some(mut extension) = extension else {
        return base.clone();
    };

    let legacy = legacy_cc4_profile();
    let current_cc4 = crate::presets::load_profile("cc4").expect("CC4 preset must exist");
    let is_cc4_base = base.humanoid_characterization == current_cc4.humanoid_characterization;
    // Only the exact historical snapshot is upgraded. An authored role change,
    // partial map, or different preset remains authoritative.
    let legacy_cc4 = extension.humanoid_characterization == legacy.humanoid_characterization
        && is_cc4_base;
    if legacy_cc4 {
        extension.humanoid_characterization = base.humanoid_characterization.clone();
        // Preserve literal AU targets while upgrading the old anatomical role map.
        for (role, mapping) in legacy.humanoid_characterization.as_ref().into_iter().flat_map(|mapping| &mapping.roles) {
            let old_node = &mapping.node_key;
            if crate::profile_resolution::node_key(base, role) == old_node { continue; }
            for bindings in extension.au_to_bones.as_mut().into_iter().flat_map(|bindings| bindings.values_mut()).flatten() {
                for binding in bindings { if binding.node == *role { binding.node = old_node.clone(); } }
            }
            for composite in extension.composite_rotations.as_mut().into_iter().flatten() {
                if composite.node == *role { composite.node = old_node.clone(); }
            }
            for pair in extension.continuum_pairs.as_mut().into_iter().flat_map(|pairs| pairs.values_mut()).flatten() {
                if pair.node.as_deref() == Some(role.as_str()) { pair.node = Some(old_node.clone()); }
            }
        }
    }
    let mut merged = base.clone();
    replace_option(&mut merged.name, extension.name);
    replace_option(&mut merged.animal_type, extension.animal_type);
    replace_option(&mut merged.emoji, extension.emoji);
    merge_nullable_map(&mut merged.au_to_morphs, extension.au_to_morphs);
    merge_map(&mut merged.au_to_bones, extension.au_to_bones);
    merge_map(&mut merged.bone_nodes, extension.bone_nodes);
    replace_option(&mut merged.bone_prefix, extension.bone_prefix);
    replace_option(&mut merged.bone_suffix, extension.bone_suffix);
    replace_option(&mut merged.morph_prefix, extension.morph_prefix);
    replace_option(&mut merged.morph_suffix, extension.morph_suffix);
    replace_option(&mut merged.suffix_pattern, extension.suffix_pattern);
    replace_vec(
        &mut merged.left_morph_suffixes,
        extension.left_morph_suffixes,
    );
    replace_vec(
        &mut merged.right_morph_suffixes,
        extension.right_morph_suffixes,
    );
    merge_map(&mut merged.morph_to_mesh, extension.morph_to_mesh);
    replace_vec(&mut merged.mapping_sections, extension.mapping_sections);
    merge_map(&mut merged.au_info, extension.au_info);
    merge_map(
        &mut merged.au_face_part_to_mesh_category,
        extension.au_face_part_to_mesh_category,
    );
    merge_map(&mut merged.au_mix_defaults, extension.au_mix_defaults);
    replace_option(
        &mut merged.humanoid_characterization,
        extension.humanoid_characterization,
    );
    if let Some(mut composites) = extension.composite_rotations {
        let empty_override = composites.is_empty();
        let legacy_actions = legacy.au_to_bones.keys().filter_map(|id| id.parse::<u32>().ok())
            .collect::<HashSet<_>>();
        let legacy_body_nodes = legacy.au_to_bones.iter().filter(|(id,_)| {
            legacy.au_info.get(*id).is_some_and(|info| info.face_area.as_deref()==Some("Body"))
        }).flat_map(|(_,bindings)| bindings).map(|binding| crate::profile_resolution::node_key(legacy, &binding.node)).collect::<HashSet<_>>();
        let legacy_facial_nodes = legacy.composite_rotations.iter()
            .map(|composite| crate::profile_resolution::node_key(legacy, &composite.node))
            .filter(|node| !legacy_body_nodes.contains(node)).collect::<HashSet<_>>();
        // Older saved CC4 profiles contain a snapshot of facial composites.
        // Keep untouched default body nodes while honoring explicit per-node
        // overrides. General facial composite replacement remains unchanged.
        for composite in base.composite_rotations.iter().filter(|_| !empty_override) {
            let node = crate::profile_resolution::node_key(base, &composite.node);
            if is_cc4_base && legacy_facial_nodes.contains(node) { continue; }
            let is_body = merged.au_to_bones.iter().any(|(id,bindings)| {
                merged.au_info.get(id).is_some_and(|info| info.face_area.as_deref()==Some("Body"))
                    && bindings.iter().any(|binding| crate::profile_resolution::configured_bone_name(&merged, &binding.node)
                        == crate::profile_resolution::configured_bone_name(&merged, &composite.node))
            });
            let overridden = composites.iter_mut().find(|candidate|
                crate::profile_resolution::configured_bone_name(&merged, &candidate.node)
                    == crate::profile_resolution::configured_bone_name(&merged, &composite.node));
            if !is_body { continue; }
            if let Some(candidate) = overridden {
                if legacy_cc4 {
                    for (current, default) in [(&mut candidate.pitch, &composite.pitch),
                        (&mut candidate.yaw, &composite.yaw), (&mut candidate.roll, &composite.roll)] {
                        if current.is_none() && default.as_ref().is_some_and(|axis|
                            !axis.aus.is_empty() && axis.aus.iter().all(|id| !legacy_actions.contains(id))) {
                            *current = default.clone();
                        }
                    }
                }
            } else { composites.push(composite.clone()); }
        }
        merged.composite_rotations = composites.into();
    }
    merge_nullable_map(&mut merged.continuum_pairs, extension.continuum_pairs);
    merge_map(&mut merged.continuum_labels, extension.continuum_labels);
    replace_vec(&mut merged.viseme_keys, extension.viseme_keys);
    replace_option(&mut merged.viseme_system_id, extension.viseme_system_id);
    replace_vec(&mut merged.viseme_slots, extension.viseme_slots);
    merge_map(&mut merged.viseme_bindings, extension.viseme_bindings);
    replace_vec(&mut merged.viseme_jaw_amounts, extension.viseme_jaw_amounts);
    replace_vec(
        &mut merged.viseme_tongue_targets,
        extension.viseme_tongue_targets,
    );
    replace_option(
        &mut merged.viseme_mesh_category,
        extension.viseme_mesh_category,
    );
    if let Some(eye_mesh_nodes) = extension.eye_mesh_nodes {
        merged.eye_mesh_nodes = eye_mesh_nodes;
    }
    merge_meshes(&mut merged.meshes, extension.meshes);
    merge_annotation_regions(&mut merged.annotation_regions, extension.annotation_regions);
    replace_vec(&mut merged.disabled_regions, extension.disabled_regions);
    merge_hair_physics(&mut merged.hair_physics, extension.hair_physics);
    merged
}

fn replace_option<T>(base: &mut Option<T>, extension: Option<T>) {
    if extension.is_some() {
        *base = extension;
    }
}

fn replace_vec<T>(base: &mut Vec<T>, extension: Option<Vec<T>>) {
    if let Some(extension) = extension {
        *base = extension;
    }
}

fn merge_map<K, V>(base: &mut HashMap<K, V>, extension: Option<HashMap<K, Option<V>>>)
where
    K: Eq + Hash,
{
    let Some(extension) = extension else {
        return;
    };
    for (key, value) in extension {
        if let Some(value) = value {
            base.insert(key, value);
        }
    }
}

fn merge_nullable_map<K, V>(
    base: &mut HashMap<K, Option<V>>,
    extension: Option<HashMap<K, Option<V>>>,
) where
    K: Eq + Hash,
{
    let Some(extension) = extension else {
        return;
    };
    for (key, value) in extension {
        if let Some(value) = value {
            base.insert(key, Some(value));
        }
    }
}

fn merge_meshes(
    base: &mut HashMap<String, MeshInfoData>,
    extension: Option<HashMap<String, Option<MeshInfoData>>>,
) {
    let Some(extension) = extension else {
        return;
    };
    for (name, patch) in extension {
        let Some(patch) = patch else { continue };
        if let Some(mesh) = base.get_mut(&name) {
            merge_mesh(mesh, patch);
        } else {
            base.insert(name, patch);
        }
    }
}

fn merge_mesh(base: &mut MeshInfoData, extension: MeshInfoData) {
    replace_option(&mut base.name, extension.name);
    replace_option(&mut base.visible, extension.visible);
    replace_option(&mut base.category, extension.category);
    replace_option(&mut base.morph_count, extension.morph_count);
    if let Some(material) = extension.material {
        if let Some(base_material) = base.material.as_mut() {
            merge_material(base_material, material);
        } else {
            base.material = Some(material);
        }
    }
    base.extensions.extend(extension.extensions);
}

fn merge_material(base: &mut MeshMaterialData, extension: MeshMaterialData) {
    replace_option(&mut base.render_order, extension.render_order);
    replace_option(&mut base.transparent, extension.transparent);
    replace_option(&mut base.opacity, extension.opacity);
    replace_option(&mut base.depth_write, extension.depth_write);
    replace_option(&mut base.depth_test, extension.depth_test);
    replace_option(&mut base.blending, extension.blending);
    base.extensions.extend(extension.extensions);
}

fn merge_annotation_regions(
    base: &mut Vec<AnnotationRegionData>,
    extension: Option<Vec<AnnotationRegionPatch>>,
) {
    let Some(extension) = extension else {
        return;
    };
    for patch in extension {
        if let Some(region) = base.iter_mut().find(|region| region.name == patch.name) {
            merge_annotation_region(region, patch);
        } else {
            base.push(annotation_region_from_patch(patch));
        }
    }
}

fn merge_annotation_region(base: &mut AnnotationRegionData, extension: AnnotationRegionPatch) {
    if let Some(value) = extension.bones {
        base.bones = value;
    }
    if let Some(value) = extension.meshes {
        base.meshes = value;
    }
    if let Some(value) = extension.objects {
        base.objects = value;
    }
    replace_option(&mut base.padding_factor, extension.padding_factor);
    replace_option(&mut base.camera_angle, extension.camera_angle);
    if let Some(camera_offset) = extension.camera_offset {
        if let Some(base_offset) = base.camera_offset.as_mut() {
            merge_vec3(base_offset, camera_offset);
        } else {
            base.camera_offset = Some(camera_offset);
        }
    }
    replace_option(&mut base.parent, extension.parent);
    if let Some(value) = extension.children {
        base.children = value;
    }
    replace_option(&mut base.expand_animation, extension.expand_animation);
    if let Some(style) = extension.style {
        if let Some(base_style) = base.style.as_mut() {
            merge_marker_style(base_style, style);
        } else {
            base.style = Some(style);
        }
    }
    replace_option(&mut base.group_id, extension.group_id);
    replace_option(&mut base.is_fallback, extension.is_fallback);
    replace_option(&mut base.custom_position, extension.custom_position);
    base.extensions.extend(extension.extensions);
}

fn annotation_region_from_patch(extension: AnnotationRegionPatch) -> AnnotationRegionData {
    AnnotationRegionData {
        name: extension.name,
        bones: extension.bones.unwrap_or_default(),
        meshes: extension.meshes.unwrap_or_default(),
        objects: extension.objects.unwrap_or_default(),
        padding_factor: extension.padding_factor,
        camera_angle: extension.camera_angle,
        camera_offset: extension.camera_offset,
        parent: extension.parent,
        children: extension.children.unwrap_or_default(),
        expand_animation: extension.expand_animation,
        style: extension.style,
        group_id: extension.group_id,
        is_fallback: extension.is_fallback,
        custom_position: extension.custom_position,
        extensions: extension.extensions,
    }
}

fn merge_vec3(base: &mut ProfileVec3Data, extension: ProfileVec3Data) {
    replace_option(&mut base.x, extension.x);
    replace_option(&mut base.y, extension.y);
    replace_option(&mut base.z, extension.z);
    base.extensions.extend(extension.extensions);
}

fn merge_marker_style(base: &mut MarkerStyleData, extension: MarkerStyleData) {
    replace_option(&mut base.marker_color, extension.marker_color);
    replace_option(&mut base.marker_radius, extension.marker_radius);
    replace_option(&mut base.line_color, extension.line_color);
    replace_option(&mut base.label_color, extension.label_color);
    replace_option(&mut base.label_background, extension.label_background);
    replace_option(&mut base.label_font_size, extension.label_font_size);
    replace_option(&mut base.opacity, extension.opacity);
    replace_option(&mut base.line_direction, extension.line_direction);
    if let Some(line) = extension.line {
        if let Some(base_line) = base.line.as_mut() {
            merge_line_config(base_line, line);
        } else {
            base.line = Some(line);
        }
    }
    base.extensions.extend(extension.extensions);
}

fn merge_line_config(base: &mut LineConfigData, extension: LineConfigData) {
    replace_option(&mut base.style, extension.style);
    replace_option(&mut base.curve, extension.curve);
    replace_option(&mut base.arrow_head, extension.arrow_head);
    replace_option(&mut base.thickness, extension.thickness);
    replace_option(&mut base.length, extension.length);
    base.extensions.extend(extension.extensions);
}

fn merge_hair_physics(base: &mut Option<HairPhysicsData>, extension: Option<Option<HairPhysicsPatch>>) {
    let Some(extension) = extension else {
        return;
    };
    let Some(patch) = extension else {
        // Keep a complete disabled/empty mapping in the resolved profile so a
        // subsequent save and preset expansion cannot restore cleared targets.
        *base = Some(HairPhysicsData {
            enabled: Some(false),
            morph_targets: Some(HairMorphTargetsData::default()),
            ..Default::default()
        });
        return;
    };
    let base = base.get_or_insert_with(HairPhysicsData::default);
    let extension = patch.values;
    replace_option(&mut base.enabled, extension.enabled);
    replace_option(&mut base.stiffness, extension.stiffness);
    replace_option(&mut base.damping, extension.damping);
    replace_option(&mut base.inertia, extension.inertia);
    replace_option(&mut base.gravity, extension.gravity);
    replace_option(&mut base.response_scale, extension.response_scale);
    replace_option(&mut base.idle_sway_amount, extension.idle_sway_amount);
    replace_option(&mut base.idle_sway_speed, extension.idle_sway_speed);
    replace_option(&mut base.wind_strength, extension.wind_strength);
    replace_option(&mut base.wind_direction_x, extension.wind_direction_x);
    replace_option(&mut base.wind_direction_z, extension.wind_direction_z);
    replace_option(&mut base.wind_turbulence, extension.wind_turbulence);
    replace_option(&mut base.wind_frequency, extension.wind_frequency);
    replace_option(&mut base.idle_clip_duration, extension.idle_clip_duration);
    replace_option(
        &mut base.impulse_clip_duration,
        extension.impulse_clip_duration,
    );
    if let Some(direction) = extension.direction {
        if let Some(base_direction) = base.direction.as_mut() {
            merge_hair_direction(base_direction, direction);
        } else {
            base.direction = Some(direction);
        }
    }
    merge_hair_morph_targets(&mut base.morph_targets, patch.morph_targets);
    base.extensions.extend(extension.extensions);
}

fn merge_hair_direction(base: &mut HairDirectionData, extension: HairDirectionData) {
    replace_option(&mut base.yaw_sign, extension.yaw_sign);
    replace_option(&mut base.pitch_sign, extension.pitch_sign);
    base.extensions.extend(extension.extensions);
}

fn merge_hair_morph_targets(base: &mut Option<HairMorphTargetsData>, patch: Option<Option<HairMorphTargetsPatch>>) {
    let Some(patch) = patch else { return };
    let Some(extension) = patch else {
        *base = Some(HairMorphTargetsData::default());
        return;
    };
    if extension.is_empty() {
        *base = Some(HairMorphTargetsData::default());
        return;
    }
    let base = base.get_or_insert_with(HairMorphTargetsData::default);
    if let Some(value) = extension.sway_left { base.sway_left = value; }
    if let Some(value) = extension.sway_right { base.sway_right = value; }
    if let Some(value) = extension.sway_front { base.sway_front = value; }
    if let Some(value) = extension.fluff_right { base.fluff_right = value; }
    if let Some(value) = extension.fluff_bottom { base.fluff_bottom = value; }
    merge_hair_target_group(&mut base.head_up, extension.head_up);
    merge_hair_target_group(&mut base.head_down, extension.head_down);
    base.extensions.extend(extension.extensions);
}

fn merge_hair_target_group(
    base: &mut HashMap<String, Option<HairMorphTargetValueData>>,
    patch: Option<Option<HashMap<String, Option<HairMorphTargetValueData>>>>,
) {
    match patch {
        None => {},
        Some(None) => base.clear(),
        Some(Some(values)) if values.is_empty() => base.clear(),
        // Keep per-target tombstones in saved profile data. Runtime hair
        // normalization removes them after preset composition is complete.
        Some(Some(values)) => base.extend(values),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn merge(base: Value, extension: Value) -> Value {
        let base: ProfileData = serde_json::from_value(base).unwrap();
        let extension: ProfilePatch = serde_json::from_value(extension).unwrap();
        serde_json::to_value(extend_preset_with_profile(&base, Some(extension))).unwrap()
    }

    #[test]
    fn extension_scalars_win_and_maps_merge_by_key() {
        let merged = merge(
            json!({
                "name": "Base",
                "morphPrefix": "CC_",
                "auToMorphs": { "1": { "center": ["A"] }, "2": { "center": ["B"] } },
                "visemeKeys": ["Aah", "Wide"]
            }),
            json!({
                "name": "Extended",
                "auToMorphs": { "2": { "center": ["B2"] }, "3": { "center": ["C"] } },
                "visemeKeys": ["Ooh"]
            }),
        );

        assert_eq!(merged["name"], "Extended");
        assert_eq!(merged["morphPrefix"], "CC_");
        assert_eq!(merged["auToMorphs"]["1"]["center"][0], "A");
        assert_eq!(merged["auToMorphs"]["2"]["center"][0], "B2");
        assert_eq!(merged["auToMorphs"]["3"]["center"][0], "C");
        assert_eq!(merged["visemeKeys"], json!(["Ooh"]));
    }

    #[test]
    fn preset_articulation_survives_legacy_viseme_slot_overrides() {
        let base = serde_json::json!({
            "visemeSlots": [
                { "id": "ah", "label": "Ah", "order": 0, "defaultJawAmount": 0.8 }
            ],
            "visemeJawAmounts": [0.8],
            "visemeTongueTargets": [{ "37": 0.42, "76": 0.44 }]
        });
        let extension = serde_json::json!({
            "visemeSlots": [
                { "id": "ah", "label": "Ah", "order": 0, "defaultJawAmount": 0.6 }
            ]
        });
        let merged = merge(base, extension);

        assert_eq!(merged["visemeSlots"][0]["defaultJawAmount"], 0.6);
        assert_eq!(merged["visemeJawAmounts"], json!([0.8]));
        assert_eq!(merged["visemeTongueTargets"][0]["37"], 0.42);
    }

    #[test]
    fn annotation_regions_merge_by_name_with_nested_fields() {
        let merged = merge(
            json!({
                "annotationRegions": [
                    {
                        "name": "head",
                        "meshes": ["A"],
                        "cameraOffset": { "x": 1, "y": 2 },
                        "style": { "labelColor": "red", "line": { "thickness": 1 } }
                    },
                    { "name": "jaw", "meshes": ["B"] }
                ]
            }),
            json!({
                "annotationRegions": [
                    {
                        "name": "head",
                        "cameraOffset": { "y": 9 },
                        "style": { "line": { "length": 2 } }
                    },
                    { "name": "brow", "meshes": ["C"] }
                ]
            }),
        );

        let regions = merged["annotationRegions"].as_array().unwrap();
        assert_eq!(regions.len(), 3);
        let head = &regions[0];
        assert_eq!(head["meshes"], json!(["A"]));
        assert_eq!(head["cameraOffset"], json!({ "x": 1.0, "y": 9.0 }));
        assert_eq!(head["style"]["labelColor"], "red");
        assert_eq!(head["style"]["line"]["thickness"], 1.0);
        assert_eq!(head["style"]["line"]["length"], 2.0);
        assert_eq!(regions[2]["name"], "brow");
    }

    #[test]
    fn hair_physics_deep_merges_direction_and_morph_targets() {
        let merged = merge(
            json!({
                "hairPhysics": {
                    "windStrength": 0.1,
                    "direction": { "yawSign": 1 },
                    "morphTargets": {
                        "headUp": { "a": { "value": 1, "axis": "pitch" } },
                        "headDown": { "b": { "value": 1, "axis": "pitch" } }
                    }
                }
            }),
            json!({
                "hairPhysics": {
                    "windStrength": 0.3,
                    "direction": { "pitchSign": -1 },
                    "morphTargets": {
                        "headUp": { "c": { "value": 2, "axis": "pitch" } }
                    }
                }
            }),
        );

        let hair = &merged["hairPhysics"];
        assert_eq!(hair["windStrength"], 0.3);
        assert_eq!(hair["direction"]["yawSign"], 1);
        assert_eq!(hair["direction"]["pitchSign"], -1);
        assert_eq!(hair["morphTargets"]["headUp"]["a"]["value"], 1.0);
        assert_eq!(hair["morphTargets"]["headUp"]["c"]["value"], 2.0);
        assert_eq!(hair["morphTargets"]["headDown"]["b"]["value"], 1.0);
        let cleared = merge(merged, json!({"hairPhysics":{"morphTargets":{"headUp":{"a":null}}}}));
        assert!(cleared["hairPhysics"]["morphTargets"]["headUp"]["a"].is_null());
        assert_eq!(cleared["hairPhysics"]["morphTargets"]["headUp"]["c"]["value"], 2.0);
    }

    #[test]
    fn preset_hair_overrides_clear_mappings_without_restoring_them_on_reload() {
        let base = crate::presets::load_profile("cc4").unwrap();
        for patch in [
            json!({"hairPhysics":{"morphTargets":{}}}),
            json!({"hairPhysics":{"morphTargets":null}}),
            json!({"hairPhysics":null}),
        ] {
            let mut core = crate::runtime::RuntimeCore::new(0);
            core.configure_with_preset("cc4", &patch.to_string(), "{}").unwrap();
            let direct = core.get_hair_config_json().unwrap();
            let merged = extend_preset_with_profile(base, parse_profile_patch(&patch.to_string()).unwrap());
            let saved = serde_json::to_string(&merged).unwrap();
            core.configure_with_preset("cc4", &saved, "{}").unwrap();
            for resolved in [direct, core.get_hair_config_json().unwrap()] {
                let normalized: Value = serde_json::from_str(&resolved).unwrap();
                let config = crate::hair_curves::normalize_config(
                    &crate::hair_curves::HairPlaybackConfig::default(), &normalized
                ).unwrap();
                assert!(crate::hair_curves::configured_targets(&config).is_empty());
            }
        }

        for head_down in [json!({}), Value::Null] {
            let patch = json!({"hairPhysics":{"morphTargets":{"headDown":head_down,"swayLeft":null}}});
            let merged = extend_preset_with_profile(base, parse_profile_patch(&patch.to_string()).unwrap());
            let saved = serde_json::to_string(&merged).unwrap();
            let mut core = crate::runtime::RuntimeCore::new(0);
            core.configure_with_preset("cc4", &saved, "{}").unwrap();
            let normalized: Value = serde_json::from_str(&core.get_hair_config_json().unwrap()).unwrap();
            assert!(normalized["morphTargets"]["headDown"].as_object().unwrap().is_empty());
            assert!(normalized["morphTargets"]["swayLeft"].is_null());
            assert!(normalized["morphTargets"]["swayRight"].is_string());
            assert!(!normalized["morphTargets"]["headUp"].as_object().unwrap().is_empty());
        }

        let preset_hair = serde_json::to_value(&base.hair_physics).unwrap();
        for group in ["headUp", "headDown"] {
            let targets = preset_hair["morphTargets"][group].as_object().unwrap();
            let mut names = targets.keys();
            let removed = names.next().unwrap();
            let retained = names.next().unwrap();
            let patch = json!({"hairPhysics":{"morphTargets":{(group):{(removed):null}}}});
            let merged = extend_preset_with_profile(base, parse_profile_patch(&patch.to_string()).unwrap());
            let saved = serde_json::to_string(&merged).unwrap();
            let mut core = crate::runtime::RuntimeCore::new(0);
            core.configure_with_preset("cc4", &saved, "{}").unwrap();
            let normalized: Value = serde_json::from_str(&core.get_hair_config_json().unwrap()).unwrap();
            assert!(normalized["morphTargets"][group].get(removed).is_none());
            assert!(normalized["morphTargets"][group].get(retained).is_some());
        }
    }

    #[test]
    fn mesh_entries_preserve_category_and_nested_material_defaults() {
        let merged = merge(
            json!({
                "meshes": {
                    "EyeOcclusion": {
                        "category": "eyeOcclusion",
                        "morphCount": 94,
                        "material": {
                            "renderOrder": 2,
                            "transparent": true,
                            "depthWrite": true
                        }
                    }
                }
            }),
            json!({
                "meshes": {
                    "EyeOcclusion": { "material": { "opacity": 0.5 } }
                }
            }),
        );

        assert_eq!(merged["meshes"]["EyeOcclusion"]["category"], "eyeOcclusion");
        assert_eq!(merged["meshes"]["EyeOcclusion"]["morphCount"], 94);
        assert_eq!(
            merged["meshes"]["EyeOcclusion"]["material"]["renderOrder"],
            2
        );
        assert_eq!(merged["meshes"]["EyeOcclusion"]["material"]["opacity"], 0.5);
    }

    #[test]
    fn null_map_entries_do_not_erase_preset_values() {
        let merged = merge(
            json!({ "boneNodes": { "HEAD": "Head" } }),
            json!({ "boneNodes": { "HEAD": null } }),
        );
        assert_eq!(merged["boneNodes"]["HEAD"], "Head");
    }

    #[test]
    fn humanoid_characterization_replaces_as_one_versioned_contract() {
        let merged = merge(
            json!({
                "humanoidCharacterization": {
                    "schemaVersion": 1,
                    "standard": "VRMC_vrm-1.0",
                    "status": "incomplete",
                    "roles": { "head": { "nodeKey": "HEAD" } }
                }
            }),
            json!({
                "humanoidCharacterization": {
                    "schemaVersion": 1,
                    "standard": "VRMC_vrm-1.0",
                    "status": "characterized",
                    "roles": { "head": { "nodeKey": "HEAD_2" } }
                }
            }),
        );
        assert_eq!(merged["humanoidCharacterization"]["status"], "characterized");
        assert_eq!(merged["humanoidCharacterization"]["roles"]["head"]["nodeKey"], "HEAD_2");
    }
}
