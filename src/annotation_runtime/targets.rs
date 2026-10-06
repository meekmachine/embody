use super::geometry::{has, number, side, strings, text};
use serde_json::{json, Value};

pub const PREFIX: &str = "runtime:annotation:";
fn segment(value: &str) -> String {
    let mut result = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            result.push(byte as char);
        } else {
            result.push_str(&format!("~{byte:02X}"));
        }
    }
    result
}
fn read_side(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|s| ["left", "right", "center"].contains(s))
        .map(str::to_owned)
}
fn infer(name: &str) -> Option<String> {
    side(name).map(str::to_owned)
}
fn select(
    targets: Vec<(String, Option<String>)>,
    wanted: Option<&str>,
) -> Vec<(String, Option<String>)> {
    let Some(wanted) = wanted else { return targets };
    let preferred = targets.iter().any(|(_, s)| s.as_deref() == Some(wanted));
    targets
        .into_iter()
        .filter(|(_, s)| {
            if preferred {
                s.as_deref() == Some(wanted)
            } else {
                s.is_none() || s.as_deref() == Some("center")
            }
        })
        .collect()
}
fn candidates<'a>(config: &'a Value, supplied: &'a Value) -> Vec<&'a Value> {
    [supplied, &supplied["profile"], config, &config["profile"]]
        .into_iter()
        .filter(|v| v.is_object())
        .collect()
}
fn bindings(
    config: &Value,
    supplied: &Value,
    au: &str,
) -> (Vec<(String, Option<String>)>, Vec<(String, Option<String>)>) {
    let (mut bones, mut morphs) = (Vec::new(), Vec::new());
    for p in candidates(config, supplied) {
        if let Some(entries) = p["auToBones"][au].as_array() {
            for entry in entries {
                let name = entry
                    .as_str()
                    .or_else(|| {
                        ["node", "boneName", "bone", "name"]
                            .iter()
                            .find_map(|k| entry[k].as_str())
                    })
                    .unwrap_or("")
                    .trim();
                if !name.is_empty() && !bones.iter().any(|(n, _)| n == name) {
                    bones.push((
                        name.to_owned(),
                        read_side(&entry["side"]).or_else(|| infer(name)),
                    ));
                }
            }
        }
        let mapping = &p["auToMorphs"][au];
        let groups = if mapping.is_object() {
            vec![
                (Some("left"), &mapping["left"]),
                (Some("right"), &mapping["right"]),
                (Some("center"), &mapping["center"]),
            ]
        } else {
            vec![(None, mapping)]
        };
        for (s, values) in groups {
            for name in strings(values) {
                if !morphs.iter().any(|(n, _)| n == &name) {
                    let side = s.map(str::to_owned).or_else(|| infer(&name));
                    morphs.push((name, side));
                }
            }
        }
    }
    (bones, morphs)
}
fn score(mesh: &str, morphs: &[String]) -> i32 {
    let mesh = mesh.to_lowercase();
    let text = morphs.join(" ").to_lowercase();
    let mut score = 0;
    if has(&text, "brow|forehead|frontalis") {
        if has(&mesh, "brow|eyebrow|bushy") {
            score -= 100
        }
        if has(&mesh, "body|skin|head") {
            score += 20
        }
        if has(&mesh, "eyeocclusion|tearline") {
            score += 40
        }
    } else if has(
        &text,
        "mouth|lip|smile|frown|dimple|pucker|stretch|press|funnel|roll|shrug|close|jaw|chin",
    ) {
        if has(&mesh, "body|skin|head") {
            score -= 100
        }
        if has(&mesh, "brow|eyebrow|bushy|hair|eyeocclusion|tearline") {
            score += 80
        }
    } else if has(&text, "eye|lid|blink|squint|wide") {
        if has(&mesh, "eyeocclusion|tearline|eye") {
            score -= 80
        }
        if has(&mesh, "body|skin|head") {
            score += 10
        }
        if has(&mesh, "brow|eyebrow|bushy|hair") {
            score += 60
        }
    } else if text.contains("tongue") && mesh.contains("tongue") {
        score -= 100
    }
    score
}
pub fn make_region(
    target_type: &str,
    target: &str,
    bone: Option<&str>,
    mesh: Option<&str>,
    morphs: &[String],
    side: Option<&str>,
    options: &Value,
) -> Value {
    let kind = if bone.is_some() { "bone" } else { "mesh" };
    let name = format!(
        "{PREFIX}{target_type}:{}{side}:{kind}:{}",
        segment(target),
        segment(bone.or(mesh).unwrap_or(target)),
        side = side.map(|s| format!(":{s}")).unwrap_or_default()
    );
    let label = options["label"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if target_type == "au" {
                format!("AU {target}: {}", bone.or(mesh).unwrap_or(target))
            } else {
                format!("Bone: {target}")
            }
        });
    let mut anchor = json!({"type":kind});
    let mut region = json!({"name":name,"label":label,"paddingFactor":number(options,"paddingFactor",0.8),"runtimeAnnotation":{"targetType":target_type,"target":target}});
    if let Some(bone) = bone {
        anchor["bones"] = json!([bone]);
        region["bones"] = json!([bone]);
        region["runtimeAnnotation"]["boneName"] = json!(bone);
    }
    if let Some(mesh) = mesh {
        anchor["meshes"] = json!([mesh]);
        region["meshes"] = json!([mesh]);
        region["runtimeAnnotation"]["meshName"] = json!(mesh);
        region["runtimeAnnotation"]["morphNames"] = json!(morphs);
    }
    if let Some(side) = side {
        region["runtimeAnnotation"]["side"] = json!(side)
    }
    if options["cameraAngle"].is_number() {
        region["cameraAngle"] = options["cameraAngle"].clone();
    }
    region["focusTarget"] = anchor.clone();
    region["focusTarget"]["paddingFactor"] = region["paddingFactor"].clone();
    if options["cameraAngle"].is_number() {
        region["focusTarget"]["cameraAngle"] = options["cameraAngle"].clone();
    }
    if options["projectToSurface"].is_boolean() {
        anchor["projectToSurface"] = options["projectToSurface"].clone()
    }
    region["markerAnchor"] = anchor;
    let mut style = json!({});
    for key in [
        "markerColor",
        "lineColor",
        "markerRadius",
        "labelColor",
        "labelBackground",
        "labelFontSize",
        "opacity",
    ] {
        if !options[key].is_null() {
            style[key] = options[key].clone()
        }
    }
    region["style"] = style;
    region
}
pub fn au_regions(
    config: &Value,
    supplied: &Value,
    au: &str,
    meshes: &Value,
    options: &Value,
) -> Result<Vec<Value>, String> {
    if au.trim().is_empty() {
        return Err("AU id is required".into());
    }
    let (bones, morphs) = bindings(config, supplied, au);
    let wanted = options["targetSide"].as_str();
    let bones = select(bones, wanted);
    let morphs = select(morphs, wanted);
    let morph_side =
        if morphs.iter().all(|(_, s)| s.as_deref() == Some("center")) && !morphs.is_empty() {
            Some("center")
        } else {
            wanted
        };
    let mut mesh_targets = Vec::new();
    if let Some(meshes) = meshes.as_object() {
        for (mesh, values) in meshes {
            let names = strings(values);
            let matched = morphs
                .iter()
                .filter(|(n, _)| names.iter().any(|m| m.eq_ignore_ascii_case(n)))
                .map(|(n, _)| n.clone())
                .collect::<Vec<_>>();
            if !matched.is_empty() {
                mesh_targets.push((mesh.clone(), matched));
            }
        }
    }
    mesh_targets.sort_by(|(a, am), (b, bm)| score(a, am).cmp(&score(b, bm)).then_with(|| a.cmp(b)));
    let mut bone_regions = bones
        .iter()
        .map(|(bone, s)| {
            make_region(
                "au",
                au,
                Some(bone),
                None,
                &[],
                wanted.and(s.as_deref().or(wanted)),
                options,
            )
        })
        .collect::<Vec<_>>();
    let mesh_regions = mesh_targets
        .iter()
        .map(|(mesh, morphs)| make_region("au", au, None, Some(mesh), morphs, morph_side, options))
        .collect::<Vec<_>>();
    if bones.is_empty() && mesh_regions.is_empty() {
        return Err(if morphs.is_empty() {
            format!("AU {au} has no bone or morph bindings to annotate")
        } else {
            format!("AU {au} has morph bindings but no matching morph target meshes to annotate")
        });
    }
    let mut regions = if text(options, "targetPreference") == "mesh" {
        let mut all = mesh_regions;
        all.append(&mut bone_regions);
        all
    } else {
        bone_regions.extend(mesh_regions);
        bone_regions
    };
    let limit = number(options, "maxTargets", 0.);
    if limit >= 1. {
        regions.truncate(limit as usize)
    }
    Ok(regions)
}
pub fn summary(region: &Value) -> Value {
    let metadata = &region["runtimeAnnotation"];
    let mut result = json!({"name":region["name"],"label":region["label"],"targetType":metadata["targetType"],"target":metadata["target"],"bones":strings(&region["bones"]),"meshes":strings(&region["meshes"]),"morphs":strings(&metadata["morphNames"])});
    if !metadata["side"].is_null() {
        result["side"] = metadata["side"].clone()
    }
    result
}
pub fn infer_preview_side(au: &str, profile: &Value) -> Value {
    let (bones, morphs) = bindings(profile, &Value::Null, au);
    let sides = bones
        .iter()
        .chain(&morphs)
        .filter_map(|(_, s)| s.as_deref())
        .collect::<std::collections::HashSet<_>>();
    match (
        sides.contains("left"),
        sides.contains("right"),
        sides.contains("center"),
    ) {
        (true, false, _) => json!("left"),
        (false, true, _) => json!("right"),
        (false, false, true) => json!("center"),
        _ => Value::Null,
    }
}
