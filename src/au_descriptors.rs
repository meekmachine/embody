//! Read-only descriptors of actual AU metadata and mapped outputs, never a second control catalog.
use std::collections::BTreeSet;
use serde_json::{json, Value};
use crate::profile::{AuMorphEntry, AuSelector, ControlCategory, ModelData, NameResolver, ProfileData};

pub(crate) fn resolve(profile: &ProfileData, model: Option<&ModelData>) -> Value {
    let resolver = model.map(|model|NameResolver::new(profile,model));
    let ids:BTreeSet<u32> = profile.au_info.keys().chain(profile.action_info.keys())
        .chain(profile.au_to_bones.keys()).chain(profile.au_to_morphs.keys()).chain(profile.bone_bindings.keys())
        .filter(|id|!id.is_empty() && id.bytes().all(|byte|byte.is_ascii_digit()))
        .filter_map(|id|id.parse().ok()).collect();
    Value::Array(ids.into_iter().map(|au| {
        let key=au.to_string();
        let info=profile.au_info.get(&key).or_else(||profile.action_info.get(&key));
        let category=info.map(|info|info.control_category()).unwrap_or(ControlCategory::Custom);
        let configured_bones=profile.au_to_bones.get(&key).or_else(||profile.bone_bindings.get(&key));
        let mut bones=Vec::new();let mut bone_names=BTreeSet::new();let mut morph_names=BTreeSet::new();
        let mut sides=BTreeSet::new();let mut diagnostics=Vec::new();let mut has_bones=false;let mut has_morphs=false;
        for binding in configured_bones.into_iter().flatten() {
            let resolved=model.zip(resolver.as_ref()).and_then(|(model,resolver)|resolver.resolve_bone(model,profile,&binding.node));
            let name=resolved.map(|bone|bone.name.clone()).unwrap_or_else(||crate::profile_resolution::configured_bone_name(profile,&binding.node));
            let rotational=matches!(binding.channel.as_str(),"rx"|"ry"|"rz");
            let composite=!rotational||profile.composite_rotations.iter().any(|composite|
                crate::profile_resolution::configured_bone_name(profile,&composite.node)==crate::profile_resolution::configured_bone_name(profile,&binding.node)
                && [&composite.pitch,&composite.yaw,&composite.roll].into_iter().flatten().any(|axis|
                    axis.aus.contains(&au)||[&axis.negative,&axis.positive].into_iter().flatten().any(|selector|match selector {AuSelector::One(id)=>*id==au,AuSelector::Many(ids)=>ids.contains(&au)})));
            let available=composite&&(model.is_none()||resolved.is_some());
            if !composite {diagnostics.push(format!("Action {au}: {} has no composite rotation.",binding.node));}
            if model.is_some()&&resolved.is_none(){diagnostics.push(format!("Action {au}: bone {} is absent from the model.",binding.node));}
            if available { has_bones=true;bone_names.insert(name.clone());sides.insert(binding.side.clone().unwrap_or_else(||"center".into())); }
            let mut row=serde_json::to_value(binding).unwrap();row["auId"]=json!(au);row["boneName"]=json!(name);bones.push(row);
        }
        let morphs=profile.au_to_morphs.get(&key).and_then(Option::as_ref).cloned().unwrap_or_else(AuMorphEntry::default);
        let has_configured_morphs=!morphs.left.is_empty()||!morphs.right.is_empty()||!morphs.center.is_empty();
        for (side,targets) in [("left",&morphs.left),("right",&morphs.right),("center",&morphs.center)] {
            for target in targets {
                let resolved=resolver.as_ref().map(|resolver|resolver.resolve_au_morph(profile,au,target));
                let exists=resolved.as_ref().is_none_or(|targets|!targets.is_empty());
                if exists {has_morphs=true;sides.insert(side.to_string());} else {diagnostics.push(format!("Action {au}: {side} morph {} is unavailable on selected meshes.",serde_json::to_string(target).unwrap()));}
                if let (Some(model),Some(resolved))=(model,resolved) {
                    for (_,id) in resolved {if let Some(target)=model.morph_targets.iter().find(|target|target.id==id){morph_names.insert(target.name.clone());}}
                } else if let crate::profile::MorphRef::Name(name)=target {morph_names.insert(name.clone());}
            }
        }
        if !has_bones&&!has_morphs {diagnostics.push("No available bone or morph outputs.".into());}
        let pair=profile.continuum_pairs.get(&key).and_then(Option::as_ref);
        let (negative,positive)=pair.map(|pair|if pair.is_negative {(Some(au),Some(pair.pair_id))} else {(Some(pair.pair_id),Some(au))}).unwrap_or((None,None));
        // A partial rig still supports selecting its available authored side.
        // availableSides distinguishes that support from a complete bilateral rig.
        let bilateral=sides.contains("left")||sides.contains("right");
        json!({"auId":au,"label":info.and_then(|info|info.name.as_deref()).unwrap_or(&key),
            "category":category,"section":info.and_then(|info|info.section.as_ref()).and_then(Option::as_ref),
            "order":info.and_then(|info|info.order).flatten(),
            "controlLabel":info.and_then(|info|info.control_label.as_ref()).and_then(Option::as_ref),
            "faceArea":info.and_then(|info|info.face_area.as_deref()),"facePart":info.and_then(|info|info.face_part.as_deref()),
            "negativeAuId":negative,"positiveAuId":positive,"bilateral":bilateral,
            "boneBindings":bones,"boneNames":bone_names,"morphBindings":morphs,"morphNames":morph_names,
            "morphStrength":profile.au_mix_defaults.get(&key).copied().unwrap_or(1.0),"availableSides":sides,
            "hasConfiguredBones":configured_bones.is_some_and(|bindings|!bindings.is_empty()),
            "hasConfiguredMorphs":has_configured_morphs,
            "hasBones":has_bones,"hasMorphs":has_morphs,"available":has_bones||has_morphs,"diagnostics":diagnostics})
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeCore;
    #[test]
    fn real_cc4_retains_every_historical_movement_without_duplicate_face_identities() {
        let profile=crate::presets::load_profile("cc4").unwrap();
        let rows=resolve(&profile,Some(&ModelData::default()));
        // Historical expected presentation is a regression fixture only. The
        // active source remains each existing AU's authored preset metadata.
        let expected: &[(u32, Option<u32>, &str, u32, &str, &str)]=&[
            (1001, None, "Arms", 3010, "Elbow flex", "body"),
            (1002, None, "Legs", 5020, "Knee bend", "body"),
            (1004, Some(1003), "Torso", 1030, "Torso twist", "body"),
            (1011, Some(1010), "Whole body", 40, "Whole body bend", "body"),
            (1013, Some(1012), "Whole body", 50, "Whole body twist", "body"),
            (1015, Some(1014), "Whole body", 60, "Whole body side bend", "body"),
            (1017, Some(1016), "Torso", 1070, "Lower spine bend", "body"),
            (1019, Some(1018), "Torso", 1080, "Lower spine twist", "body"),
            (1021, Some(1020), "Torso", 1090, "Lower spine side bend", "body"),
            (1023, Some(1022), "Torso", 1100, "Chest bend", "body"),
            (1025, Some(1024), "Torso", 1110, "Chest side bend", "body"),
            (1027, Some(1026), "Torso", 1120, "Upper chest bend", "body"),
            (1029, Some(1028), "Torso", 1130, "Upper chest twist", "body"),
            (1031, Some(1030), "Torso", 1140, "Upper chest side bend", "body"),
            (1033, Some(1032), "Head", 2150, "Neck bend", "body"),
            (1035, Some(1034), "Head", 2160, "Neck twist", "body"),
            (1037, Some(1036), "Head", 2170, "Neck side bend", "body"),
            (1039, Some(1038), "Arms", 3180, "Shoulder raise", "body"),
            (1041, Some(1040), "Arms", 3190, "Shoulder forward/back", "body"),
            (1043, Some(1042), "Arms", 3200, "Arm forward/back", "body"),
            (1045, Some(1044), "Arms", 3210, "Arm raise/lower", "body"),
            (1047, Some(1046), "Arms", 3220, "Upper arm twist", "body"),
            (1049, Some(1048), "Arms", 3230, "Forearm rotation", "body"),
            (1051, Some(1050), "Hands", 4240, "Wrist bend", "body"),
            (1053, Some(1052), "Hands", 4250, "Wrist side bend", "body"),
            (1055, Some(1054), "Legs", 5260, "Hip forward/back", "body"),
            (1057, Some(1056), "Legs", 5270, "Hip outward/inward", "body"),
            (1059, Some(1058), "Legs", 5280, "Hip rotation", "body"),
            (1061, Some(1060), "Feet", 6290, "Ankle bend", "body"),
            (1063, Some(1062), "Feet", 6300, "Foot tilt", "body"),
            (1065, Some(1064), "Feet", 6310, "Toe bend", "body"),
            (1066, None, "Hands", 4320, "Thumb metacarpal curl", "body"),
            (1067, None, "Hands", 4330, "Thumb proximal curl", "body"),
            (1068, None, "Hands", 4340, "Thumb distal curl", "body"),
            (1070, Some(1069), "Hands", 4350, "Thumb spread", "body"),
            (1071, None, "Hands", 4360, "Index proximal curl", "body"),
            (1072, None, "Hands", 4370, "Index intermediate curl", "body"),
            (1073, None, "Hands", 4380, "Index distal curl", "body"),
            (1075, Some(1074), "Hands", 4390, "Index spread", "body"),
            (1076, None, "Hands", 4400, "Middle proximal curl", "body"),
            (1077, None, "Hands", 4410, "Middle intermediate curl", "body"),
            (1078, None, "Hands", 4420, "Middle distal curl", "body"),
            (1080, Some(1079), "Hands", 4430, "Middle spread", "body"),
            (1081, None, "Hands", 4440, "Ring proximal curl", "body"),
            (1082, None, "Hands", 4450, "Ring intermediate curl", "body"),
            (1083, None, "Hands", 4460, "Ring distal curl", "body"),
            (1085, Some(1084), "Hands", 4470, "Ring spread", "body"),
            (1086, None, "Hands", 4480, "Little proximal curl", "body"),
            (1087, None, "Hands", 4490, "Little intermediate curl", "body"),
            (1088, None, "Hands", 4500, "Little distal curl", "body"),
            (1090, Some(1089), "Hands", 4510, "Little spread", "body"),
            (52, Some(51), "Head", 520, "Head turn", "au"),
            (53, Some(54), "Head", 530, "Head nod", "au"),
            (56, Some(55), "Head", 540, "Head tilt", "au"),
            (62, Some(61), "Head", 550, "Eyes turn", "au"),
            (63, Some(64), "Head", 560, "Eyes up/down", "au"),
            (26, None, "Head", 570, "Jaw open", "au"),
            (35, Some(30), "Head", 580, "Jaw sideways", "au"),
        ];
        let descriptors=rows.as_array().unwrap();
        let mut body_controls=BTreeSet::new();
        let mut face_controls=BTreeSet::new();
        for &(positive,negative,section,order,label,category) in expected {
            for id in std::iter::once(positive).chain(negative) {
                let row=descriptors.iter().find(|row|row["auId"]==id).unwrap();
                assert_eq!(row["category"],category,"{label}/{id} category");
                assert_eq!(row["section"],section,"{label}/{id} section");
                assert_eq!(row["order"].as_f64(),Some(order as f64),"{label}/{id} order");
                assert_eq!(row["controlLabel"],label,"{label}/{id} label");
                assert_eq!(row["hasConfiguredBones"],true,"{label}/{id} configured bindings");
                assert_eq!(row["hasBones"],false,"an absent rig must not hide configured controls");
                if let Some(negative)=negative {
                    assert_eq!(row["negativeAuId"],negative);
                    assert_eq!(row["positiveAuId"],positive);
                }
            }
            if category=="body" {body_controls.insert(label);} else {face_controls.insert(label);}
        }
        assert_eq!(body_controls.len(),51);
        assert_eq!(face_controls.len(),7);
        assert_eq!(descriptors.iter().filter(|row|!row["controlLabel"].is_null())
            .map(|row|row["controlLabel"].as_str().unwrap()).collect::<BTreeSet<_>>().len(),58);
    }

    #[test]
    fn cc4_elbow_moves_bones_without_implicitly_mapping_muscle_morphs() {
        let mut profile=crate::presets::load_profile("cc4").unwrap();
        // Even a model containing the old example names must not acquire an
        // elbow-to-muscle link without an authored profile assignment.
        let model:ModelData=serde_json::from_value(json!({
            "bones":[{"id":1,"name":"CC_Base_L_Forearm"},{"id":2,"name":"CC_Base_R_Forearm"}],
            "meshes":[{"id":3,"name":"CC_Base_Body","morphTargetIds":[10,11]}],
            "morphTargets":[{"id":10,"meshId":3,"name":"LL_Body_Bicep_Flex_L","hostIndex":0},
                {"id":11,"meshId":3,"name":"LL_Body_Bicep_Flex_R","hostIndex":1}]
        })).unwrap();
        let rows=resolve(&profile,Some(&model));
        let elbow=rows.as_array().unwrap().iter().find(|row|row["auId"]==1001).unwrap();
        assert_eq!(elbow["label"],"Elbow flex");
        assert_eq!(elbow["hasBones"],true);
        assert_eq!(elbow["available"],true);
        assert_eq!(elbow["hasConfiguredMorphs"],false);
        assert_eq!(elbow["hasMorphs"],false);
        assert!(elbow["diagnostics"].as_array().unwrap().is_empty());

        // Existing explicit character mappings, including those same names,
        // remain authoritative when their targets really exist.
        profile.au_to_morphs.insert("1001".into(),Some(serde_json::from_value(json!({
            "left":["LL_Body_Bicep_Flex_L"],"right":["LL_Body_Bicep_Flex_R"],"center":[]
        })).unwrap()));
        let rows=resolve(&profile,Some(&model));
        let mapped=rows.as_array().unwrap().iter().find(|row|row["auId"]==1001).unwrap();
        assert_eq!(mapped["hasConfiguredMorphs"],true);
        assert_eq!(mapped["hasMorphs"],true);
        assert_eq!(mapped["boneBindings"],elbow["boneBindings"]);
    }

    fn fixture()->(ProfileData,ModelData) {
        (serde_json::from_value(json!({"auInfo":{"8001":{"name":"Authored flex","faceArea":"Body","facePart":"Body"}},
            "auToBones":{"8001":[{"node":"ArmL","channel":"rx","scale":1,"maxDegrees":90,"side":"left"},
                {"node":"ArmR","channel":"rx","scale":1,"maxDegrees":90,"side":"right"}]},
            "auToMorphs":{"8001":{"left":["FlexL","ClothL"],"right":["FlexR"]}},
            "auFacePartToMeshCategory":{"Body":"body"},
            "morphToMesh":{"body":["Skin","Shirt"]},"auMixDefaults":{"8001":0.25},
            "compositeRotations":[{"node":"ArmL","pitch":{"aus":[8001],"axis":"rx"}},
                {"node":"ArmR","pitch":{"aus":[8001],"axis":"rx"}}]})).unwrap(),
            serde_json::from_value(json!({"bones":[{"id":1,"name":"ArmL"},{"id":2,"name":"ArmR"}],
                "meshes":[{"id":3,"name":"Skin","morphTargetIds":[5,6]},{"id":4,"name":"Shirt","morphTargetIds":[7]}],
                "morphTargets":[{"id":5,"meshId":3,"name":"FlexL","hostIndex":0},
                    {"id":6,"meshId":3,"name":"FlexR","hostIndex":1},{"id":7,"meshId":4,"name":"ClothL","hostIndex":0}]})).unwrap())
    }
    #[test]
    fn custom_au_descriptors_follow_saved_mapping_without_named_catalog() {
        let (profile,model)=fixture();let rows=resolve(&profile,Some(&model));
        assert_eq!(rows.as_array().unwrap().len(),1);let row=&rows[0];
        assert_eq!(row["auId"],8001);assert_eq!(row["label"],"Authored flex");
        assert_eq!(row["bilateral"],true);assert_eq!(row["morphStrength"],0.25);
        assert_eq!(row["boneNames"],json!(["ArmL","ArmR"]));
        assert_eq!(row["availableSides"],json!(["left","right"]));
        assert_eq!(row["hasBones"],true);assert_eq!(row["hasMorphs"],true);
        let absent=resolve(&profile,Some(&ModelData::default()));assert_eq!(absent[0]["available"],false);
        assert!(!absent[0]["diagnostics"].as_array().unwrap().is_empty());
    }
    #[test]
    fn classification_uses_profile_meaning_and_keeps_unavailable_configured_outputs() {
        let cc4=crate::presets::load_profile("cc4").unwrap();
        let fish=crate::presets::load_profile("fish").unwrap();
        for (profile,category) in [(&cc4,"au"),(&fish,"body")] {
            let rows=resolve(profile,None);
            assert_eq!(rows.as_array().unwrap().iter().find(|row|row["auId"]==2).unwrap()["category"],category);
        }
        let profile:ProfileData=serde_json::from_value(json!({
            "auInfo":{"8002":{"name":"Authored axis","facePart":"Joint Controls"},
                "8003":{"name":"Deliberately custom","faceArea":"Body","category":"custom"}},
            "auToBones":{"2":[{"node":"Missing","channel":"rx","scale":1}]},
            "auToMorphs":{"2":{"center":["MissingShape"]}}
        })).unwrap();
        let rows=resolve(&profile,Some(&ModelData::default()));
        assert_eq!(rows[0]["auId"],2);
        assert_eq!(rows[0]["category"],"custom","numeric IDs do not establish FACS semantics");
        assert_eq!(rows[0]["hasConfiguredBones"],true);
        assert_eq!(rows[0]["hasConfiguredMorphs"],true);
        assert_eq!(rows[0]["available"],false);
        assert_eq!(rows[0]["boneBindings"][0]["node"],"Missing");
        assert_eq!(rows[1]["category"],"bone");
        assert_eq!(rows[2]["category"],"custom");
    }

    #[test]
    fn category_presentation_does_not_change_live_or_compiled_bone_and_morph_output() {
        let (profile,model)=fixture();
        for clear_bones in [false,true] {
            let mut profile=profile.clone();
            if clear_bones {
                profile.au_to_bones.insert("8001".into(),Vec::new());
                profile.composite_rotations=Vec::new().into();
            }
            let mut expected=None;
            for category in [Some(ControlCategory::Au),Some(ControlCategory::Body),Some(ControlCategory::Bone),Some(ControlCategory::Custom),None] {
                let info=profile.au_info.get_mut("8001").unwrap();
                info.category=Some(category);
                info.section=Some(Some("Authored section".into()));
                info.control_label=Some(Some("Authored movement".into()));
                let mut core=RuntimeCore::new(0);
                core.configure_with_profile(&serde_json::to_string(&profile).unwrap(),&serde_json::to_string(&model).unwrap()).unwrap();
                core.set_au(8001,0.8,-1.0);
                let clip=core.build_clip("category-independent",r#"{"8001":[{"time":0,"intensity":0},{"time":1,"intensity":0.8}]}"#,
                    r#"{"balanceMap":{"8001":-1},"mixWeights":{"8001":0.25}}"#).unwrap();
                let output=(core.evaluate_active_bone_frame(),core.evaluate_active_morph_frame(),clip);
                if let Some(expected)=&expected {assert_eq!(&output,expected);} else {expected=Some(output);}
                assert_eq!(resolve(&profile,Some(&model))[0]["category"],serde_json::to_value(category.unwrap_or(ControlCategory::Custom)).unwrap());
            }
        }
    }
    #[test]
    fn partial_left_rig_keeps_balance_selection_without_advertising_missing_right() {
        let (profile,mut model)=fixture();
        model.bones.retain(|bone|bone.name=="ArmL");
        model.morph_targets.retain(|target|target.name=="FlexL");
        let rows=resolve(&profile,Some(&model));let row=&rows[0];
        assert_eq!(row["bilateral"],true,"one authored side still supports balance selection");
        assert_eq!(row["availableSides"],json!(["left"]));
        assert_eq!(row["boneNames"],json!(["ArmL"]));
        assert!(row["diagnostics"].as_array().unwrap().iter().any(|message|message.as_str().unwrap().contains("ArmR")));
        let mut core=RuntimeCore::new(0);
        core.configure_with_profile(&serde_json::to_string(&profile).unwrap(),&serde_json::to_string(&model).unwrap()).unwrap();
        core.set_au(8001,0.5,-1.0);
        assert!(core.evaluate_active_bone_frame().chunks_exact(9).any(|row|row[0]==1.0&&row[4].abs()>0.1));
        core.set_au(8001,0.5,1.0);
        assert!(!core.evaluate_active_bone_frame().chunks_exact(9).any(|row|row[4..7].iter().any(|value|value.abs()>1e-6)));
        assert!(core.evaluate_active_morph_frame().chunks_exact(4).all(|row|row[2].abs()<1e-6));
    }
    #[test]
    fn descriptor_count_follows_numeric_profile_keys_and_center_only_has_no_side_selector() {
        let mut profile:ProfileData=serde_json::from_value(json!({"auInfo":{"3":{"name":"First"},"not-an-au":{"name":"Ignored"},"+5":{"name":"Invalid signed key"}},
            "auToMorphs":{"3":{"center":["FirstShape"]}}})).unwrap();
        let rows=resolve(&profile,None);
        assert_eq!(rows.as_array().unwrap().len(),1);assert_eq!(rows[0]["auId"],3);
        assert_eq!(rows[0]["bilateral"],false);assert_eq!(rows[0]["availableSides"],json!(["center"]));
        profile.au_to_morphs.insert("9007".into(),Some(serde_json::from_value(json!({"left":["ExtraShape"]})).unwrap()));
        let rows=resolve(&profile,None);
        assert_eq!(rows.as_array().unwrap().iter().map(|row|row["auId"].as_u64().unwrap()).collect::<Vec<_>>(),vec![3,9007]);
        profile.au_info.remove("3");profile.au_to_morphs.remove("3");
        let rows=resolve(&profile,None);assert_eq!(rows.as_array().unwrap().len(),1);assert_eq!(rows[0]["auId"],9007);
    }
    #[test]
    fn custom_continuum_descriptors_keep_each_au_identity_and_explicit_pair_directions() {
        let profile: ProfileData = serde_json::from_value(json!({
            "auInfo": {"7001": {"name": "Custom left"}, "9007": {"name": "Custom right"}},
            "auToMorphs": {"7001": {"center": ["LeftShape"]}, "9007": {"center": ["RightShape"]}},
            "continuumPairs": {
                "7001": {"pairId": 9007, "isNegative": true},
                "9007": {"pairId": 7001, "isNegative": false}
            }
        })).unwrap();
        let rows = resolve(&profile, None);
        let rows = rows.as_array().unwrap();
        assert_eq!(rows.iter().map(|row| row["auId"].as_u64().unwrap()).collect::<Vec<_>>(), vec![7001, 9007]);
        for row in rows {
            assert_eq!(row["negativeAuId"], 7001);
            assert_eq!(row["positiveAuId"], 9007);
        }
        assert_eq!(rows[0]["label"], "Custom left");
        assert_eq!(rows[1]["label"], "Custom right");
    }
    #[test]
    fn au_bone_skin_and_clothing_output_preserves_balance_and_live_mix() {
        let (profile,model)=fixture();let mut core=RuntimeCore::new(0);
        core.configure_with_profile(&serde_json::to_string(&profile).unwrap(),&serde_json::to_string(&model).unwrap()).unwrap();
        core.set_au(8001,0.8,-1.0);
        let morphs=core.evaluate_active_morph_frame();
        assert!(morphs.chunks_exact(4).any(|row|row[1]==5.0&&(row[2]-0.2).abs()<1e-6));
        assert!(morphs.chunks_exact(4).any(|row|row[1]==7.0&&(row[2]-0.2).abs()<1e-6));
        let bones=core.evaluate_active_bone_frame();assert!(bones.chunks_exact(9).any(|row|row[0]==1.0&&row[4].abs()>0.5));
        assert!(!bones.chunks_exact(9).any(|row|row[0]==2.0&&row[4].abs()>0.001));
        let clip:Value=serde_json::from_str(&core.build_clip("au-only",r#"{"8001":[{"time":0,"intensity":0},{"time":1,"intensity":0.5}]}"#,r#"{"balanceMap":{"8001":-1},"mixWeights":{"8001":0.5}}"#).unwrap()).unwrap();
        assert!(clip["tracks"].as_array().unwrap().iter().any(|track|track["target"]["morphTargetId"]==5&&track["values"].as_array().unwrap().iter().any(|value|value==0.25)));
        assert_eq!(core.get_au(8001),0.8);assert_eq!(core.get_au_balance(8001),-1.0);assert_eq!(core.get_au_mix_weight(8001),0.25);
    }
    #[test]
    fn explicit_empty_mesh_selection_does_not_fall_back_to_other_meshes() {
        let (mut profile,model)=fixture();profile.au_to_bones.clear();profile.composite_rotations=Vec::new().into();
        for selection in [vec![],vec!["Missing".to_string()]] {
            profile.morph_to_mesh.insert("body".into(),selection);
            assert_eq!(resolve(&profile,Some(&model))[0]["hasMorphs"],false);
            let mut core=RuntimeCore::new(0);core.configure_with_profile(&serde_json::to_string(&profile).unwrap(),&serde_json::to_string(&model).unwrap()).unwrap();
            core.set_au(8001,1.0,0.0);assert!(core.evaluate_active_morph_frame().is_empty());
        }
    }
}
