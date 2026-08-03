//! Typed preset/profile composition.
//!
//! JSON is an ABI transport only. It is deserialized into `ProfileData` and
//! `ProfilePatch` before any merge rule runs, keeping profile semantics in Rust
//! and preventing renderer hosts from becoming a second profile engine.

use std::collections::HashMap;
use std::hash::Hash;

use serde::Deserialize;

use crate::profile::{
    deserialize_json, AnnotationRegionData, AuInfoData, AuMorphEntry, BoneBindingData,
    CompositeRotationData, ContinuumPairData, HairDirectionData, HairMorphTargetsData,
    HairPhysicsData, LineConfigData, MappingSectionData, MarkerStyleData, MeshInfoData,
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
    viseme_mesh_category: Option<String>,
    eye_mesh_nodes: Option<HashMap<String, String>>,
    meshes: Option<HashMap<String, Option<MeshInfoData>>>,
    annotation_regions: Option<Vec<AnnotationRegionPatch>>,
    disabled_regions: Option<Vec<String>>,
    hair_physics: Option<HairPhysicsData>,
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

pub(crate) fn extend_preset_with_profile(
    base: &ProfileData,
    extension: Option<ProfilePatch>,
) -> ProfileData {
    let Some(extension) = extension else {
        return base.clone();
    };

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
    replace_vec(
        &mut merged.composite_rotations,
        extension.composite_rotations,
    );
    merge_nullable_map(&mut merged.continuum_pairs, extension.continuum_pairs);
    merge_map(&mut merged.continuum_labels, extension.continuum_labels);
    replace_vec(&mut merged.viseme_keys, extension.viseme_keys);
    replace_option(&mut merged.viseme_system_id, extension.viseme_system_id);
    replace_vec(&mut merged.viseme_slots, extension.viseme_slots);
    merge_map(&mut merged.viseme_bindings, extension.viseme_bindings);
    replace_vec(&mut merged.viseme_jaw_amounts, extension.viseme_jaw_amounts);
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

fn merge_hair_physics(base: &mut Option<HairPhysicsData>, extension: Option<HairPhysicsData>) {
    let Some(extension) = extension else {
        return;
    };
    let Some(base) = base.as_mut() else {
        *base = Some(extension);
        return;
    };
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
    if let Some(morph_targets) = extension.morph_targets {
        if let Some(base_targets) = base.morph_targets.as_mut() {
            merge_hair_morph_targets(base_targets, morph_targets);
        } else {
            base.morph_targets = Some(morph_targets);
        }
    }
    base.extensions.extend(extension.extensions);
}

fn merge_hair_direction(base: &mut HairDirectionData, extension: HairDirectionData) {
    replace_option(&mut base.yaw_sign, extension.yaw_sign);
    replace_option(&mut base.pitch_sign, extension.pitch_sign);
    base.extensions.extend(extension.extensions);
}

fn merge_hair_morph_targets(base: &mut HairMorphTargetsData, extension: HairMorphTargetsData) {
    replace_option(&mut base.sway_left, extension.sway_left);
    replace_option(&mut base.sway_right, extension.sway_right);
    replace_option(&mut base.sway_front, extension.sway_front);
    replace_option(&mut base.fluff_right, extension.fluff_right);
    replace_option(&mut base.fluff_bottom, extension.fluff_bottom);
    base.head_up.extend(extension.head_up);
    base.head_down.extend(extension.head_down);
    base.extensions.extend(extension.extensions);
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
}
