//! Portable action-space poses. VRM supplies anatomy; the profile supplies motions.
use std::collections::{BTreeMap, BTreeSet};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use crate::profile::{ProfileData, ModelData};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Channel {
    pub intensity: f32,
    #[serde(default)] pub balance: f32,
    #[serde(default, skip_serializing_if="Option::is_none")] pub morph_strength: Option<f32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct PoseControl {
    pub control_id: String,
    #[serde(default, skip_serializing_if="Option::is_none")] pub positive: Option<Channel>,
    #[serde(default, skip_serializing_if="Option::is_none")] pub negative: Option<Channel>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Pose { pub version: u32, pub controls: Vec<PoseControl> }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Keyframe { pub time: f64, pub intensity: f32 }
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Track {
    pub control_id: String, pub direction: String,
    #[serde(default)] pub balance: f32,
    #[serde(default)] pub morph_strength: Option<f32>,
    pub keyframes: Vec<Keyframe>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct Animation { pub version: u32, pub duration_seconds: f64, pub tracks: Vec<Track> }

pub(crate) fn catalog(profile: &ProfileData, model: Option<&ModelData>) -> Value {
    let descriptors = crate::body_controls::resolve(profile, model);
    Value::Array(descriptors.as_array().unwrap().iter().map(|descriptor| {
        let id = descriptor["id"].as_str().unwrap();
        let control = &profile.body_controls[id];
        let direction = |au: u32| {
            let mut single = profile.clone();
            single.body_controls.retain(|key,_| key == id);
            let row = single.body_controls.get_mut(id).unwrap();
            row.au_id = au; row.negative_au_id = None;
            let resolved = crate::body_controls::resolve(&single, model);
            let support = &resolved[0];
            let key = au.to_string();
            let available_sides:Vec<_>=["left","right","center"].into_iter().filter(|side| {
                let mut sided=single.clone();
                if let Some(bindings)=sided.au_to_bones.get_mut(&key) {
                    bindings.retain(|binding|binding.side.as_deref().unwrap_or("center")==*side);
                }
                if let Some(Some(entry))=sided.au_to_morphs.get_mut(&key) {
                    if *side!="left"{entry.left.clear();}if *side!="right"{entry.right.clear();}if *side!="center"{entry.center.clear();}
                }
                crate::body_controls::resolve(&sided,model)[0]["available"]==true
            }).collect();
            let label = profile.action_info.get(&key).or_else(|| profile.au_info.get(&key))
                .and_then(|info| info.name.as_deref()).unwrap_or(&control.label);
            json!({"auId":au,"label":label,"available":support["available"],
                "hasBones":support["hasBones"],"hasMorphs":support["hasMorphs"],"availableSides":available_sides,
                "morphStrength":profile.au_mix_defaults.get(&key).copied().unwrap_or(1.0)})
        };
        let names:BTreeSet<_> = descriptor["boneBindings"].as_array().unwrap().iter()
            .filter_map(|binding| binding["boneName"].as_str()).collect();
        let aus:Vec<_>=[Some(control.au_id),control.negative_au_id].into_iter().flatten().collect();
        let resolver=model.map(|model|crate::profile::NameResolver::new(profile,model));
        let mut morph_names=BTreeSet::new();
        for au in aus { if let Some(Some(entry))=profile.au_to_morphs.get(&au.to_string()) {
            for target in entry.left.iter().chain(&entry.right).chain(&entry.center) {
                if let (Some(model),Some(resolver))=(model,resolver.as_ref()) {
                    for (_,target_id) in resolver.resolve_au_morph(profile,au,target) {
                        if let Some(target)=model.morph_targets.iter().find(|target|target.id==target_id){morph_names.insert(target.name.clone());}
                    }
                }
            }
        }}
        let mut item=json!({"id":id,"label":control.label,"section":control.section,
            "roles":control.roles,"bilateral":control.bilateral,"boneNames":names,"morphNames":morph_names,
            "positive":direction(control.au_id)});
        if let Some(au)=control.negative_au_id.filter(|id| *id!=control.au_id) { item["negative"]=direction(au); }
        item
    }).collect())
}
fn bounded(value:f32,low:f32,high:f32,name:&str)->Result<(),String>{
    if !value.is_finite() || value<low || value>high {Err(format!("{name} must be finite in [{low},{high}]"))} else {Ok(())}
}
fn channel(profile:&ProfileData,id:&str,au:u32,bilateral:bool,value:&Channel)->Result<Channel,String>{
    bounded(value.intensity,0.,1.,"intensity")?; bounded(value.balance,-1.,1.,"balance")?;
    if !bilateral && value.balance!=0. {return Err(format!("{id} is not bilateral"));}
    let strength=value.morph_strength.unwrap_or_else(|| profile.au_mix_defaults.get(&au.to_string()).copied().unwrap_or(1.0) as f32);
    bounded(strength,0.,1.,"morphStrength")?;
    Ok(Channel{morph_strength:Some(strength),..value.clone()})
}
pub(crate) fn validate_pose(profile:&ProfileData,pose:&Pose)->Result<BTreeMap<u32,Channel>,String>{
    if pose.version!=1 {return Err("Unsupported semantic pose version".into());}
    let mut controls=BTreeSet::new();let mut actions=BTreeMap::new();
    for row in &pose.controls {
        if !controls.insert(&row.control_id){return Err("Duplicate semantic control".into());}
        let control=profile.body_controls.get(&row.control_id).ok_or_else(||format!("Unknown semantic control {}",row.control_id))?;
        if row.positive.is_none() && row.negative.is_none() {return Err("Control requires a direction".into());}
        for (au,value) in [(Some(control.au_id),row.positive.as_ref()),(control.negative_au_id,row.negative.as_ref())] {
            if let Some(value)=value {
                let au=au.ok_or("Control has no negative direction")?;
                let value=channel(profile,&row.control_id,au,control.bilateral,value)?;
                if actions.insert(au,value).is_some(){return Err("Multiple controls address the same action".into());}
            }
        }
    }
    Ok(actions)
}
pub(crate) fn validate_animation(profile:&ProfileData,model:Option<&ModelData>,animation:&Animation)->Result<Vec<(u32,Channel,Vec<Keyframe>)>,String>{
    if animation.version!=1{return Err("Unsupported semantic animation version".into());}
    if !animation.duration_seconds.is_finite()||animation.duration_seconds<=0.||animation.duration_seconds>300. {return Err("durationSeconds must be in (0,300]".into());}
    let catalog=catalog(profile,model);let mut seen=BTreeSet::new();let mut result=Vec::new();
    for track in &animation.tracks {
        let control=profile.body_controls.get(&track.control_id).ok_or_else(||format!("Unknown semantic control {}",track.control_id))?;
        let au=match track.direction.as_str(){"positive"=>control.au_id,"negative"=>control.negative_au_id.ok_or("Control has no negative direction")?,_=>return Err("Unknown semantic direction".into())};
        if !seen.insert(au){return Err("Duplicate semantic animation action".into());}
        let entry=catalog.as_array().unwrap().iter().find(|item|item["id"]==track.control_id).unwrap();
        if entry[&track.direction]["available"]!=true{return Err(format!("Unavailable semantic direction {} {}",track.control_id,track.direction));}
        let value=channel(profile,&track.control_id,au,control.bilateral,&Channel{intensity:0.,balance:track.balance,morph_strength:track.morph_strength})?;
        let requested_side=if track.balance<0.{Some("left")}else if track.balance>0.{Some("right")}else{None};
        if let Some(side)=requested_side {if !entry[&track.direction]["availableSides"].as_array().unwrap().iter().any(|value|value==side){return Err(format!("Unavailable semantic side {side}"));}}
        if track.keyframes.is_empty()||track.keyframes.len()>10000{return Err("A semantic track needs 1..10000 keyframes".into());}
        let mut last=-1.;
        for point in &track.keyframes {
            bounded(point.intensity,0.,1.,"intensity")?;
            if !point.time.is_finite()||point.time<0.||point.time>animation.duration_seconds||point.time<=last{return Err("Keyframe times must increase within the duration".into());}last=point.time;
        }
        result.push((au,value,track.keyframes.clone()));
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeCore;
    fn profile()->ProfileData { serde_json::from_value(json!({
        "bodyControls":{"body.elbowFlex":{"label":"Elbow flex","section":"Arms","auId":1001,"negativeAuId":1002,"bilateral":true,"roles":["leftLowerArm","rightLowerArm"]}},
        "auInfo":{"1001":{"name":"Flex"},"1002":{"name":"Extend"}},
        "auToMorphs":{"1001":{"left":["FlexL"],"right":["FlexR"]},"1002":{"center":["Extend"]},"12":{"center":["Smile"]}},
        "auMixDefaults":{"1001":0.6,"1002":0.4},"morphToMesh":{"face":["Body"]}
    })).unwrap() }
    fn model()->ModelData {serde_json::from_value(json!({"meshes":[{"id":1,"name":"Body","morphTargetIds":[1,2,3,4]}],"morphTargets":[
        {"id":1,"meshId":1,"name":"FlexL","hostIndex":0},{"id":2,"meshId":1,"name":"FlexR","hostIndex":1},
        {"id":3,"meshId":1,"name":"Extend","hostIndex":2},{"id":4,"meshId":1,"name":"Smile","hostIndex":3}]})).unwrap()}
    fn pose()->Pose {serde_json::from_value(json!({"version":1,"controls":[{"controlId":"body.elbowFlex","positive":{"intensity":0.7,"balance":-0.5,"morphStrength":0.3},"negative":{"intensity":0.2,"balance":0.8,"morphStrength":0.9}}]})).unwrap()}
    #[test]
    fn catalog_uses_authored_directions_and_actual_morph_names_and_support(){
        let full=catalog(&profile(),Some(&model()));
        assert_eq!(full[0]["positive"]["label"],"Flex");assert_eq!(full[0]["negative"]["label"],"Extend");
        assert_eq!(full[0]["positive"]["available"],true);assert_eq!(full[0]["morphNames"],json!(["Extend","FlexL","FlexR"]));
        let empty=catalog(&profile(),Some(&ModelData::default()));assert_eq!(empty[0]["positive"]["available"],false);
        assert_eq!(catalog(&ProfileData::default(),None),json!([]));
    }
    #[test]
    fn pose_roundtrip_preserves_both_directions_mix_balance_and_unrelated_facs(){
        let mut runtime=RuntimeCore::new(0);runtime.configure_with_profile(&serde_json::to_string(&profile()).unwrap(),&serde_json::to_string(&model()).unwrap()).unwrap();
        runtime.set_au(12,0.8,0.);
        runtime.apply_semantic_pose_json(&serde_json::to_string(&pose()).unwrap()).unwrap();
        let captured=runtime.capture_semantic_pose_json();
        assert_eq!(serde_json::from_str::<Value>(&captured).unwrap(),serde_json::from_str::<Value>(&serde_json::to_string(&pose()).unwrap()).unwrap());
        runtime.reset_body_controls();runtime.apply_semantic_pose_json(&captured).unwrap();
        assert_eq!(runtime.get_au(1001),0.7);assert_eq!(runtime.get_au(1002),0.2);assert_eq!(runtime.get_au_balance(1002),0.8);assert_eq!(runtime.get_au(12),0.8);
        runtime.apply_semantic_pose_json(r#"{"version":1,"controls":[]}"#).unwrap();assert_eq!(runtime.get_au(1001),0.);assert_eq!(runtime.get_au(12),0.8);
        assert_eq!(serde_json::from_str::<Value>(&runtime.capture_semantic_pose_json()).unwrap()["controls"][0]["positive"]["morphStrength"],json!(0.6));
    }
    #[test]
    fn pose_validation_rejects_invalid_and_allows_known_partial_rig(){
        let base=profile();let mut value=pose();
        assert!(validate_pose(&base,&value).is_ok());value.controls[0].positive.as_mut().unwrap().intensity=1.1;assert!(validate_pose(&base,&value).is_err());
        value=pose();value.controls.push(value.controls[0].clone());assert!(validate_pose(&base,&value).is_err());
        value=pose();value.controls[0].control_id="invented".into();assert!(validate_pose(&base,&value).is_err());
        value=pose();value.controls[0].positive.as_mut().unwrap().morph_strength=Some(f32::NAN);assert!(validate_pose(&base,&value).is_err());
        value=pose();value.controls[0].positive.as_mut().unwrap().morph_strength=None;assert_eq!(validate_pose(&base,&value).unwrap()[&1001].morph_strength,Some(0.6));
        assert!(serde_json::from_value::<Pose>(json!({"version":1,"controls":[],"bones":[]})).is_err());
    }
    #[test]
    fn animation_validation_rejects_unavailable_duplicates_unknown_and_bad_times(){
        let mut anim:Animation=serde_json::from_value(json!({"version":1,"durationSeconds":1,"tracks":[{"controlId":"body.elbowFlex","direction":"positive","keyframes":[{"time":0,"intensity":0},{"time":1,"intensity":0.5}]}]})).unwrap();
        assert!(validate_animation(&profile(),Some(&model()),&anim).is_ok());
        assert!(validate_animation(&profile(),Some(&ModelData::default()),&anim).is_err());
        anim.tracks.push(anim.tracks[0].clone());assert!(validate_animation(&profile(),Some(&model()),&anim).is_err());anim.tracks.pop();
        anim.tracks[0].keyframes[1].time=0.;assert!(validate_animation(&profile(),Some(&model()),&anim).is_err());
        anim.tracks[0].keyframes[1].time=2.;assert!(validate_animation(&profile(),Some(&model()),&anim).is_err());
    }
    #[test]
    fn semantic_clip_combines_face_and_body_without_mutating_live_settings(){
        let mut runtime=RuntimeCore::new(0);runtime.configure_with_profile(&serde_json::to_string(&profile()).unwrap(),&serde_json::to_string(&model()).unwrap()).unwrap();
        runtime.apply_semantic_pose_json(&serde_json::to_string(&pose()).unwrap()).unwrap();let before=runtime.capture_semantic_pose_json();
        let clip:Value=serde_json::from_str(&runtime.build_semantic_clip("test",r#"{"version":1,"durationSeconds":2,"tracks":[{"controlId":"body.elbowFlex","direction":"positive","balance":-1,"morphStrength":0.25,"keyframes":[{"time":0,"intensity":0},{"time":1,"intensity":0.5}]}]}"#,r#"{"faceCurves":{"12":[{"time":0,"intensity":0},{"time":1,"intensity":0.8}]}}"#).unwrap()).unwrap();
        assert_eq!(clip["durationSeconds"],2.);assert_eq!(before,runtime.capture_semantic_pose_json());
        let tracks=clip["tracks"].as_array().unwrap();assert!(tracks.iter().any(|track|track["target"]["morphTargetId"]==4));
        assert!(tracks.iter().any(|track|track["target"]["morphTargetId"]==1&&track["values"][1]==0.125), "{tracks:?}");
    }
    #[test]
    fn shared_head_neck_style_morphs_use_max_envelope_including_crossings(){
        let mut profile=profile();profile.au_to_morphs.insert("12".into(),profile.au_to_morphs["1001"].clone());
        let mut runtime=RuntimeCore::new(0);runtime.configure_with_profile(&serde_json::to_string(&profile).unwrap(),&serde_json::to_string(&model()).unwrap()).unwrap();
        let clip:Value=serde_json::from_str(&runtime.build_semantic_clip("shared",r#"{"version":1,"durationSeconds":1,"tracks":[{"controlId":"body.elbowFlex","direction":"positive","balance":-1,"morphStrength":1,"keyframes":[{"time":0,"intensity":0},{"time":1,"intensity":1}]}]}"#,r#"{"faceCurves":{"12":[{"time":0,"intensity":1},{"time":1,"intensity":0}]}}"#).unwrap()).unwrap();
        let tracks:Vec<_>=clip["tracks"].as_array().unwrap().iter().filter(|t|t["target"]["morphTargetId"]==1).collect();
        assert_eq!(tracks.len(),1);assert_eq!(tracks[0]["times"],json!([0.,0.5,1.]));assert_eq!(tracks[0]["values"],json!([1.,0.5,1.]));
    }

    #[test]
    fn partial_bilateral_catalog_rejects_animation_toward_absent_side(){
        let mut model=model();model.morph_targets.retain(|target|target.name!="FlexR");
        let catalog=catalog(&profile(),Some(&model));assert_eq!(catalog[0]["positive"]["availableSides"],json!(["left"]));
        let mut animation:Animation=serde_json::from_value(json!({"version":1,"durationSeconds":1,"tracks":[{"controlId":"body.elbowFlex","direction":"positive","balance":1,"keyframes":[{"time":0,"intensity":0.5}]}]})).unwrap();
        assert!(validate_animation(&profile(),Some(&model),&animation).is_err());
        animation.tracks[0].balance=-1.;assert!(validate_animation(&profile(),Some(&model),&animation).is_ok());
        animation.tracks[0].balance=0.;assert!(validate_animation(&profile(),Some(&model),&animation).is_ok());
    }
    #[test]
    fn applying_pose_releases_only_owned_mesh_target_overrides(){
        let mut model=model();model.meshes.push(serde_json::from_value(json!({"id":2,"name":"Other","morphTargetIds":[5]})).unwrap());
        model.morph_targets.push(serde_json::from_value(json!({"id":5,"meshId":2,"name":"FlexL","hostIndex":0})).unwrap());
        let mut runtime=RuntimeCore::new(0);runtime.configure_with_profile(&serde_json::to_string(&profile()).unwrap(),&serde_json::to_string(&model).unwrap()).unwrap();
        runtime.set_morph("FlexL",0.9,r#"["Body","Other"]"#);runtime.set_morph("Smile",0.8,r#"["Body"]"#);
        runtime.apply_semantic_pose_json(r#"{"version":1,"controls":[{"controlId":"body.elbowFlex","positive":{"intensity":0.5,"balance":-1,"morphStrength":0.5}}]}"#).unwrap();
        let frame=runtime.evaluate_active_morph_frame();let rows:Vec<_>=frame.chunks_exact(4).collect();
        assert!(rows.iter().any(|row|row[0]==1.&&row[1]==1.&&row[2]==0.25));
        assert!(rows.iter().any(|row|row[0]==2.&&row[1]==5.&&row[2]==0.9));
        assert!(rows.iter().any(|row|row[0]==1.&&row[1]==4.&&row[2]==0.8));
    }

}
