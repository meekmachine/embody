//! Body-control descriptors share FACS action bindings and evaluation. This
//! module resolves authoring metadata; it never applies frame writes.

use serde_json::{json, Value};

use crate::profile::{mesh_names_for_au, AuMorphEntry, ModelData, NameResolver, ProfileData};

/// A binding may target a standard role. The characterization selects its
/// profile node key, whose existing prefix/suffix mapping selects the rig bone.
pub(crate) fn node_key<'a>(profile: &'a ProfileData, node: &'a str) -> &'a str {
    profile.humanoid_characterization.as_ref()
        .filter(|mapping| mapping.schema_version == 1 && mapping.standard == "VRMC_vrm-1.0")
        .and_then(|mapping| mapping.roles.get(node))
        .map(|role| role.node_key.as_str())
        .unwrap_or(node)
}

pub(crate) fn exact_bone_name<'a>(profile: &'a ProfileData, node: &str) -> Option<&'a str> {
    let mapping = profile.humanoid_characterization.as_ref()?;
    let role = mapping.roles.get(node).or_else(|| mapping.roles.values().find(|role| role.node_key == node))?;
    let exact = role.exact_bone_name.as_deref()?;
    (profile.bone_nodes.get(&role.node_key).map(String::as_str) == Some(exact)).then_some(exact)
}

pub(crate) fn configured_bone_name(profile: &ProfileData, node: &str) -> String {
    if let Some(exact) = exact_bone_name(profile, node) { return exact.to_string(); }
    let key = node_key(profile, node);
    let base = profile.bone_nodes.get(key).map(String::as_str).unwrap_or(key);
    let prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let suffix = profile.bone_suffix.as_deref().unwrap_or("");
    format!("{}{}{}", if base.starts_with(prefix) { "" } else { prefix }, base,
        if base.ends_with(suffix) { "" } else { suffix })
}

pub(crate) fn resolve(profile: &ProfileData, model: Option<&ModelData>) -> Value {
    let resolver = model.map(|model| NameResolver::new(profile, model));
    let mut controls: Vec<_> = profile.body_controls.iter().collect();
    controls.sort_by(|(id_a, a), (id_b, b)| a.order.cmp(&b.order).then(id_a.cmp(id_b)));
    Value::Array(controls.into_iter().map(|(id, control)| {
        let mut au_ids = vec![control.au_id];
        if let Some(negative) = control.negative_au_id {
            if negative != control.au_id { au_ids.push(negative); }
        }
        let mut diagnostics = Vec::<String>::new();
        let mut bones = Vec::new();
        let mut morphs = AuMorphEntry::default();
        let mut meshes = Vec::new();
        let mut has_bones = false;
        let mut has_morphs = false;
        if control.label.trim().is_empty() { diagnostics.push("Control has no label.".into()); }
        for role in &control.roles {
            if node_key(profile, role) == role && !profile.bone_nodes.contains_key(role) {
                diagnostics.push(format!("Role {role} has no humanoid bone mapping."));
            }
        }
        for au in &au_ids {
            let key = au.to_string();
            let mesh_names = mesh_names_for_au(profile, *au);
            for mesh in &mesh_names { if !meshes.contains(mesh) { meshes.push(mesh.clone()); } }
            for binding in profile.au_to_bones.get(&key).into_iter().flatten() {
                let resolved = model.zip(resolver.as_ref())
                    .and_then(|(model, resolver)| resolver.resolve_bone(model, profile, &binding.node));
                let mut bound = serde_json::to_value(binding).unwrap_or(Value::Null);
                bound["auId"] = json!(au);
                bound["boneName"] = json!(resolved.map(|bone| bone.name.clone())
                    .unwrap_or_else(|| configured_bone_name(profile, &binding.node)));
                let rotational = matches!(binding.channel.as_str(), "rx" | "ry" | "rz");
                let composite_exists = !rotational || profile.composite_rotations.iter().any(|composite| {
                    configured_bone_name(profile, &composite.node) == configured_bone_name(profile, &binding.node)
                        && [&composite.pitch, &composite.yaw, &composite.roll].into_iter().flatten()
                            .any(|axis| axis.aus.contains(au) || [&axis.negative, &axis.positive].into_iter().flatten().any(|selector| {
                                match selector { crate::profile::AuSelector::One(id) => id == au,
                                    crate::profile::AuSelector::Many(ids) => ids.contains(au) }
                            }))
                });
                if !composite_exists { diagnostics.push(format!("Action {au}: {} has no composite rotation.", binding.node)); }
                if model.is_some() && resolved.is_none() { diagnostics.push(format!("Action {au}: bone {} is absent from the model.", binding.node)); }
                has_bones |= composite_exists && (model.is_none() || resolved.is_some());
                bones.push(bound);
            }
            if let Some(Some(entry)) = profile.au_to_morphs.get(&key) {
                for (side, targets) in [("left", &entry.left), ("right", &entry.right), ("center", &entry.center)] {
                    for target in targets {
                        let exists = resolver.as_ref().map(|r| !r.resolve_au_morph(profile, *au, target).is_empty()).unwrap_or(true);
                        has_morphs |= exists;
                        if !exists { diagnostics.push(format!("Action {au}: {side} morph {} is unavailable on the selected model meshes.", serde_json::to_string(target).unwrap())); }
                    }
                }
                morphs.left.extend(entry.left.clone()); morphs.right.extend(entry.right.clone()); morphs.center.extend(entry.center.clone());
            }
        }
        if !has_bones && !has_morphs { diagnostics.push("No available bone or morph outputs.".into()); }
        json!({"id":id, "label":control.label, "section":control.section,
            "auId":control.au_id, "negativeAuId":control.negative_au_id, "auIds":au_ids,
            "bilateral":control.bilateral, "roles":control.roles, "order":control.order,
            "boneBindings":bones, "morphBindings":morphs, "meshNames":meshes,
            "hasBones":has_bones, "hasMorphs":has_morphs, "isMixed":has_bones && has_morphs,
            "available":has_bones || has_morphs, "diagnostics":diagnostics})
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;
    use crate::runtime::RuntimeCore;
    use crate::profile_merge::{extend_preset_with_profile, parse_profile_patch};

    fn preset() -> ProfileData {
        serde_json::from_str(crate::presets::preset_json("cc4").unwrap()).unwrap()
    }

    fn model() -> Value {
        json!({"bones":[
            {"id":1,"name":"CC_Base_L_Forearm"},
            {"id":2,"name":"CC_Base_R_Forearm"},
            {"id":3,"name":"CC_Base_Spine01"}],
            "meshes":[{"id":5,"name":"CC_Base_Body","morphTargetIds":[10,11]},
                {"id":6,"name":"Shirt","morphTargetIds":[12]}],
            "morphTargets":[{"id":10,"meshId":5,"name":"LL_Body_Bicep_Flex_L","hostIndex":0},
                {"id":11,"meshId":5,"name":"LL_Body_Bicep_Flex_R","hostIndex":1},
                {"id":12,"meshId":6,"name":"Shirt_Flex_L","hostIndex":0}]})
    }

    #[test]
    fn body_action_drives_bones_and_skin_clothing_morphs_with_facs_mix_and_balance() {
        let mut core = RuntimeCore::new(0);
        let extension = json!({"auToMorphs":{"1001":{"left":["LL_Body_Bicep_Flex_L","Shirt_Flex_L"],
            "right":["LL_Body_Bicep_Flex_R"]}},"morphToMesh":{"body":["CC_Base_Body","Shirt"]},
            "auMixDefaults":{"1001":0.5}});
        core.configure_with_preset("cc4", &extension.to_string(), &model().to_string()).unwrap();
        core.set_au(1001, 0.5, -1.0);
        let morphs = core.evaluate_morph_frame_delta();
        let rows: Vec<_> = morphs.chunks_exact(4).collect();
        assert!(rows.iter().any(|row| row[..3] == [5.0, 10.0, 0.25]));
        assert!(rows.iter().any(|row| row[..3] == [5.0, 11.0, 0.0]));
        assert!(rows.iter().any(|row| row[..3] == [6.0, 12.0, 0.25]));
        let bones = core.evaluate_bone_frame_delta();
        let left = bones.chunks_exact(9).find(|row| row[0] == 1.0).unwrap();
        let right = bones.chunks_exact(9).find(|row| row[0] == 2.0).unwrap();
        assert!((left[4] - 0.5).abs() < 1e-5, "120 degrees * .5 is 60 degrees; morph mix does not attenuate bone");
        assert!(right[4].abs() < 1e-5);
        core.set_au(1001, 0.5, 1.0);
        let bones = core.evaluate_bone_frame_delta();
        assert!(bones.chunks_exact(9).find(|row| row[0] == 1.0).unwrap()[4].abs() < 1e-5);
        assert!((bones.chunks_exact(9).find(|row| row[0] == 2.0).unwrap()[4] - 0.5).abs() < 1e-5);
        core.set_au_signed(1004, -0.5, 0.0);
        assert_eq!(core.get_au(1003), 0.5);
        assert_eq!(core.get_au(1004), 0.0);
        core.set_au(1001, 0.0, 0.0);
        core.set_continuum(1003, 1004, 0.0, 0.0);
        assert!(core.evaluate_active_bone_frame().is_empty());
        assert!(core.evaluate_active_morph_frame().is_empty());
    }

    #[test]
    fn descriptors_report_missing_outputs_and_role_remapping_reaches_runtime() {
        let mut profile = preset();
        let absent: ModelData = serde_json::from_value(json!({"bones":[],"meshes":[],"morphTargets":[]})).unwrap();
        let result = resolve(&profile, Some(&absent));
        assert_eq!(result[0]["available"], false);
        assert!(result[0]["diagnostics"].as_array().unwrap().len() >= 4);
        let model: ModelData = serde_json::from_value(model()).unwrap();
        let result = resolve(&profile, Some(&model));
        assert_eq!(result[0]["isMixed"], true);
        assert_eq!(result[2]["auIds"], json!([1004,1003]));
        profile.humanoid_characterization.as_mut().unwrap().roles.get_mut("leftLowerArm").unwrap().node_key = "CUSTOM_ELBOW".into();
        profile.bone_nodes.insert("CUSTOM_ELBOW".into(), "CC_Base_R_Forearm".into());
        let result = resolve(&profile, Some(&model));
        assert_eq!(result[0]["boneBindings"][0]["boneName"], "CC_Base_R_Forearm");
    }

    #[test]
    fn sparse_profile_extensions_keep_defaults_and_old_facial_composites_keep_body_axes() {
        let base = preset();
        let facial: Vec<_> = base.composite_rotations.iter().filter(|c| !c.node.starts_with("left") && !c.node.starts_with("right") && c.node != "spine").cloned().collect();
        let patch = json!({"bodyControls":{"body.elbowFlex":{"label":"My biceps"},
            "body.kneeBend":null,"body.torsoTwist":{"negativeAuId":null}}, "compositeRotations":facial});
        let result = extend_preset_with_profile(&base, parse_profile_patch(&patch.to_string()).unwrap());
        let elbow = &result.body_controls["body.elbowFlex"];
        assert_eq!(elbow.au_id, 1001); assert!(elbow.bilateral); assert_eq!(elbow.label, "My biceps");
        assert!(!result.body_controls.contains_key("body.kneeBend"));
        assert_eq!(result.body_controls["body.torsoTwist"].negative_au_id, None);
        assert!(result.composite_rotations.iter().any(|c| c.node == "leftLowerArm"));
        assert!(!result.composite_rotations.iter().any(|c| c.node == "leftLowerLeg"));
    }

    // Actual target entries in a synthetic authored model, not proposed names
    // or promises that a character ships muscle geometry for every movement.
    fn authored_morph_catalog() -> (ProfileData, Value) {
        let mut profile = preset();
        let actions: BTreeSet<_> = profile.body_controls.values()
            .flat_map(|control| std::iter::once(control.au_id).chain(control.negative_au_id)).collect();
        assert_eq!(actions.len(), 98);
        let mut targets = Vec::new();
        let mut meshes = Vec::new();
        for (mesh_id, name) in [(1, "Skin_1"), (2, "Clothing_2"), (3, "Unrelated")] {
            let mut ids = Vec::new();
            for au in &actions {
                for (side_index, side) in ["left", "right", "center"].iter().enumerate() {
                    let id = mesh_id * 100_000 + au * 10 + side_index as u32;
                    targets.push(json!({"id": id, "meshId": mesh_id,
                        "name": format!("Authored_{au}_{side}"), "hostIndex": ids.len()}));
                    ids.push(id);
                }
            }
            meshes.push(json!({"id": mesh_id, "name": name, "morphTargetIds": ids}));
        }
        for au in actions {
            profile.au_to_morphs.insert(au.to_string(), Some(serde_json::from_value(json!({
                "left": [format!("Authored_{au}_left")],
                "right": [format!("Authored_{au}_right")],
                "center": [format!("Authored_{au}_center")]
            })).unwrap()));
            profile.au_mix_defaults.insert(au.to_string(), 0.25);
        }
        for names in profile.morph_to_mesh.values_mut() {
            *names = vec!["Skin".into(), "Clothing".into()];
        }
        let bones: Vec<_> = profile.humanoid_characterization.as_ref().unwrap().roles.keys()
            .enumerate().map(|(index, role)| json!({"id": index + 1,
                "name": configured_bone_name(&profile, role)})).collect();
        (profile, json!({"bones": bones, "meshes": meshes, "morphTargets": targets}))
    }

    #[test]
    fn every_body_direction_drives_authored_skin_and_clothing_with_balance_strength_and_reset() {
        let (authored, model) = authored_morph_catalog();
        assert_eq!(authored.body_controls.values().map(|control| control.section.as_str())
            .collect::<BTreeSet<_>>(), BTreeSet::from(["Torso", "Head", "Arms", "Hands", "Legs", "Feet"]));
        assert_eq!(authored.body_controls.len(), 58);
        // Removing role assignments and removing actuators are distinct authoring
        // operations. Both must leave independent morph mappings usable.
        for mode in ["mixed", "cleared-roles", "morph-only"] {
            let mut profile = authored.clone();
            if mode == "cleared-roles" {
                let roles: Vec<_> = profile.humanoid_characterization.as_ref().unwrap().roles.keys().cloned().collect();
                for role in roles {
                    crate::humanoid_characterization::set_role_binding(&mut profile, &role, None).unwrap();
                }
            } else if mode == "morph-only" {
                profile.au_to_bones.clear();
                profile.composite_rotations = Vec::new().into();
            }
            let mut core = RuntimeCore::new(0);
            core.configure_with_profile(&serde_json::to_string(&profile).unwrap(), &model.to_string()).unwrap();
            let descriptors: Value = serde_json::from_str(&core.get_body_controls_json()).unwrap();
            for descriptor in descriptors.as_array().unwrap() {
                assert_eq!(descriptor["hasMorphs"], true, "{mode}: {descriptor}");
                assert_eq!(descriptor["available"], true, "{mode}: {descriptor}");
                assert_eq!(descriptor["hasBones"], mode == "mixed", "{mode}: {descriptor}");
            }
            for (id, control) in &profile.body_controls {
                for direction in [1.0, -1.0] {
                    let au = if direction < 0.0 {
                        let Some(negative) = control.negative_au_id else { continue };
                        negative
                    } else { control.au_id };
                    // First check persisted strength, then a live adjustment.
                    for strength in [0.25, 0.75] {
                        if strength == 0.75 { core.set_au_mix_weight(au, strength); }
                        for balance in [-1.0, 0.0, 1.0] {
                            if let Some(negative) = control.negative_au_id {
                                core.set_continuum(negative, control.au_id, direction * 0.8, balance);
                            } else { core.set_au(au, 0.8, balance); }
                            let values = [if balance > 0.0 { 0.0 } else { 0.8 * strength },
                                if balance < 0.0 { 0.0 } else { 0.8 * strength }, 0.8 * strength];
                            let mut expected = Vec::new();
                            for mesh_id in [1, 2] {
                                for (side, value) in values.iter().enumerate() {
                                    if *value > 0.0 {
                                        expected.push((mesh_id, mesh_id * 100_000 + au * 10 + side as u32, *value));
                                    }
                                }
                            }
                            let actual: Vec<_> = core.evaluate_procedural_morph_frame().chunks_exact(4)
                                .map(|row| (row[0] as u32, row[1] as u32, row[2])).collect();
                            assert_eq!(actual, expected, "{mode}: {id}, action {au}, balance {balance}, strength {strength}");
                            core.reset_body_controls();
                            let release = core.evaluate_procedural_morph_frame();
                            assert_eq!(release.len(), expected.len() * 4, "release {mode}: {id}");
                            assert!(release.chunks_exact(4).all(|row| row[2] == 0.0));
                            assert!(core.evaluate_procedural_morph_frame().is_empty());
                            assert_eq!(core.get_au(au), 0.0);
                            assert_eq!(core.get_au_balance(au), 0.0);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn body_morph_assignments_and_explicit_clears_survive_preset_save_reload() {
        let (authored, model) = authored_morph_catalog();
        let reload = |profile: &ProfileData| extend_preset_with_profile(&preset(),
            parse_profile_patch(&serde_json::to_string(profile).unwrap()).unwrap());
        let reloaded = reload(&authored);
        assert_eq!(serde_json::to_value(&reloaded.au_to_morphs).unwrap(),
            serde_json::to_value(&authored.au_to_morphs).unwrap());
        let mut patch = json!({"auToMorphs": {}});
        for control in authored.body_controls.values() {
            for au in std::iter::once(control.au_id).chain(control.negative_au_id) {
                patch["auToMorphs"][au.to_string()] = json!({"left": [], "right": [], "center": []});
            }
        }
        let cleared = extend_preset_with_profile(&reloaded, parse_profile_patch(&patch.to_string()).unwrap());
        let cleared = reload(&cleared);
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(&serde_json::to_string(&cleared).unwrap(), &model.to_string()).unwrap();
        let descriptors: Value = serde_json::from_str(&core.get_body_controls_json()).unwrap();
        assert!(descriptors.as_array().unwrap().iter().all(|descriptor| descriptor["hasMorphs"] == false));
        for control in cleared.body_controls.values() {
            for au in std::iter::once(control.au_id).chain(control.negative_au_id) {
                core.set_au(au, 1.0, 0.0);
            }
        }
        assert!(core.evaluate_active_morph_frame().is_empty(), "clearing must not revive inherited targets");
        assert!(!core.evaluate_active_bone_frame().is_empty(), "morph clears preserve bone controls");
    }

    #[test]
    fn morph_only_body_clip_tracks_use_the_same_authored_strength_and_balance() {
        let (mut profile, model) = authored_morph_catalog();
        profile.au_to_bones.clear();
        profile.composite_rotations = Vec::new().into();
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(&serde_json::to_string(&profile).unwrap(), &model.to_string()).unwrap();
        for control in profile.body_controls.values() {
            for au in std::iter::once(control.au_id).chain(control.negative_au_id) {
                let curves = json!({au.to_string(): [
                    {"time": 0, "intensity": 0}, {"time": 1, "intensity": 0.8}
                ]});
                for strength in [0.25, 0.75] {
                    if strength != 0.25 { core.set_au_mix_weight(au, strength); }
                    let clip: Value = serde_json::from_str(&core.build_clip("body-morph",
                        &curves.to_string(), r#"{"balance":-1}"#).unwrap()).unwrap();
                    let tracks = clip["tracks"].as_array().unwrap();
                    assert_eq!(tracks.len(), 4,
                        "left and center authored targets; zero-weight tracks are omitted: action {au}");
                    for track in tracks {
                        assert_eq!(track["target"]["kind"], "morphTarget");
                        assert!([1, 2].contains(&track["target"]["meshId"].as_u64().unwrap()));
                        let side = track["target"]["morphTargetId"].as_u64().unwrap() % 10;
                        let expected = if side == 1 { 0.0 } else { 0.8 * f64::from(strength) };
                        assert!((track["values"][1].as_f64().unwrap() - expected).abs() < 1e-6,
                            "action {au}, strength {strength}, track {track}");
                    }
                }
            }
        }
    }

    #[test]
    fn missing_body_targets_are_diagnosed_without_disabling_available_authored_sides() {
        let (profile, mut model) = authored_morph_catalog();
        // All right/center geometry is unavailable, including fallback meshes.
        // Left targets still exist on both skin and clothing for every action.
        model["morphTargets"].as_array_mut().unwrap().retain(|target|
            target["name"].as_str().unwrap().ends_with("_left"));
        let model: ModelData = serde_json::from_value(model).unwrap();
        let descriptors = resolve(&profile, Some(&model));
        for descriptor in descriptors.as_array().unwrap() {
            assert_eq!(descriptor["hasMorphs"], true);
            for au in descriptor["auIds"].as_array().unwrap() {
                for side in ["right", "center"] {
                    assert!(descriptor["diagnostics"].as_array().unwrap().iter().any(|message|
                        message.as_str().unwrap().contains(&format!("Action {au}: {side} morph"))), "{descriptor}");
                }
            }
        }
        let absent: ModelData = serde_json::from_value(json!({})).unwrap();
        assert!(resolve(&profile, Some(&absent)).as_array().unwrap().iter().all(|descriptor|
            descriptor["hasMorphs"] == false && descriptor["available"] == false));
    }

    #[test]
    fn explicit_body_mesh_selection_never_falls_back_to_unselected_targets() {
        let (authored, model) = authored_morph_catalog();
        for selection in [Vec::<String>::new(), vec!["MissingMesh".into()], vec!["Skin".into()]] {
            let mut profile = authored.clone();
            profile.au_to_bones.clear();
            profile.composite_rotations = Vec::new().into();
            for names in profile.morph_to_mesh.values_mut() { *names = selection.clone(); }
            let mut model = model.clone();
            // Clothing and unrelated meshes still have every matching name.
            // Neither may substitute for an intentionally selected bare skin.
            model["morphTargets"].as_array_mut().unwrap().retain(|target| target["meshId"] != 1);
            let mut core = RuntimeCore::new(0);
            core.configure_with_profile(&serde_json::to_string(&profile).unwrap(), &model.to_string()).unwrap();
            let descriptors: Value = serde_json::from_str(&core.get_body_controls_json()).unwrap();
            assert!(descriptors.as_array().unwrap().iter().all(|descriptor|
                descriptor["hasMorphs"] == false && descriptor["available"] == false), "{selection:?}");
            for control in profile.body_controls.values() {
                for au in std::iter::once(control.au_id).chain(control.negative_au_id) {
                    core.set_au(au, 1.0, 0.0);
                }
            }
            assert!(core.evaluate_active_morph_frame().is_empty(), "{selection:?}");
        }
        // Old profiles without any category still resolve targets by content.
        let mut profile = authored;
        profile.morph_to_mesh.clear();
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(&serde_json::to_string(&profile).unwrap(), &model.to_string()).unwrap();
        for control in profile.body_controls.values() {
            for au in std::iter::once(control.au_id).chain(control.negative_au_id) {
                core.set_au(au, 1.0, 0.0);
            }
        }
        assert_eq!(core.evaluate_active_morph_frame().len(), 98 * 3 * 3 * 4);
    }

    #[test]
    fn non_body_morph_only_actions_keep_legacy_full_strength() {
        for meshes in [json!({}), json!({"face": []}), json!({"face": ["Missing"]})] {
            let profile = json!({"auToMorphs":{"12":{"center":["Smile"]}},
                "auMixDefaults":{"12":0.25}, "morphToMesh": meshes});
            let mut core = RuntimeCore::new(0);
            core.configure_with_profile(&profile.to_string(),
                r#"{"meshes":[{"id":1,"name":"Face","morphTargetIds":[2]}],"morphTargets":[{"id":2,"meshId":1,"name":"Smile","hostIndex":0}]}"#).unwrap();
            core.set_au(12, 0.8, 0.0);
            assert_eq!(core.evaluate_active_morph_frame()[2], 0.8);
            core.set_au_mix_weight(12, 0.5);
            assert_eq!(core.evaluate_active_morph_frame()[2], 0.8);
        }
    }
}
