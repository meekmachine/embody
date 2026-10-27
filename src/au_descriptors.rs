//! Read-only descriptors of actual AU metadata and mapped outputs, never a second control catalog.
use std::collections::BTreeSet;
use serde_json::{json, Value};
use crate::profile::{AuMorphEntry, AuSelector, ModelData, NameResolver, ProfileData};

pub(crate) fn resolve(profile: &ProfileData, model: Option<&ModelData>) -> Value {
    let resolver = model.map(|model|NameResolver::new(profile,model));
    let ids:BTreeSet<u32> = profile.au_info.keys().chain(profile.action_info.keys())
        .chain(profile.au_to_bones.keys()).chain(profile.au_to_morphs.keys()).chain(profile.bone_bindings.keys())
        .filter(|id|!id.is_empty() && id.bytes().all(|byte|byte.is_ascii_digit()))
        .filter_map(|id|id.parse().ok()).collect();
    Value::Array(ids.into_iter().map(|au| {
        let key=au.to_string();
        let info=profile.au_info.get(&key).or_else(||profile.action_info.get(&key));
        let mut bones=Vec::new();let mut bone_names=BTreeSet::new();let mut morph_names=BTreeSet::new();
        let mut sides=BTreeSet::new();let mut diagnostics=Vec::new();let mut has_bones=false;let mut has_morphs=false;
        for binding in profile.au_to_bones.get(&key).or_else(||profile.bone_bindings.get(&key)).into_iter().flatten() {
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
            "faceArea":info.and_then(|info|info.face_area.as_deref()),"facePart":info.and_then(|info|info.face_part.as_deref()),
            "negativeAuId":negative,"positiveAuId":positive,"bilateral":bilateral,
            "boneBindings":bones,"boneNames":bone_names,"morphBindings":morphs,"morphNames":morph_names,
            "morphStrength":profile.au_mix_defaults.get(&key).copied().unwrap_or(1.0),"availableSides":sides,
            "hasBones":has_bones,"hasMorphs":has_morphs,"available":has_bones||has_morphs,"diagnostics":diagnostics})
    }).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeCore;
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
