//! Independent spec/schema, authored-rig, and live-output regression coverage.
use serde_json::{json, Value};
use crate::profile::{ModelData, ProfileData};
use crate::{humanoid_characterization as humanoid, runtime::RuntimeCore};

fn cc4() -> ProfileData {
    serde_json::from_str(crate::presets::preset_json("cc4").unwrap()).unwrap()
}
fn cc4_model() -> ModelData {
    let template: Value = serde_json::from_str(include_str!("../assets/templates/cc4-humanoid.json")).unwrap();
    serde_json::from_value(json!({"bones": template["bones"].as_array().unwrap().iter().enumerate()
        .map(|(id,bone)| json!({"id":id+1,"name":bone["name"],"parentName":bone["parent"]})).collect::<Vec<_>>()})).unwrap()
}
fn compiled(profile: &ProfileData, model: &ModelData) -> RuntimeCore {
    let mut core = RuntimeCore::new(0);
    core.configure_with_profile(&serde_json::to_string(profile).unwrap(), &serde_json::to_string(model).unwrap()).unwrap();
    core
}

#[test]
fn canonical_spec_matches_upstream_schema_and_required_flags() {
    let schema: Value = serde_json::from_str(include_str!("../tests/fixtures/VRMC_vrm.humanoid.humanBones.schema.json")).unwrap();
    let spec = humanoid::specification();
    assert_eq!(spec.standard, "VRMC_vrm-1.0");
    assert_eq!(spec.bones.len(), 55);
    assert_eq!(spec.bones.iter().filter(|bone| bone.required).count(), 15);
    assert_eq!(spec.bones.iter().filter(|bone| bone.requires_parent).count(), 21);
    let expected: std::collections::BTreeSet<_> = schema["properties"].as_object().unwrap().keys().map(String::as_str).collect();
    let actual: std::collections::BTreeSet<_> = spec.bones.iter().map(|bone| bone.role.as_str()).collect();
    assert_eq!(actual, expected);
    for bone in &spec.bones {
        assert_eq!(bone.required, schema["required"].as_array().unwrap().iter().any(|role| role == &bone.role));
        assert!(bone.parent.as_ref().is_none_or(|role| actual.contains(role.as_str())));
        assert!(!bone.label.is_empty());
    }
}

#[test]
fn all_cc4_roles_are_distinct_authored_bones_in_the_actual_template_hierarchy() {
    let profile = cc4();
    let result = humanoid::validate(&profile, &cc4_model());
    assert!(result.valid, "{:?}", result.errors);
    assert_eq!(result.roles.len(), 55);
    assert_eq!(result.roles["spine"].bone_name, "CC_Base_Waist");
    assert_eq!(result.roles["upperChest"].bone_name, "CC_Base_Spine02");
    assert_eq!(result.roles["leftThumbMetacarpal"].bone_name, "CC_Base_L_Thumb1");
    assert_eq!(result.roles["rightLittleDistal"].bone_name, "CC_Base_R_Pinky3");
}

#[test]
fn optional_parents_can_be_skipped_but_required_optional_parent_chains_cannot() {
    let mut profile = cc4();
    for role in ["chest", "upperChest", "neck", "leftShoulder", "rightShoulder"] {
        profile.humanoid_characterization.as_mut().unwrap().roles.remove(role);
    }
    let result = humanoid::validate(&profile, &cc4_model());
    assert!(result.valid, "{:?}", result.errors);
    for (child,parent) in [("upperChest","chest"),("leftThumbProximal","leftThumbMetacarpal"),
        ("rightIndexIntermediate","rightIndexProximal"),("leftLittleDistal","leftLittleIntermediate")] {
        let mut profile = cc4();
        profile.humanoid_characterization.as_mut().unwrap().roles.remove(parent);
        let result = humanoid::validate(&profile, &cc4_model());
        assert!(!result.valid);
        assert!(result.errors.iter().any(|message| message.contains(child) && message.contains("requires mapped parent")), "{:?}",result.errors);
    }
}

#[test]
fn wrong_semantic_intermediates_toes_and_fingers_are_rejected_but_helper_bones_are_allowed() {
    for (bone,wrong_parent,role) in [("CC_Base_L_ToeBase","CC_Base_R_Foot","leftToes"),
        ("CC_Base_L_Index3","CC_Base_L_Mid2","leftIndexDistal"),
        ("CC_Base_NeckTwist01","CC_Base_Spine01","neck"),
        ("CC_Base_L_Hand","CC_Base_R_Hand","leftHand")] {
        let mut model=cc4_model();
        model.bones.iter_mut().find(|entry| entry.name==bone).unwrap().parent_name=Some(wrong_parent.into());
        let result=humanoid::validate(&cc4(),&model);
        assert!(!result.valid);
        assert!(result.errors.iter().any(|message| message.contains(role) && message.contains("hierarchy")),"{:?}",result.errors);
    }
    // The authored rig already interposes FacialBone before eyes and NeckTwist02 before head.
    assert!(humanoid::validate(&cc4(),&cc4_model()).valid);
}

#[test]
fn uniqueness_checks_aliases_after_model_resolution_and_positive_scales() {
    let mut profile=cc4();
    profile.bone_nodes.insert("EYE_R".into(),"L_Eye".into());
    assert!(humanoid::resolve(&profile).errors.iter().any(|error|error.contains("same bone")));
    // Two differently written aliases still resolve to the same actual descriptor bone.
    profile.bone_nodes.insert("EYE_R".into(),"CC_Base_L_Eye".into());
    assert!(!humanoid::validate(&profile,&cc4_model()).valid);
    for scale in [0.0,-1.0] {
        let mut model=cc4_model();
        model.bones.iter_mut().find(|bone|bone.name=="CC_Base_L_Index3").unwrap().rest_transform=Some(
            serde_json::from_value(json!({"scale":{"x":1,"y":scale,"z":1}})).unwrap());
        let result=humanoid::validate(&cc4(),&model);
        assert!(result.errors.iter().any(|error|error.contains("positive, nonzero")));
    }
}

#[test]
fn every_catalog_control_moves_its_authored_bones_with_signed_and_bilateral_outputs() {
    let profile=cc4();let model=cc4_model();
    let descriptors=crate::body_controls::resolve(&profile,Some(&model));
    assert_eq!(descriptors.as_array().unwrap().len(),58);
    assert!(descriptors.as_array().unwrap().iter().all(|entry|entry["hasBones"]==true));
    let covered: std::collections::BTreeSet<_>=profile.body_controls.values().flat_map(|control|control.roles.iter()).collect();
    assert_eq!(covered.len(),55);
    let mut core=compiled(&profile,&model);
    for (id,control) in &profile.body_controls {
        core.clear();core.set_au(control.au_id,0.5,0.0);
        let positive=core.evaluate_active_bone_frame();
        assert!(!positive.is_empty(),"{id} produces no movement");
        for role in &control.roles {
            let name=crate::body_controls::configured_bone_name(&profile,role);
            let bone=model.bones.iter().find(|bone|bone.name==name).unwrap();
            assert!(positive.chunks_exact(9).any(|row|row[0]==bone.id as f32 && row[4..7].iter().any(|v|v.abs()>0.001)),"{id} doesn't actuate {role}");
        }
        if let Some(negative)=control.negative_au_id {
            core.clear();core.set_continuum(negative,control.au_id,-0.5,0.0);
            let negative=core.evaluate_active_bone_frame();
            assert_eq!(positive.len(),negative.len(),"{id}");
            for (pos,neg) in positive.chunks_exact(9).zip(negative.chunks_exact(9)) {
                assert_eq!(pos[0],neg[0]);
                assert!(pos[4..7].iter().zip(&neg[4..7]).all(|(a,b)|(a+b).abs()<0.0001),"{id} endpoints must be opposite rotations");
            }
        }
        if control.bilateral {
            for (balance,side) in [(-1.0,"left"),(1.0,"right")] {
                core.clear();core.set_au(control.au_id,0.5,balance);
                let rows=core.evaluate_active_bone_frame();
                for role in &control.roles {
                    let name=crate::body_controls::configured_bone_name(&profile,role);
                    let bone=model.bones.iter().find(|bone|bone.name==name).unwrap();
                    let moved=rows.chunks_exact(9).any(|row|row[0]==bone.id as f32 && row[4..7].iter().any(|v|v.abs()>0.001));
                    assert_eq!(moved,role.starts_with(side),"{id}: balance {balance} role {role}");
                }
            }
        }
    }
}

#[test]
fn new_finger_motion_can_mix_bone_skin_and_clothing_targets() {
    let mut profile=cc4();let mut model=cc4_model();
    let action=profile.body_controls["body.indexDistalCurl"].au_id;
    profile.au_to_morphs.insert(action.to_string(),Some(serde_json::from_value(json!({"left":["FingerFlex","SleeveFlex"],"right":[]})).unwrap()));
    profile.morph_to_mesh.insert("body".into(),vec!["Skin".into(),"Glove".into()]);
    profile.au_mix_defaults.insert(action.to_string(),0.25);
    model.meshes=serde_json::from_value(json!([{ "id":201,"name":"Skin","morphTargetIds":[301]},{"id":202,"name":"Glove","morphTargetIds":[302]}])).unwrap();
    model.morph_targets=serde_json::from_value(json!([{ "id":301,"meshId":201,"name":"FingerFlex"},{"id":302,"meshId":202,"name":"SleeveFlex"}])).unwrap();
    let mut core=compiled(&profile,&model);core.set_au(action,0.8,-1.0);
    let morphs=core.evaluate_active_morph_frame();
    assert_eq!(morphs.chunks_exact(4).filter(|row|(row[2]-0.2).abs()<0.0001).count(),2);
    assert!(!core.evaluate_active_bone_frame().is_empty());
}

#[test]
fn legacy_saved_profile_upgrades_all_roles_and_missing_axes_without_overriding_custom_data() {
    let base=cc4();
    let saved=include_str!("../tests/fixtures/legacy-cc4-body-profile.json");
    let merged=crate::profile_merge::extend_preset_with_profile(&base,crate::profile_merge::parse_profile_patch(saved).unwrap());
    assert_eq!(merged.humanoid_characterization.as_ref().unwrap().roles.len(),55);
    assert!(humanoid::validate(&merged,&cc4_model()).valid);
    let mut core=compiled(&merged,&cc4_model());
    for id in ["body.indexDistalCurl","body.forearmTwist","body.chestBend","body.toeBend","body.torsoTwist"] {
        core.clear();core.set_au(merged.body_controls[id].au_id,0.5,0.0);
        assert!(!core.evaluate_active_bone_frame().is_empty(),"saved profile loses {id}");
    }
    assert_eq!(merged.au_to_bones["1004"][0].node,"SPINE_01");
    let mut authored:Value=serde_json::from_str(saved).unwrap();
    authored["humanoidCharacterization"]["roles"]["spine"]["nodeKey"]=json!("SPINE_02");
    let custom=crate::profile_merge::extend_preset_with_profile(&base,crate::profile_merge::parse_profile_patch(&authored.to_string()).unwrap());
    assert_eq!(custom.humanoid_characterization.unwrap().roles.len(),17,"custom characterization stays explicit");
    let mut disabled:Value=serde_json::from_str(saved).unwrap();disabled["compositeRotations"]=json!([]);
    let disabled=crate::profile_merge::extend_preset_with_profile(&base,crate::profile_merge::parse_profile_patch(&disabled.to_string()).unwrap());
    assert!(disabled.composite_rotations.is_empty());
}

#[test]
fn role_editor_remaps_alias_actuation_and_clear_prevents_semantic_name_fallback() {
    let mut profile=cc4();let mut model=cc4_model();
    model.bones.push(serde_json::from_value(json!({"id":501,"name":"NewHead"})).unwrap());
    model.bones.push(serde_json::from_value(json!({"id":502,"name":"head"})).unwrap());
    model.bones.insert(0, serde_json::from_value(json!({"id":503,"name":"CC_Base_NewHead"})).unwrap());
    humanoid::set_role_binding(&mut profile,"head",Some("NewHead")).unwrap();
    assert_eq!(profile.humanoid_characterization.as_ref().unwrap().roles["head"].node_key,"HEAD");
    assert_eq!(humanoid::resolve(&profile).roles["head"].bone_name,"NewHead");
    let mut core=compiled(&profile,&model);core.set_au(51,0.5,0.0);
    assert_eq!(core.evaluate_active_bone_frame()[0],501.0);
    humanoid::set_role_binding(&mut profile,"head",None).unwrap();
    let profile:ProfileData=serde_json::from_str(&serde_json::to_string(&profile).unwrap()).unwrap();
    let mut core=compiled(&profile,&model);core.set_au(51,0.5,0.0);
    assert!(core.evaluate_active_bone_frame().is_empty());
    assert_eq!(profile.humanoid_characterization.as_ref().unwrap().status,"incomplete");
    let mut restored=profile.clone();humanoid::set_role_binding(&mut restored,"head",Some("NewHead")).unwrap();
    let mut core=compiled(&restored,&model);core.set_au(51,0.5,0.0);
    assert_eq!(core.evaluate_active_bone_frame()[0],501.0);
    assert!(humanoid::set_role_binding(&mut restored,"leftEye",Some("CC_Base_R_Eye")).is_err());
    assert!(humanoid::set_role_binding(&mut restored,"notARole",Some("NewHead")).is_err());
    assert!(humanoid::set_role_binding(&mut restored,"head",Some(" ")).is_err());
}

#[test]
fn clearing_role_disables_raw_and_prefixed_aliases_and_custom_metadata_does_not_migrate() {
    for alias in ["L_Forearm", "CC_Base_L_Forearm", "LOWER_ARM_L"] {
        let mut profile=cc4();
        profile.au_to_bones.get_mut("1001").unwrap()[0].node=alias.into();
        profile.composite_rotations.iter_mut().find(|axis|axis.node=="leftLowerArm").unwrap().node=alias.into();
        humanoid::set_role_binding(&mut profile,"leftLowerArm",None).unwrap();
        let mut core=compiled(&profile,&cc4_model());core.set_au(1001,0.5,-1.0);
        assert!(core.evaluate_active_bone_frame().is_empty(),"cleared alias {alias} remains active");
    }
    let mut authored:Value=serde_json::from_str(include_str!("../tests/fixtures/legacy-cc4-body-profile.json")).unwrap();
    authored["humanoidCharacterization"]["roles"]["head"]["exactBoneName"]=json!("CustomHead");
    let result=crate::profile_merge::extend_preset_with_profile(&cc4(),crate::profile_merge::parse_profile_patch(&authored.to_string()).unwrap());
    assert_eq!(result.humanoid_characterization.unwrap().roles.len(),17);
}

#[test]
fn humanoid_root_cannot_descend_from_another_role_and_descriptor_ids_must_be_unique() {
    let mut model=cc4_model();
    model.bones.iter_mut().find(|bone|bone.name=="CC_Base_Hip").unwrap().parent_name=Some("CC_Base_Head".into());
    let result=humanoid::validate(&cc4(),&model);
    assert!(result.errors.iter().any(|error|error.contains("humanoid root")));
    let mut model=cc4_model();
    let head=model.bones.iter().find(|bone|bone.name=="CC_Base_Head").unwrap().id;
    model.bones.iter_mut().find(|bone|bone.name=="CC_Base_L_Eye").unwrap().id=head;
    let result=humanoid::validate(&cc4(),&model);
    assert!(result.errors.iter().any(|error|error.contains("same model bone ID")));
}
