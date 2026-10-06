use super::*;

fn mixamo_fixture() -> Document {
    let bones = [
        ("Hips", None, [0., 100., 0.]),
        ("Spine", Some("Hips"), [0., 20., 0.]),
        ("Head", Some("Spine"), [0., 40., 0.]),
        ("LeftArm", Some("Spine"), [20., 20., 0.]),
        ("LeftForeArm", Some("LeftArm"), [30., 0., 0.]),
        ("LeftHand", Some("LeftForeArm"), [25., 0., 0.]),
        ("RightArm", Some("Spine"), [-20., 20., 0.]),
        ("RightForeArm", Some("RightArm"), [-30., 0., 0.]),
        ("RightHand", Some("RightForeArm"), [-25., 0., 0.]),
        ("LeftUpLeg", Some("Hips"), [10., 0., 0.]),
        ("LeftLeg", Some("LeftUpLeg"), [0., -45., 0.]),
        ("LeftFoot", Some("LeftLeg"), [0., -45., 0.]),
        ("RightUpLeg", Some("Hips"), [-10., 0., 0.]),
        ("RightLeg", Some("RightUpLeg"), [0., -45., 0.]),
        ("RightFoot", Some("RightLeg"), [0., -45., 0.]),
    ];
    let nodes = bones
        .into_iter()
        .map(|(id, parent, translation)| Node {
            id: id.into(),
            name: format!("mixamorig:{id}"),
            parent: parent.map(str::to_string),
            translation,
            rotation: IDENTITY,
            scale: [1.; 3],
        })
        .collect();
    Document {
        version: 1,
        name: "Raised arm".into(),
        duration_seconds: 1.,
        rig: Rig {
            meters_per_unit: 0.01,
            nodes,
            humanoid_bones: BTreeMap::new(),
        },
        tracks: vec![
            Track {
                node: "LeftArm".into(),
                path: "rotation".into(),
                interpolation: "STEP".into(),
                times: vec![0., 1.],
                values: vec![0., 0., 0.70710677, 0.70710677, 0., 0., 1., 0.],
            },
            Track {
                node: "Hips".into(),
                path: "translation".into(),
                interpolation: "LINEAR".into(),
                times: vec![0., 1.],
                values: vec![0., 100., 0., 20., 110., 0.],
            },
        ],
    }
}
fn near(actual: &[f32], expected: &[f32]) {
    assert_eq!(actual.len(), expected.len());
    for (a, b) in actual.iter().zip(expected) {
        assert!((a - b).abs() < 1e-5, "{actual:?} != {expected:?}");
    }
}

fn rewrite_gltf(bytes: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let json_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let mut gltf: Value = serde_json::from_slice(&bytes[20..20 + json_length]).unwrap();
    edit(&mut gltf);
    let mut json = serde_json::to_vec(&gltf).unwrap();
    while json.len() % 4 != 0 {
        json.push(b' ');
    }
    let binary_chunk = &bytes[20 + json_length..];
    let total = 20 + json.len() + binary_chunk.len();
    let mut rewritten = Vec::new();
    for word in [0x46546c67, 2, total as u32, json.len() as u32, 0x4e4f534a] {
        rewritten.extend(word.to_le_bytes());
    }
    rewritten.extend(json);
    rewritten.extend(binary_chunk);
    rewritten
}

#[test]
fn mixamo_keys_keep_authored_first_pose_and_convert_centimeters() {
    let doc = normalize_mixamo(mixamo_fixture()).unwrap();
    assert_eq!(doc.tracks[0].node, "leftUpperArm");
    assert_eq!(doc.tracks[0].interpolation, "STEP");
    near(
        &doc.tracks[0].values[..4],
        &[0., 0., 0.70710677, 0.70710677],
    );
    near(&doc.tracks[1].values, &[0., 1., 0., 0.2, 1.1, 0.]);
    assert_eq!(doc.rig.humanoid_bones.len(), 15);
}
#[test]
fn rotation_conversion_uses_rest_basis_and_same_rig_roundtrip() {
    let mut source = mixamo_fixture();
    source
        .rig
        .nodes
        .iter_mut()
        .find(|n| n.id == "LeftArm")
        .unwrap()
        .rotation = [0.70710677, 0., 0., 0.70710677];
    let rest = source
        .rig
        .nodes
        .iter()
        .find(|n| n.id == "LeftArm")
        .unwrap()
        .rotation;
    let pose = mul(rest, [0., 0.70710677, 0., 0.70710677]);
    source.tracks[0].values = [pose, rest].concat();
    let normalized = normalize_mixamo(source.clone()).unwrap();
    near(
        &normalized.tracks[0].values[..4],
        &[0., 0., 0.70710677, 0.70710677],
    );
    for node in &source.rig.nodes {
        if let Some(role) = mixamo_role(&node.name) {
            source.rig.humanoid_bones.insert(role, node.id.clone());
        }
    }
    let restored = retarget(normalized, source.rig).unwrap();
    near(&restored.tracks[0].values, &source.tracks[0].values);
    near(&restored.tracks[1].values, &source.tracks[1].values);
}
#[test]
fn translation_respects_target_height_and_units() {
    let source = normalize_mixamo(mixamo_fixture()).unwrap();
    let mut target = source.rig.clone();
    target.meters_per_unit = 0.01;
    for node in &mut target.nodes {
        node.translation = scale(node.translation, 200.);
    }
    let result = retarget(source, target).unwrap();
    near(&result.tracks[1].values, &[0., 200., 0., 40., 220., 0.]);
}

#[test]
fn translation_uses_rotated_scaled_target_parent_space() {
    let source = normalize_mixamo(mixamo_fixture()).unwrap();
    let mut target = source.rig.clone();
    target.meters_per_unit = 0.01;
    for node in &mut target.nodes {
        node.translation = scale(node.translation, 100.);
    }
    // Parent rotates +90 degrees around Y and doubles model height. Counter-
    // rotating the hips reference keeps the humanoid itself in the same T-pose.
    let parent_rotation = [0., 0.70710677, 0., 0.70710677];
    let hips = target
        .nodes
        .iter_mut()
        .find(|node| node.id == "hips")
        .unwrap();
    hips.parent = Some("armature".into());
    hips.rotation = inv(parent_rotation);
    target.nodes.insert(
        0,
        Node {
            id: "armature".into(),
            name: "armature".into(),
            parent: None,
            translation: [0.; 3],
            rotation: parent_rotation,
            scale: [2.; 3],
        },
    );
    let result = retarget(source, target).unwrap();
    // World +X displacement becomes local +Z; parent scale is removed once.
    near(&result.tracks[1].values, &[0., 100., 0., 0., 110., 20.]);
}

#[test]
fn a_characterized_target_still_requires_a_t_pose_reference() {
    let source = normalize_mixamo(mixamo_fixture()).unwrap();
    let mut target = source.rig.clone();
    target
        .nodes
        .iter_mut()
        .find(|node| node.id == "leftUpperArm")
        .unwrap()
        .rotation = [0., 0., -0.38268343, 0.9238795];
    assert!(retarget(source, target).unwrap_err().contains("T-pose"));
}
#[test]
fn glb_roundtrip_retains_required_hierarchy_step_and_binary_keys() {
    let source = normalize_mixamo(mixamo_fixture()).unwrap();
    let bytes = encode(source.clone()).unwrap();
    assert_eq!(&bytes[..4], b"glTF");
    let decoded = decode(&bytes).unwrap();
    assert_eq!(decoded.name, source.name);
    assert_eq!(decoded.rig.humanoid_bones.len(), 15);
    assert_eq!(decoded.tracks[0].interpolation, "STEP");
    near(&decoded.tracks[0].values, &source.tracks[0].values);
    let applied = retarget(decoded, source.rig).unwrap();
    near(&applied.tracks[1].values, &source.tracks[1].values);
}
#[test]
fn rejects_ambiguous_missing_and_non_t_pose_skeletons() {
    let mut source = mixamo_fixture();
    let mut duplicate = source.rig.nodes[0].clone();
    duplicate.id = "duplicate".into();
    source.rig.nodes.push(duplicate);
    assert!(normalize_mixamo(source).unwrap_err().contains("Ambiguous"));
    let mut source = mixamo_fixture();
    source.rig.nodes.retain(|n| n.id != "Head");
    assert!(normalize_mixamo(source)
        .unwrap_err()
        .contains("Missing required"));
    let mut source = mixamo_fixture();
    source
        .rig
        .nodes
        .iter_mut()
        .find(|n| n.id == "LeftForeArm")
        .unwrap()
        .translation = [20., -20., 0.];
    assert!(normalize_mixamo(source).unwrap_err().contains("T-pose"));
}
#[test]
fn rejects_moving_non_hips_translation_smooth_keys_and_zero_quaternions() {
    let mut source = mixamo_fixture();
    source.tracks[0].path = "translation".into();
    source.tracks[0].values = vec![20., 20., 0., 25., 25., 0.];
    assert!(normalize_mixamo(source)
        .unwrap_err()
        .contains("Unsupported animated"));
    let mut source = mixamo_fixture();
    source.tracks[0].interpolation = "CUBICSPLINE".into();
    assert!(normalize_mixamo(source).is_err());
    let mut source = mixamo_fixture();
    source.tracks[0].values[..4].fill(0.);
    assert!(normalize_mixamo(source)
        .unwrap_err()
        .contains("unit quaternion"));
}
#[test]
fn rejects_truncated_glb_and_out_of_bounds_accessor_without_panicking() {
    let source = normalize_mixamo(mixamo_fixture()).unwrap();
    let bytes = encode(source).unwrap();
    for size in [0, 4, 12, 19, 28, bytes.len() - 1] {
        assert!(decode(&bytes[..size]).is_err());
    }
    let json_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let mut gltf: Value = serde_json::from_slice(&bytes[20..20 + json_length]).unwrap();
    gltf["accessors"][0]["byteOffset"] = json!(u64::MAX);
    assert!(read_accessor(&gltf, &[0; 64], 0, "SCALAR", 1, MAX_SCALARS).is_err());
}
#[test]
fn rejects_eye_bindings_and_absent_animated_optional_bones() {
    let mut source = normalize_mixamo(mixamo_fixture()).unwrap();
    source
        .rig
        .humanoid_bones
        .insert("leftEye".into(), "head".into());
    assert!(encode(source).unwrap_err().contains("unsupported"));
    let mut source = normalize_mixamo(mixamo_fixture()).unwrap();
    source.rig.nodes.push(Node {
        id: "jaw".into(),
        name: "jaw".into(),
        parent: Some("head".into()),
        translation: [0., -0.1, 0.],
        rotation: IDENTITY,
        scale: [1.; 3],
    });
    source.rig.humanoid_bones.insert("jaw".into(), "jaw".into());
    let target = normalize_mixamo(mixamo_fixture()).unwrap().rig;
    source.tracks.push(Track {
        node: "jaw".into(),
        path: "rotation".into(),
        interpolation: "LINEAR".into(),
        times: vec![0.],
        values: IDENTITY.to_vec(),
    });
    assert!(retarget(source, target)
        .unwrap_err()
        .contains("lacks animated role jaw"));
}

#[test]
fn rejects_reused_accessors_before_expanding_unbounded_tracks() {
    let mut source = normalize_mixamo(mixamo_fixture()).unwrap();
    source.tracks[0].times = (0..25_000).map(|i| i as f32 / 24_999.).collect();
    source.tracks[0].values = (0..25_000).flat_map(|_| IDENTITY).collect();
    let bytes = encode(source).unwrap();
    let repeated = rewrite_gltf(&bytes, |gltf| {
        let channel = gltf["animations"][0]["channels"][0].clone();
        gltf["animations"][0]["channels"] = json!(vec![channel; 256]);
    });
    assert!(decode(&repeated).unwrap_err().contains("scalar budget"));
}

#[test]
fn only_an_omitted_sampler_interpolation_defaults_to_linear() {
    let bytes = encode(normalize_mixamo(mixamo_fixture()).unwrap()).unwrap();
    for invalid in [json!(null), json!(42), json!("CUBICSPLINE"), json!({})] {
        let malformed = rewrite_gltf(&bytes, |gltf| {
            gltf["animations"][0]["samplers"][0]["interpolation"] = invalid;
        });
        assert!(decode(&malformed)
            .unwrap_err()
            .contains("sampler interpolation"));
    }
    let omitted = rewrite_gltf(&bytes, |gltf| {
        gltf["animations"][0]["samplers"][0]
            .as_object_mut()
            .unwrap()
            .remove("interpolation");
    });
    assert_eq!(decode(&omitted).unwrap().tracks[0].interpolation, "LINEAR");
}

#[test]
fn explicit_clip_tail_survives_glb_roundtrip() {
    let mut source = normalize_mixamo(mixamo_fixture()).unwrap();
    source.duration_seconds = 2.;
    let decoded = decode(&encode(source).unwrap()).unwrap();
    assert_eq!(decoded.duration_seconds, 2.);
    near(
        &decoded.tracks[0].values[4..8],
        &decoded.tracks[0].values[8..12],
    );
}
