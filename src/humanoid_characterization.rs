//! VRM humanoid characterization resolves standard roles through existing
//! profile node keys. It is metadata and validation only: AU and body-control
//! evaluation continue to use their established bone and morph bindings.

use std::collections::{BTreeMap, HashMap};

use serde::Serialize;

use crate::profile::{HumanoidCharacterizationData, ModelData, ProfileData};

pub const VRMC_VRM_1_STANDARD: &str = "VRMC_vrm-1.0";

const VRM_HUMANOID_ROLES: &[&str] = &[
    "hips",
    "spine",
    "chest",
    "upperChest",
    "neck",
    "head",
    "leftEye",
    "rightEye",
    "jaw",
    "leftShoulder",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightShoulder",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "leftToes",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
    "rightToes",
    "leftThumbMetacarpal",
    "leftThumbProximal",
    "leftThumbDistal",
    "leftIndexProximal",
    "leftIndexIntermediate",
    "leftIndexDistal",
    "leftMiddleProximal",
    "leftMiddleIntermediate",
    "leftMiddleDistal",
    "leftRingProximal",
    "leftRingIntermediate",
    "leftRingDistal",
    "leftLittleProximal",
    "leftLittleIntermediate",
    "leftLittleDistal",
    "rightThumbMetacarpal",
    "rightThumbProximal",
    "rightThumbDistal",
    "rightIndexProximal",
    "rightIndexIntermediate",
    "rightIndexDistal",
    "rightMiddleProximal",
    "rightMiddleIntermediate",
    "rightMiddleDistal",
    "rightRingProximal",
    "rightRingIntermediate",
    "rightRingDistal",
    "rightLittleProximal",
    "rightLittleIntermediate",
    "rightLittleDistal",
];

const REQUIRED_ROLES: &[&str] = &[
    "hips",
    "spine",
    "head",
    "leftUpperArm",
    "leftLowerArm",
    "leftHand",
    "rightUpperArm",
    "rightLowerArm",
    "rightHand",
    "leftUpperLeg",
    "leftLowerLeg",
    "leftFoot",
    "rightUpperLeg",
    "rightLowerLeg",
    "rightFoot",
];

const HIERARCHY_RELATIONSHIPS: &[(&str, &str)] = &[
    ("hips", "spine"),
    ("spine", "head"),
    ("spine", "leftUpperArm"),
    ("leftUpperArm", "leftLowerArm"),
    ("leftLowerArm", "leftHand"),
    ("spine", "rightUpperArm"),
    ("rightUpperArm", "rightLowerArm"),
    ("rightLowerArm", "rightHand"),
    ("hips", "leftUpperLeg"),
    ("leftUpperLeg", "leftLowerLeg"),
    ("leftLowerLeg", "leftFoot"),
    ("hips", "rightUpperLeg"),
    ("rightUpperLeg", "rightLowerLeg"),
    ("rightLowerLeg", "rightFoot"),
];

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
            missing_required_roles: REQUIRED_ROLES
                .iter()
                .map(|role| (*role).to_string())
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
    for resolved in result.roles.values_mut() {
        if let Some(bone) = resolver.resolve_bone(model, profile, &resolved.node_key) {
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

    for (ancestor_role, descendant_role) in HIERARCHY_RELATIONSHIPS {
        let (Some(ancestor), Some(descendant)) = (
            result.roles.get(*ancestor_role),
            result.roles.get(*descendant_role),
        ) else {
            continue;
        };
        if let (Some(ancestor_bone), Some(descendant_bone)) = (
            bone_by_name.get(ancestor.bone_name.as_str()),
            bone_by_name.get(descendant.bone_name.as_str()),
        ) {
            if !is_descendant(
                descendant_bone.parent_name.clone(),
                ancestor_bone.name.as_str(),
                &bone_by_name,
            ) {
                result.errors.push(format!(
                    "VRM hierarchy requires \"{descendant_role}\" to descend from \"{ancestor_role}\"."
                ));
            }
        }
    }

    result.valid = is_usable(&result);
    result
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
        if !VRM_HUMANOID_ROLES.contains(&role.as_str()) {
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
                bone_name: crate::body_controls::configured_bone_name(profile, node_key),
                source: binding.source.clone(),
                confidence: binding.confidence,
            },
        );
    }

    result.missing_required_roles = REQUIRED_ROLES
        .iter()
        .filter(|role| !result.roles.contains_key(**role))
        .map(|role| (*role).to_string())
        .collect();
    if characterization.status == "verified-vrm" && !result.missing_required_roles.is_empty() {
        result.errors.push(
            "A verified VRM characterization must include every required VRM role.".to_string(),
        );
    }
}

fn is_descendant(
    mut parent_name: Option<String>,
    expected_ancestor: &str,
    bones: &HashMap<&str, &crate::profile::BoneData>,
) -> bool {
    let mut visited = std::collections::HashSet::new();
    while let Some(name) = parent_name {
        if !visited.insert(name.clone()) {
            return false;
        }
        if name == expected_ancestor {
            return true;
        }
        parent_name = bones
            .get(name.as_str())
            .and_then(|bone| bone.parent_name.clone());
    }
    false
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
