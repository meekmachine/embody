//! VRM humanoid characterization resolves standard roles through existing
//! profile node keys. It is metadata and validation only: AU and body-control
//! evaluation continue to use their established bone and morph bindings.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::profile::{HumanoidCharacterizationData, ModelData, ProfileData};

pub const VRMC_VRM_1_STANDARD: &str = "VRMC_vrm-1.0";

/// Canonical VRM 1.0 anatomy metadata shared by validation and host authoring UI.
#[derive(serde::Deserialize, Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HumanoidBoneSpecification {
    pub role: String,
    pub label: String,
    pub section: String,
    pub parent: Option<String>,
    pub required: bool,
    pub requires_parent: bool,
}

#[derive(serde::Deserialize, Serialize, Debug)]
pub struct HumanoidSpecification {
    pub standard: String,
    pub bones: Vec<HumanoidBoneSpecification>,
}

pub fn specification() -> &'static HumanoidSpecification {
    static SPEC: std::sync::OnceLock<HumanoidSpecification> = std::sync::OnceLock::new();
    SPEC.get_or_init(|| serde_json::from_str(include_str!("../assets/vrm-humanoid-specification.json"))
        .expect("embedded VRM humanoid specification must be valid"))
}

fn required_roles() -> impl Iterator<Item = &'static str> {
    specification().bones.iter().filter(|bone| bone.required).map(|bone| bone.role.as_str())
}

pub(crate) fn bone_specification(role: &str) -> Option<&'static HumanoidBoneSpecification> {
    specification().bones.iter().find(|bone| bone.role == role)
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedHumanoidRole {
    pub node_key: String,
    pub bone_name: String,
    pub source: Option<String>,
    pub confidence: Option<f64>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HumanoidCharacterizationResolution {
    pub schema_version: Option<u32>,
    pub standard: Option<String>,
    pub status: Option<String>,
    pub roles: BTreeMap<String, ResolvedHumanoidRole>,
    pub missing_required_roles: Vec<String>,
    pub errors: Vec<String>,
    pub warnings: Vec<String>,
    pub valid: bool,
}

pub fn resolve(profile: &ProfileData) -> HumanoidCharacterizationResolution {
    let Some(characterization) = &profile.humanoid_characterization else {
        return HumanoidCharacterizationResolution {
            schema_version: None,
            standard: None,
            status: None,
            roles: BTreeMap::new(),
            missing_required_roles: required_roles()
                .map(str::to_string)
                .collect(),
            errors: vec!["Profile has no humanoidCharacterization.".to_string()],
            warnings: Vec::new(),
            valid: false,
        };
    };

    let mut result = HumanoidCharacterizationResolution {
        schema_version: Some(characterization.schema_version),
        standard: Some(characterization.standard.clone()),
        status: Some(characterization.status.clone()),
        roles: BTreeMap::new(),
        missing_required_roles: Vec::new(),
        errors: Vec::new(),
        warnings: Vec::new(),
        valid: false,
    };
    validate_metadata(profile, characterization, &mut result);
    result.valid = is_usable(&result);
    result
}

pub fn validate(profile: &ProfileData, model: &ModelData) -> HumanoidCharacterizationResolution {
    let mut result = resolve(profile);
    let resolver = crate::profile::NameResolver::new(profile, model);
    for (role, resolved) in &mut result.roles {
        if let Some(bone) = resolver.resolve_bone(model, profile, role) {
            resolved.bone_name = bone.name.clone();
        }
    }
    let bone_by_name = model
        .bones
        .iter()
        .map(|bone| (bone.name.as_str(), bone))
        .collect::<HashMap<_, _>>();

    for (role, resolved) in &result.roles {
        if !bone_by_name.contains_key(resolved.bone_name.as_str()) {
            result.errors.push(format!(
                "Role \"{role}\" resolves to \"{}\", which is absent from the model descriptor.",
                resolved.bone_name
            ));
        }
    }

    let mut role_by_bone = HashMap::new();
    for (role, resolved) in &result.roles {
        if let Some(previous) = role_by_bone.insert(resolved.bone_name.as_str(), role.as_str()) {
            result.errors.push(format!("VRM roles \"{previous}\" and \"{role}\" resolve to the same bone \"{}\".", resolved.bone_name));
        }
        if let Some(bone) = bone_by_name.get(resolved.bone_name.as_str()) {
            if let Some(scale) = bone.rest_transform.as_ref().and_then(|transform| transform.scale.as_ref()) {
                if [scale.x, scale.y, scale.z].iter().any(|value| !value.is_finite() || *value <= 0.0) {
                    result.errors.push(format!("VRM role \"{role}\" requires positive, nonzero rest scale components."));
                }
            }
        }
    }
    for (role, resolved) in &result.roles {
        let Some(spec) = bone_specification(role) else { continue; };
        let mut expected_parent = spec.parent.as_deref();
        while let Some(parent) = expected_parent {
            if result.roles.contains_key(parent) { break; }
            expected_parent = bone_specification(parent).and_then(|bone| bone.parent.as_deref());
        }
        let Some(expected_parent) = expected_parent else { continue; };
        let Some(bone) = bone_by_name.get(resolved.bone_name.as_str()) else { continue; };
        // VRM permits intermediate non-humanoid nodes, but the nearest mapped
        // humanoid ancestor must be the prescribed (possibly skipped) parent.
        let mut parent = bone.parent_name.as_deref();
        let mut visited = std::collections::HashSet::new();
        let mut actual_parent = None;
        while let Some(name) = parent {
            if !visited.insert(name) { break; }
            if let Some(role) = role_by_bone.get(name) { actual_parent = Some(*role); break; }
            parent = bone_by_name.get(name).and_then(|bone| bone.parent_name.as_deref());
        }
        if actual_parent != Some(expected_parent) {
            result.errors.push(format!("VRM hierarchy requires \"{role}\" to descend from \"{expected_parent}\" without another humanoid role in between."));
        }
    }

    result.valid = is_usable(&result);
    result
}

/// Author a role without leaving old AU aliases driving a cleared/reassigned bone.
pub fn set_role_binding(profile: &mut ProfileData, role: &str, bone_name: Option<&str>) -> Result<(), String> {
    if bone_specification(role).is_none() { return Err(format!("Unknown VRM humanoid role \"{role}\".")); }
    if bone_name.is_some_and(|name| name.trim().is_empty()) { return Err("boneName must be a nonempty bone name or null.".into()); }
    let old_key = profile.humanoid_characterization.as_ref().and_then(|mapping| mapping.roles.get(role)).map(|binding| binding.node_key.clone());
    let old_name = old_key.as_ref().map(|key| crate::body_controls::configured_bone_name(profile, key));
    if let Some(name) = bone_name {
        if profile.humanoid_characterization.as_ref().is_some_and(|mapping| mapping.roles.iter().any(|(other, binding)|
            other != role && (crate::body_controls::configured_bone_name(profile, &binding.node_key) == name
                || profile.bone_nodes.get(&binding.node_key).is_some_and(|configured| configured == name)))) {
            return Err(format!("Bone \"{name}\" is already assigned to another humanoid role."));
        }
    }
    if let Some(old_name) = old_name {
        let aliases: std::collections::HashSet<String> = profile.bone_nodes.iter()
            .filter(|(key, _)| crate::body_controls::configured_bone_name(profile, key) == old_name)
            .flat_map(|(key, value)| [key.clone(), value.clone()]).collect();
        let matches = |node: &str| node == role || node == old_name || aliases.contains(node);
        for binding in profile.au_to_bones.values_mut().flatten() {
            if matches(&binding.node) { binding.node = role.into(); }
        }
        if !profile.composite_rotations.is_unspecified() {
            for composite in profile.composite_rotations.iter_mut() {
                if matches(&composite.node) { composite.node = role.into(); }
            }
        }
        for pair in profile.continuum_pairs.values_mut().flatten() {
            if pair.node.as_deref().is_some_and(matches) { pair.node = Some(role.into()); }
        }
    }
    let mapping = profile.humanoid_characterization.get_or_insert_with(|| HumanoidCharacterizationData {
        schema_version: 1, standard: VRMC_VRM_1_STANDARD.into(), status: "incomplete".into(), ..Default::default()
    });
    mapping.extensions.insert("authored".into(), serde_json::json!(true));
    if let Some(name) = bone_name {
        let key = old_key.unwrap_or_else(|| format!("HUMANOID_{role}"));
        profile.bone_nodes.insert(key.clone(), name.to_string());
        mapping.roles.insert(role.into(), crate::profile::HumanoidRoleData { node_key: key, exact_bone_name: Some(name.into()), source: Some("authored".into()), ..Default::default() });
    } else { mapping.roles.remove(role); }
    mapping.status = "characterized".into();
    if !resolve(profile).valid { profile.humanoid_characterization.as_mut().unwrap().status = "incomplete".into(); }
    Ok(())
}

fn validate_metadata(
    profile: &ProfileData,
    characterization: &HumanoidCharacterizationData,
    result: &mut HumanoidCharacterizationResolution,
) {
    if characterization.schema_version != 1 {
        result.errors.push(format!(
            "Unsupported humanoidCharacterization schemaVersion {}; expected 1.",
            characterization.schema_version
        ));
    }
    if characterization.standard != VRMC_VRM_1_STANDARD {
        result.errors.push(format!(
            "Unsupported humanoid characterization standard \"{}\"; expected \"{VRMC_VRM_1_STANDARD}\".",
            characterization.standard
        ));
    }
    if !matches!(
        characterization.status.as_str(),
        "verified-vrm" | "characterized" | "incomplete"
    ) {
        result.errors.push(format!(
            "Unsupported humanoid characterization status \"{}\".",
            characterization.status
        ));
    }

    for (role, binding) in &characterization.roles {
        if bone_specification(role).is_none() {
            result
                .errors
                .push(format!("Unknown VRM humanoid role \"{role}\"."));
            continue;
        }
        let node_key = binding.node_key.trim();
        if node_key.is_empty() {
            result
                .errors
                .push(format!("Role \"{role}\" has an empty nodeKey."));
            continue;
        }
        let Some(_) = profile.bone_nodes.get(node_key) else {
            result.errors.push(format!(
                "Role \"{role}\" refers to nodeKey \"{node_key}\", which is not declared in boneNodes."
            ));
            continue;
        };
        if binding
            .confidence
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            result
                .errors
                .push(format!("Role \"{role}\" has confidence outside 0..=1."));
            continue;
        }
        result.roles.insert(
            role.clone(),
            ResolvedHumanoidRole {
                node_key: node_key.to_string(),
                bone_name: crate::body_controls::configured_bone_name(profile, role),
                source: binding.source.clone(),
                confidence: binding.confidence,
            },
        );
    }

    let mut role_by_bone = HashMap::new();
    for (role, resolved) in &result.roles {
        if let Some(previous) = role_by_bone.insert(resolved.bone_name.as_str(), role.as_str()) {
            result.errors.push(format!("VRM roles \"{previous}\" and \"{role}\" map to the same bone \"{}\".", resolved.bone_name));
        }
        if let Some(spec) = bone_specification(role) {
            if spec.requires_parent && spec.parent.as_ref().is_some_and(|parent| !result.roles.contains_key(parent)) {
                result.errors.push(format!("VRM role \"{role}\" requires mapped parent \"{}\".", spec.parent.as_ref().unwrap()));
            }
        }
    }

    result.missing_required_roles = required_roles()
        .filter(|role| !result.roles.contains_key(*role))
        .map(str::to_string)
        .collect();
    if characterization.status == "verified-vrm" && !result.missing_required_roles.is_empty() {
        result.errors.push(
            "A verified VRM characterization must include every required VRM role.".to_string(),
        );
    }
}

fn is_usable(result: &HumanoidCharacterizationResolution) -> bool {
    result.errors.is_empty()
        && result.missing_required_roles.is_empty()
        && result.status.as_deref() != Some("incomplete")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn profile() -> ProfileData {
        serde_json::from_value(json!({
            "boneNodes": {
                "HIPS": "Hips", "SPINE": "Spine", "HEAD": "Head",
                "UPPERARM_L": "LeftUpperArm", "LOWERARM_L": "LeftLowerArm", "HAND_L": "LeftHand",
                "UPPERARM_R": "RightUpperArm", "LOWERARM_R": "RightLowerArm", "HAND_R": "RightHand",
                "UPPERLEG_L": "LeftUpperLeg", "LOWERLEG_L": "LeftLowerLeg", "FOOT_L": "LeftFoot",
                "UPPERLEG_R": "RightUpperLeg", "LOWERLEG_R": "RightLowerLeg", "FOOT_R": "RightFoot"
            },
            "humanoidCharacterization": {
                "schemaVersion": 1, "standard": "VRMC_vrm-1.0", "status": "characterized",
                "roles": {
                    "hips": { "nodeKey": "HIPS" }, "spine": { "nodeKey": "SPINE" }, "head": { "nodeKey": "HEAD" },
                    "leftUpperArm": { "nodeKey": "UPPERARM_L" }, "leftLowerArm": { "nodeKey": "LOWERARM_L" }, "leftHand": { "nodeKey": "HAND_L" },
                    "rightUpperArm": { "nodeKey": "UPPERARM_R" }, "rightLowerArm": { "nodeKey": "LOWERARM_R" }, "rightHand": { "nodeKey": "HAND_R" },
                    "leftUpperLeg": { "nodeKey": "UPPERLEG_L" }, "leftLowerLeg": { "nodeKey": "LOWERLEG_L" }, "leftFoot": { "nodeKey": "FOOT_L" },
                    "rightUpperLeg": { "nodeKey": "UPPERLEG_R" }, "rightLowerLeg": { "nodeKey": "LOWERLEG_R" }, "rightFoot": { "nodeKey": "FOOT_R" }
                }
            }
        })).unwrap()
    }

    fn model() -> ModelData {
        serde_json::from_value(json!({ "bones": [
            { "id": 1, "name": "Hips" }, { "id": 2, "name": "Spine", "parentName": "Hips" }, { "id": 3, "name": "Head", "parentName": "Spine" },
            { "id": 4, "name": "LeftUpperArm", "parentName": "Spine" }, { "id": 5, "name": "LeftLowerArm", "parentName": "LeftUpperArm" }, { "id": 6, "name": "LeftHand", "parentName": "LeftLowerArm" },
            { "id": 7, "name": "RightUpperArm", "parentName": "Spine" }, { "id": 8, "name": "RightLowerArm", "parentName": "RightUpperArm" }, { "id": 9, "name": "RightHand", "parentName": "RightLowerArm" },
            { "id": 10, "name": "LeftUpperLeg", "parentName": "Hips" }, { "id": 11, "name": "LeftLowerLeg", "parentName": "LeftUpperLeg" }, { "id": 12, "name": "LeftFoot", "parentName": "LeftLowerLeg" },
            { "id": 13, "name": "RightUpperLeg", "parentName": "Hips" }, { "id": 14, "name": "RightLowerLeg", "parentName": "RightUpperLeg" }, { "id": 15, "name": "RightFoot", "parentName": "RightLowerLeg" }
        ] })).unwrap()
    }

    #[test]
    fn resolves_roles_through_profile_node_keys() {
        let resolved = resolve(&profile());
        assert!(resolved.valid);
        assert_eq!(resolved.roles["leftUpperArm"].node_key, "UPPERARM_L");
        assert_eq!(resolved.roles["leftUpperArm"].bone_name, "LeftUpperArm");
    }

    #[test]
    fn validates_required_roles_against_model_hierarchy() {
        let resolved = validate(&profile(), &model());
        assert!(resolved.valid, "{:?}", resolved.errors);
    }

    #[test]
    fn validates_bone_affixes_using_the_runtime_resolver() {
        let mut profile = profile();
        profile.bone_prefix = Some("Rig_".into());
        profile.bone_suffix = Some("_Joint".into());
        let mut model = model();
        for bone in &mut model.bones {
            bone.name = format!("Rig_{}_Joint", bone.name);
            bone.parent_name = bone.parent_name.as_ref().map(|name| format!("Rig_{name}_Joint"));
        }
        assert_eq!(resolve(&profile).roles["head"].bone_name, "Rig_Head_Joint");
        let resolved = validate(&profile, &model);
        assert!(resolved.valid, "{:?}", resolved.errors);
    }

    #[test]
    fn rejects_direct_role_to_bone_bindings() {
        let mut profile = profile();
        profile
            .humanoid_characterization
            .as_mut()
            .unwrap()
            .roles
            .get_mut("head")
            .unwrap()
            .node_key = "Head".to_string();
        let resolved = resolve(&profile);
        assert!(!resolved.valid);
        assert!(resolved
            .errors
            .iter()
            .any(|error| error.contains("not declared in boneNodes")));
    }

    #[test]
    fn reports_model_hierarchy_and_missing_bone_diagnostics() {
        let mut invalid_hierarchy = model();
        invalid_hierarchy
            .bones
            .iter_mut()
            .find(|bone| bone.name == "LeftHand")
            .unwrap()
            .parent_name = Some("Hips".to_string());
        let hierarchy = validate(&profile(), &invalid_hierarchy);
        assert!(!hierarchy.valid);
        assert!(hierarchy
            .errors
            .iter()
            .any(|error| error.contains("leftHand") && error.contains("leftLowerArm")));

        let mut missing_bone = model();
        missing_bone.bones.retain(|bone| bone.name != "Head");
        let unresolved = validate(&profile(), &missing_bone);
        assert!(!unresolved.valid);
        assert!(unresolved
            .errors
            .iter()
            .any(|error| error.contains("head") && error.contains("absent")));
    }
}
