use super::geometry::{Bounds, ModelObject, IDENTITY};
use super::*;

fn model() -> Model {
    Model {
        bounds: Bounds {
            min: [-0.5, 0., -0.2],
            max: [0.5, 2., 0.2],
        },
        quaternion: [0., 0., 0., 1.],
        inverse: IDENTITY,
        objects: vec![
            ModelObject {
                id: 1,
                name: "Body".into(),
                kind: "Mesh".into(),
                parent: None,
                position: [0., 1., 0.],
                bounds: Some(Bounds {
                    min: [-0.5, 0., -0.2],
                    max: [0.5, 2., 0.2],
                }),
                matrix: IDENTITY,
                inverse: IDENTITY,
                morph_names: vec!["Brow_Left".into(), "Brow_Right".into()],
            },
            ModelObject {
                id: 2,
                name: "LeftEye".into(),
                kind: "Bone".into(),
                parent: None,
                position: [-0.2, 1.6, 0.1],
                bounds: None,
                matrix: IDENTITY,
                inverse: IDENTITY,
                morph_names: vec![],
            },
            ModelObject {
                id: 3,
                name: "RightEye".into(),
                kind: "Bone".into(),
                parent: None,
                position: [0.2, 1.6, 0.1],
                bounds: None,
                matrix: IDENTITY,
                inverse: IDENTITY,
                morph_names: vec![],
            },
        ],
    }
}
fn runtime(regions: Value) -> AnnotationRuntime {
    let mut runtime = AnnotationRuntime::create(json!({"enableDamping":false})).unwrap();
    runtime.model = Some(model());
    runtime
        .execute(
            "configure",
            json!({"config":{"characterId":"fixture","regions":regions}}),
            0.,
        )
        .unwrap();
    runtime
}
fn point_region(name: &str) -> Value {
    json!({"name":name,"markerAnchor":{"type":"point","position":{"x":0.,"y":1.,"z":0.}},"focusTarget":{"type":"point","position":{"x":1.,"y":1.,"z":0.}}})
}

fn animated_region() -> Value {
    json!({"name":"au", "meshes":["Body"],
        "runtimeAnnotation":{"morphNames":["Brow_Left"]}})
}

#[test]
fn animated_morph_anchors_reuse_weights_and_preserve_marker_state() {
    let base = [-1., 0., 0., 1., 0., 0., 0., 1., 0.];
    let deltas = [0., 1., 0., 0., 2., 0., 0., 1., 0.];
    let absolute = base
        .iter()
        .zip(deltas)
        .map(|(p, d)| p + d)
        .collect::<Vec<_>>();
    for (morphs, relative) in [(&deltas[..], true), (&absolute[..], false)] {
        let mut r = runtime(json!([animated_region()]));
        let generation = r.generation();
        let plan = r.prepare_morph_anchor(generation, 1, "au", &base, morphs, relative);
        assert_eq!(&plan[1..], &[0, 1, 2]);
        assert!(r.observe_morph_anchor(generation, plan[0], &base));
        r.plan_markers("{}").unwrap();
        r.finish_markers(generation);
        assert_eq!(r.markers[0].start, [0.25, 0.25, 0.]);
        r.current = Some("au".into());
        r.visible = true;
        r.markers[0].transition = Some((true, 25., 220.));
        let id = r.markers[0].id;
        let descriptor_revision = r.descriptor_revision;
        let revision = r.revision;
        assert!(r.observe_morph_anchor(generation, plan[0], &absolute));
        assert_eq!(r.markers[0].start, [0.25, 1.75, 0.]);
        assert_eq!(r.markers[0].id, id);
        assert_eq!(r.markers[0].transition, Some((true, 25., 220.)));
        assert_eq!(r.current.as_deref(), Some("au"));
        assert_eq!(r.descriptor_revision, descriptor_revision);
        assert_eq!(r.revision, revision);

        // Native pose samples include world translation. A later marker frame
        // must not apply the observed object matrix a second time.
        let mut matrix = IDENTITY;
        matrix[12] = 10.;
        r.observe_transforms(&[&[1.][..], &matrix[..]].concat());
        let translated = absolute
            .chunks_exact(3)
            .flat_map(|p| [p[0] + 10., p[1], p[2]])
            .collect::<Vec<_>>();
        r.observe_morph_anchor(generation, plan[0], &translated);
        let frame = r.marker_frame(26., &IDENTITY, &IDENTITY, 800., 600.);
        assert_eq!(&frame[2..5], &[10.25, 1.75, 0.]);
    }
}

#[test]
fn animated_anchor_band_stays_attached_when_the_pose_rotates() {
    let mut r = runtime(json!([animated_region()]));
    let base = [0., 0., 0., 0., 1., 0., 0., 2., 0., 0., 3., 0., 0., 4., 0.];
    let morphs = [0., 0., 1.].repeat(5);
    let generation = r.generation();
    let plan = r.prepare_morph_anchor(generation, 1, "au", &base, &morphs, true);
    assert_eq!(&plan[1..], &[3, 4]);
    r.observe_morph_anchor(generation, plan[0], &[0., 3., 0., 0., 4., 0.]);
    r.plan_markers("{}").unwrap();
    assert_eq!(r.markers[0].start, [0., 3.5, 0.]);
    r.observe_morph_anchor(generation, plan[0], &[0., -3., 0., 0., -4., 0.]);
    assert_eq!(r.markers[0].start, [0., -3.5, 0.]);
}

#[test]
fn one_shot_and_live_anchors_share_selection_and_weighted_pose_reduction() {
    let mut r = runtime(json!([animated_region()]));
    let base = [0., 0., 0., 0., 1., 0., 0., 2., 0., 0., 3., 0., 0., 4., 0.];
    let morphs = [0., 0., 1.].repeat(5);
    let generation = r.generation();
    let plan = r.prepare_morph_anchor(generation, 1, "au", &base, &morphs, true);
    let candidates =
        annotation_morph_anchor_candidates(&animated_region().to_string(), &base, &morphs, true)
            .unwrap();
    assert_eq!(&candidates[..], &[3., 1., 4., 1.]);
    assert_eq!(&plan[1..], &[3, 4]);
    r.observe_morph_anchor(generation, plan[0], &[0., -3., 0., 0., -4., 0.]);
    r.plan_markers("{}").unwrap();
    let point = annotation_weighted_anchor(&[0., -3., 0., 1., 0., -4., 0., 1.]);
    assert_eq!(&point[..], &r.markers[0].start);
    assert!(annotation_weighted_anchor(&[1., 2., 3.]).is_empty());
    assert!(annotation_weighted_anchor(&[f32::NAN, 2., 3., 1.]).is_empty());
}

#[test]
fn geometry_revisions_retire_stale_plans_without_recreating_markers() {
    let mut r = runtime(json!([animated_region()]));
    let generation = r.generation();
    assert!(r
        .observe_morph_geometry(generation, 1, 1, "[\"Brow_Left\"]")
        .unwrap());
    let plan = r.prepare_morph_anchor(generation, 1, "au", &[0.; 3], &[1.; 3], true);
    r.observe_morph_anchor(generation, plan[0], &[1.; 3]);
    r.plan_markers("{}").unwrap();
    r.visible = true;
    r.current = Some("au".into());
    r.markers[0].transition = Some((true, 10., 220.));
    assert!(r.needs_frame());
    let id = r.markers[0].id;
    let descriptors = r.descriptor_revision;

    assert!(!r
        .observe_morph_geometry(generation, 1, 1, "[\"Brow_Left\"]")
        .unwrap());
    assert!(r.observe_morph_geometry(generation, 1, 2, "[]").unwrap());
    assert_eq!(
        r.execute("markerPosition", json!({"name":"au"}), 0.).unwrap(),
        Value::Null
    );
    let frame = r.marker_frame(15., &IDENTITY, &IDENTITY, 800., 600.);
    assert_eq!(frame[1], 0.);
    assert!(!r.needs_frame());
    assert!(!r.observe_morph_anchor(generation, plan[0], &[9.; 3]));
    assert!(!r
        .observe_morph_geometry(generation, 1, 1, "[\"Brow_Left\"]")
        .unwrap());
    assert_eq!(
        r.execute("morphRequests", json!({}), 0.).unwrap(),
        json!([])
    );

    assert!(r
        .observe_morph_geometry(generation, 1, 3, "[\"Brow_Left\"]")
        .unwrap());
    let replacement = r.prepare_morph_anchor(generation, 1, "au", &[0.; 3], &[1.; 3], true);
    assert_ne!(replacement[0], plan[0]);
    r.observe_morph_anchor(generation, replacement[0], &[2.; 3]);
    assert_eq!(r.markers[0].start, [2.; 3]);
    assert!(r.markers[0].anchor_resolved);
    assert!(r.needs_frame());
    assert_eq!(r.markers[0].id, id);
    assert_eq!(r.markers[0].transition, Some((true, 10., 220.)));
    assert_eq!(r.current.as_deref(), Some("au"));
    assert_eq!(r.descriptor_revision, descriptors);
    assert_eq!(r.generation(), generation);
    assert_eq!(r.morph_anchors.len(), 1);
    r.execute("clear", json!({}), 0.).unwrap();
    assert!(!r
        .observe_morph_geometry(generation, 1, 4, "[\"Brow_Left\"]")
        .unwrap());
}

#[test]
fn geometry_replacement_preserves_mesh_precedence() {
    let mut r = runtime(json!([animated_region()]));
    let mut second = r.model.as_ref().unwrap().objects[0].clone();
    second.id = 4;
    r.model.as_mut().unwrap().objects.push(second);
    let generation = r.generation();
    for id in [1, 4] {
        r.observe_morph_geometry(generation, id, 1, "[\"Brow_Left\"]")
            .unwrap();
        let plan = r.prepare_morph_anchor(generation, id, "au", &[0.; 3], &[1.; 3], true);
        r.observe_morph_anchor(generation, plan[0], &[id as f32; 3]);
    }
    r.plan_markers("{}").unwrap();
    assert_eq!(r.markers[0].start, [4.; 3]);
    r.observe_morph_geometry(generation, 1, 2, "[\"Brow_Left\"]")
        .unwrap();
    let plan = r.prepare_morph_anchor(generation, 1, "au", &[0.; 3], &[1.; 3], true);
    r.observe_morph_anchor(generation, plan[0], &[9.; 3]);
    assert_eq!(r.markers[0].start, [4.; 3]);
    r.observe_morph_geometry(generation, 4, 2, "[]").unwrap();
    assert_eq!(r.markers[0].start, [9.; 3]);
}

#[test]
fn animated_anchors_keep_mesh_precedence_and_reject_reused_plan_ids_from_old_generations() {
    let mut r = runtime(json!([animated_region()]));
    let mut second = r.model.as_ref().unwrap().objects[0].clone();
    second.id = 4;
    r.model.as_mut().unwrap().objects.push(second);
    let generation = r.generation();
    let first = r.prepare_morph_anchor(generation, 1, "au", &[0.; 3], &[1.; 3], true);
    let second = r.prepare_morph_anchor(generation, 4, "au", &[0.; 3], &[1.; 3], true);
    r.observe_morph_anchor(generation, first[0], &[1.; 3]);
    r.observe_morph_anchor(generation, second[0], &[2.; 3]);
    r.plan_markers("{}").unwrap();
    r.observe_morph_anchor(generation, first[0], &[3.; 3]);
    assert_eq!(r.markers[0].start, [2.; 3]);
    r.observe_morph_anchor(generation, second[0], &[4.; 3]);
    assert_eq!(r.markers[0].start, [4.; 3]);

    r.execute(
        "configure",
        json!({"config":{"regions":[animated_region()]}}),
        0.,
    )
    .unwrap();
    let next = r.generation();
    let replacement = r.prepare_morph_anchor(next, 1, "au", &[0.; 3], &[1.; 3], true);
    assert_eq!(replacement[0], first[0]);
    r.observe_morph_anchor(next, replacement[0], &[5.; 3]);
    r.plan_markers("{}").unwrap();
    assert!(!r.observe_morph_anchor(generation, first[0], &[9.; 3]));
    assert_eq!(r.markers[0].start, [5.; 3]);
}

#[test]
fn animated_anchors_reject_invalid_and_stale_observations() {
    for operation in [
        "beginLoad", "clear", "clearModel", "configure", "updateRegion", "removeRegion",
        "setModel", "dispose",
    ] {
        let mut r = runtime(json!([animated_region()]));
        let generation = r.generation();
        let plan = r.prepare_morph_anchor(generation, 1, "au", &[0., 0., 0.], &[0., 1., 0.], true);
        r.observe_morph_anchor(generation, plan[0], &[1., 2., 3.]);
        r.plan_markers("{}").unwrap();
        for invalid in [
            &[1., 2.][..],
            &[f32::NAN, 2., 3.][..],
            &[f32::INFINITY, 2., 3.][..],
        ] {
            assert!(!r.observe_morph_anchor(generation, plan[0], invalid));
            assert_eq!(r.markers[0].start, [1., 2., 3.]);
        }
        assert!(!r.observe_morph_anchor(generation, u32::MAX, &[9.; 3]));
        match operation {
            "setModel" => r.set_model(&serde_json::to_string(&model()).unwrap()).unwrap(),
            "dispose" => r.dispose(),
            "configure" => {
                r.execute(operation, json!({"config":{"regions":[animated_region()]}}), 0.)
                    .unwrap();
            }
            "updateRegion" => {
                r.execute(operation, json!({"name":"au","update":{"label":"edited"}}), 0.)
                    .unwrap();
            }
            _ => {
                r.execute(operation, json!({"name":"au"}), 0.).unwrap();
            }
        }
        assert!(r.morph_anchors.is_empty(), "{operation}");
        assert!(!r.observe_morph_anchor(generation, plan[0], &[9.; 3]), "{operation}");
        assert!(r.prepare_morph_anchor(generation, 1, "au", &[0.; 3], &[1.; 3], true).is_empty());
    }
}

#[test]
fn animated_anchor_plans_preserve_explicit_targets_and_static_fallbacks() {
    for overrides in [
        json!({"markerAnchor":{"type":"point","position":{"x":2.,"y":3.,"z":4.}}}),
        json!({"objects":["*"],"markerAnchor":{"type":"region"}}),
        json!({"markerAnchor":{"type":"bone","bones":["LeftEye"]}}),
    ] {
        let mut region = animated_region();
        markers::merge(&mut region, &overrides);
        let mut r = runtime(json!([region]));
        assert_eq!(r.execute("morphRequests", json!({}), 0.).unwrap(), json!([]));
        assert!(r.prepare_morph_anchor(r.generation(), 1, "au", &[0.; 3], &[1.; 3], true).is_empty());
    }
    let mut r = runtime(json!([animated_region()]));
    r.visible = true;
    assert!(r.prepare_morph_anchor(r.generation(), 1, "au", &[0.; 3], &[0.; 3], true).is_empty());
    r.plan_markers("{}").unwrap();
    assert!(r.markers[0].animated_anchor.is_none());
    let start = r.markers[0].start;
    let mut matrix = IDENTITY;
    matrix[12] = 2.;
    r.observe_transforms(&[&[1.][..], &matrix[..]].concat());
    r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
    assert_eq!(r.markers[0].start, [start[0] + 2., start[1], start[2]]);
}

#[test]
fn rust_resolves_independent_marker_and_focus_targets() {
    let mut r = runtime(json!([point_region("point")]));
    r.plan_markers("{}").unwrap();
    assert_eq!(r.markers[0].start, [0., 1., 0.]);
    r.execute("focus", json!({"name":"point","duration":0}), 0.)
        .unwrap();
    assert_eq!(r.camera.target, [1., 1., 0.]);
    assert_eq!(r.current.as_deref(), Some("point"));
    assert_eq!(r.camera.finished, r.camera.generation);
}
#[test]
fn invalid_configuration_does_not_partially_replace_live_regions() {
    let mut r = runtime(json!([point_region("saved")]));
    let before = r.snapshot_value();
    assert!(r
        .execute(
            "configure",
            json!({"config":{"regions":[{"name":"bad","markerAnchor":{"type":"point"}}]}}),
            0.
        )
        .is_err());
    assert_eq!(r.snapshot_value(), before);
    assert!(validate_regions(&[
        json!({"name":"a","children":["b"]}),
        json!({"name":"b","parent":"a","children":["a"]})
    ])
    .is_err());
}
#[test]
fn new_load_clear_and_dispose_invalidate_pending_surface_results() {
    for operation in ["beginLoad", "clear"] {
        let mut r = runtime(json!([{"name":"eye","bones":["LeftEye"]}]));
        let generation = r.generation;
        let plans: Value = serde_json::from_str(&r.plan_markers("{}").unwrap()).unwrap();
        let id = plans[0]["id"].as_u64().unwrap() as u32;
        r.execute(operation, json!({}), 0.).unwrap();
        assert!(!r.is_current(generation));
        assert_eq!(
            r.surface_result(generation, id, 0, &[99., 99., 99.]),
            "null"
        );
        assert!(!r.markers.iter().any(|m| m.start == [99., 99., 99.]));
    }
    let mut r = runtime(json!([point_region("saved")]));
    let generation = r.generation;
    r.dispose();
    assert!(!r.is_current(generation));
    assert!(r
        .execute("visibility", json!({"visible":true}), 1.)
        .is_err());
}
#[test]
fn superseded_camera_requests_settle_and_zero_duration_lands_exactly() {
    let mut r = runtime(json!([]));
    let first = r
        .execute(
            "animateCamera",
            json!({"position":[3,2,1],"target":[0,1,0],"duration":1000}),
            0.,
        )
        .unwrap()
        .as_u64()
        .unwrap();
    r.execute(
        "animateCamera",
        json!({"position":[1,2,3],"target":[0,2,0],"duration":0}),
        10.,
    )
    .unwrap();
    assert!(r.camera.finished as u64 > first);
    assert_eq!(r.camera.position, [1., 2., 3.]);
    assert_eq!(r.camera.target, [0., 2., 0.]);
    r.execute(
        "animateCamera",
        json!({"position":[3,2,1],"target":[0,1,0],"duration":1000}),
        20.,
    )
    .unwrap();
    r.execute("clear", json!({}), 30.).unwrap();
    assert!(!r.camera.moving());
}
#[test]
fn all_pointer_orbit_pan_zoom_and_disable_decisions_live_in_rust() {
    let mut r = runtime(json!([]));
    r.camera.height = 600.;
    r.camera.width = 800.;
    let initial = r.camera.position;
    r.execute("input", json!({"kind":"down","id":1,"x":0,"y":0}), 0.)
        .unwrap();
    r.execute("input", json!({"kind":"move","id":1,"x":100,"y":20}), 1.)
        .unwrap();
    r.camera.sample(16., &r.settings);
    assert_ne!(r.camera.position, initial);
    r.execute("input", json!({"kind":"up","id":1}), 17.)
        .unwrap();
    let target = r.camera.target;
    r.execute(
        "input",
        json!({"kind":"down","id":2,"x":0,"y":0,"button":2}),
        18.,
    )
    .unwrap();
    r.execute("input", json!({"kind":"move","id":2,"x":10,"y":10}), 19.)
        .unwrap();
    r.camera.sample(32., &r.settings);
    assert_ne!(r.camera.target, target);
    r.execute("settings", json!({"minDistance":1,"maxDistance":2}), 33.)
        .unwrap();
    r.execute("input", json!({"kind":"wheel","deltaY":10000}), 34.)
        .unwrap();
    r.camera.sample(48., &r.settings);
    assert!((distance3(r.camera.position, r.camera.target) - 2.).abs() < 1e-5);
    r.execute("settings", json!({"enabled":false}), 49.)
        .unwrap();
    let pose = r.camera.position;
    r.execute("input", json!({"kind":"wheel","deltaY":-1000}), 50.)
        .unwrap();
    r.camera.sample(64., &r.settings);
    assert_eq!(r.camera.position, pose);
}
#[test]
fn side_targeted_au_previews_replace_only_the_previous_side_and_keep_saved_regions() {
    let mut r = runtime(json!([point_region("saved")]));
    let profile = json!({"auToMorphs":{"1":{"left":["Brow_Left"],"right":["Brow_Right"]}}});
    let meshes =
        json!({"Body":["Brow_Left","Brow_Right"],"Male_Bushy_Brows":["Brow_Left","Brow_Right"]});
    let left=r.execute("runtimeAU",json!({"target":"1","profile":profile,"meshes":meshes,"options":{"targetSide":"left","targetPreference":"mesh","maxTargets":1}}),0.).unwrap();
    assert_eq!(left[0]["meshes"][0], "Male_Bushy_Brows");
    assert_eq!(left[0]["side"], "left");
    let right=r.execute("runtimeAU",json!({"target":"1","profile":profile,"meshes":meshes,"options":{"targetSide":"right","targetPreference":"mesh","maxTargets":1}}),1.).unwrap();
    assert_eq!(right[0]["side"], "right");
    assert_eq!(r.runtime_names.len(), 1);
    assert_eq!(r.regions.len(), 2);
    let cleared = r.execute("clearRuntime", json!({}), 2.).unwrap();
    assert_eq!(cleared.as_array().unwrap().len(), 1);
    assert_eq!(r.regions, vec![point_region("saved")]);
}
#[test]
fn unmapped_au_fails_without_removing_existing_preview() {
    let mut r = runtime(json!([point_region("saved")]));
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{}}), 0.)
        .unwrap();
    let before = r.snapshot_value();
    assert!(r
        .execute(
            "runtimeAU",
            json!({"target":"99","profile":{},"options":{"replaceExisting":true}}),
            1.
        )
        .is_err());
    assert_eq!(r.snapshot_value(), before);
}

#[test]
fn morph_leaders_leave_the_character_in_front_rear_and_side_views() {
    let model = model();
    for camera in [[0., 1., 3.], [0., 1., -3.], [3., 1., 0.], [-3., 1., 0.]] {
        let view = sub3(camera, model.bounds.center());
        let right = normalize3([view[2], 0., -view[0]]);
        for anchor in [[-0.2, 1.6, 0.1], [0.2, 1.6, 0.1], [0., 1.6, 0.1]] {
            let region = targets::make_region(
                "au", "1", None, Some("Body"), &["Brow_Left".into()], Some("left"), &json!({}),
            );
            let marker = Marker::new(1, region, &model, &json!({
                "markerDefaults":{"lineDirection":"down"}
            }), -1., camera, Some(anchor)).unwrap();
            let radial = sub3(anchor, model.bounds.center());
            let horizontal = crate::annotation_camera::dot3(radial, right);
            let projected = crate::annotation_camera::dot3(marker.direction, right);
            assert!(projected.abs() > 0.5, "leader must extend across the view");
            if horizontal.abs() > 0.001 {
                assert!(horizontal * projected > 0., "leader must leave the character");
            }
            assert!(crate::annotation_camera::dot3(radial, marker.direction) >= -1e-6);
        }
    }
}

#[test]
fn morph_leaders_refresh_with_animated_anchors_and_camera_orbits() {
    let mut r = runtime(json!([animated_region()]));
    let generation = r.generation();
    let base = [-0.2, 1.5, 0.1, -0.2, 1.6, 0.1, -0.2, 1.7, 0.1];
    let deltas = [0., 0.1, 0.].repeat(3);
    let plan = r.prepare_morph_anchor(generation, 1, "au", &base, &deltas, true);
    assert!(plan.len() > 1);
    let samples = |position: Point| position.repeat(plan.len() - 1);
    r.observe_morph_anchor(generation, plan[0], &samples([-0.2, 1.6, 0.1]));
    r.plan_markers("{}").unwrap();
    r.visible = true;
    r.camera.position = [0., 1., 3.];
    r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(r.markers[0].direction[0] < -0.5);
    let id = r.markers[0].id;
    r.observe_morph_anchor(generation, plan[0], &samples([0.2, 1.6, 0.1]));
    r.marker_frame(1., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(r.markers[0].direction[0] > 0.5);
    r.camera.position = [3., 1., 0.];
    let mut side_view = IDENTITY;
    side_view[0] = 0.;
    side_view[8] = -1.;
    side_view[2] = 1.;
    side_view[10] = 0.;
    r.marker_frame(2., &IDENTITY, &side_view, 800., 600.);
    assert!(r.markers[0].direction[2] > 0.5);
    assert_eq!(r.markers[0].id, id);
}

#[test]
fn au_previews_hide_other_markers_and_restore_saved_visibility_and_selection() {
    for style in ["3d", "html"] {
        for initially_visible in [false, true] {
            let mut parent = point_region("head");
            parent["children"] = json!(["saved"]);
            let mut child = point_region("saved");
            child["parent"] = json!("head");
            for region in [&mut parent, &mut child] {
                region["markerAnchor"]["position"] = json!({"x":0.,"y":0.,"z":0.});
                region["style"] = json!({"lineDirection":{"x":1.,"y":0.,"z":0.}});
            }
            let saved = json!([parent, child]);
            let mut r = runtime(saved.clone());
            for object in &mut r.model.as_mut().unwrap().objects {
                if object.kind == "Bone" { object.position[1] = 0.1; }
            }
            r.execute("style", json!({"style":style}), 0.).unwrap();
            r.execute("expand", json!({"name":"head","duration":0}), 0.).unwrap();
            r.execute("solo", json!({"name":"saved"}), 0.).unwrap();
            r.execute("select", json!({"name":"saved"}), 0.).unwrap();
            r.execute("visibility", json!({"visible":true}), 0.).unwrap();
            r.plan_markers("{}").unwrap();
            r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
            r.marker_frame(300., &IDENTITY, &IDENTITY, 800., 600.);
            if !initially_visible {
                r.execute("visibility", json!({"visible":false}), 300.).unwrap();
                r.marker_frame(300., &IDENTITY, &IDENTITY, 800., 600.);
            }
            assert_eq!(r.markers.iter().find(|m| m.region["name"] == "saved").unwrap().current_visibility, initially_visible);
            r.execute("runtimeBone", json!({"target":"LeftEye","options":{"projectToSurface":false}}), 300.).unwrap();

            let profile = json!({"auToBones":{"1":[{"node":"LeftEye"},{"node":"RightEye"}]}});
            for side in ["left", "right"] {
                let generated = r.execute("runtimeAU", json!({"target":"1","profile":profile,
                    "options":{"targetSide":side,"projectToSurface":false}}), 301.).unwrap();
                let name = generated[0]["name"].as_str().unwrap();
                assert_eq!(r.visible, initially_visible, "preview must not change saved visibility");
                r.plan_markers("{}").unwrap();
                let frame = r.marker_frame(302., &IDENTITY, &IDENTITY, 800., 600.);
                for (marker, record) in r.markers.iter().zip(frame.chunks_exact(markers::FRAME_STRIDE)) {
                    assert_eq!(marker.current_visibility, text(&marker.region, "name") == name);
                    if text(&marker.region, "name") != name {
                        assert_eq!(record[1], 0., "other markers must hide immediately");
                    }
                }
            }
            let before_failure = r.snapshot_value();
            assert!(r.execute("runtimeAU", json!({"target":"99","profile":{},"options":{"replaceExisting":true}}), 303.).is_err());
            assert_eq!(r.snapshot_value(), before_failure);
            r.camera.position = [0., 1., 6.];
            r.marker_frame(303., &IDENTITY, &IDENTITY, 800., 600.);
            assert_eq!(r.expanded.get("head"), Some(&true));
            r.execute("clearRuntime", json!({}), 304.).unwrap();
            r.marker_frame(600., &IDENTITY, &IDENTITY, 800., 600.);
            assert_eq!(r.visible, initially_visible);
            assert_eq!(r.regions, saved.as_array().unwrap().clone());
            assert_eq!(r.current.as_deref(), Some("saved"));
            assert_eq!(r.solo.as_deref(), Some("saved"));
            assert_eq!(r.expanded.get("head"), Some(&true));
            assert_eq!(r.markers.iter().find(|m| m.region["name"] == "saved").unwrap().current_visibility, initially_visible);
        }
    }
}

#[test]
fn au_preview_cleanup_respects_visibility_edits_and_character_replacement() {
    for end in ["clearRuntime", "clearModel", "configure"] {
        let mut r = runtime(json!([point_region("saved")]));
        r.execute("runtimeAU", json!({"target":"1","profile":{"auToBones":{"1":["LeftEye"]}}}), 0.).unwrap();
        assert!(!r.visible, "AU preview is independent of saved visibility");
        assert!(r.has_runtime_preview());
        r.execute(end, json!({"config":{"characterId":"replacement","regions":[]}}), 1.).unwrap();
        assert!(!r.visible);
        assert!(!r.has_runtime_preview());
    }
    let mut r = runtime(json!([]));
    r.execute("runtimeAU", json!({"target":"1","profile":{"auToBones":{"1":["LeftEye"]}}}), 0.).unwrap();
    r.execute("visibility", json!({"visible":true}), 1.).unwrap();
    r.execute("clearRuntime", json!({}), 2.).unwrap();
    assert!(r.visible);
}
fn panned_projection(pan: f32) -> [f32; 16] {
    // Perspective camera (pan, 1, 2), looking along -Z. Near=.1, far=10,
    // with focal scale 1: clip.w = 2-z and clip.x = x-pan.
    let depth = 10.1 / 9.9;
    let offset = -2. / 9.9;
    [1., 0., 0., 0., 0., 1., 0., 0., 0., 0., -depth, -1.,
        -pan, -1., 2. * depth + offset, 2.]
}

#[test]
fn runtime_leaders_use_perspective_projected_side_after_panning() {
    let model = model();
    for pan in [-0.5, 0.5] {
        let camera = [pan, 1., 2.];
        let matrix = panned_projection(pan);
        // This near-center anchor crosses projected center because it is nearer
        // than the model center. Its world X offset has the opposite sign.
        let anchor = [pan * 0.02, 1., 0.1];
        let center_x = markers::projected_x(&matrix, model.bounds.center()).unwrap();
        let anchor_x = markers::projected_x(&matrix, anchor).unwrap();
        assert!((anchor_x - center_x) * anchor[0] < 0.);
        for (kind, bone, mesh, morphs) in [
            ("bone", Some("LeftEye"), None, vec![]),
            ("morph", None, Some("Body"), vec!["Brow_Left".to_owned()]),
        ] {
            let region = targets::make_region(kind, "target", bone, mesh, &morphs, None, &json!({}));
            let style = markers::merged_style(&region, &json!({}));
            let direction = markers::runtime_outward(&region, &style, anchor, &model, -1., camera,
                [1., 0., 0.], Some(&matrix)).unwrap();
            let end = add_scaled3(anchor, direction, 0.3);
            let end_x = markers::projected_x(&matrix, end).unwrap();
            assert!((end_x - anchor_x) * (anchor_x - center_x) > 0.,
                "{kind} leader must leave the projected center after pan {pan}");
            assert!((end_x - center_x).abs() > (anchor_x - center_x).abs());
        }
    }
}

#[test]
fn invalid_projection_uses_a_finite_runtime_leader_fallback() {
    let model = model();
    let region = targets::make_region("bone", "LeftEye", Some("LeftEye"), None, &[], None, &json!({}));
    let style = markers::merged_style(&region, &json!({}));
    let invalid = [f32::NAN; 16];
    let direction = markers::runtime_outward(&region, &style, [-0.2, 1.6, 0.1], &model,
        -1., [0., 1., 3.], [f32::NAN, 0., 0.], Some(&invalid)).unwrap();
    assert!(direction.iter().all(|value| value.is_finite()));
    assert!(direction[0] < 0.);
}

#[test]
fn standalone_bone_and_morph_previews_do_not_need_saved_annotations_enabled() {
    for style in ["3d", "html"] {
        for initially_visible in [false, true] {
            for op in ["runtimeBone", "runtimeMorph"] {
                let mut saved = point_region("saved");
                saved["markerAnchor"]["position"] = json!({"x":0.,"y":0.,"z":0.});
                saved["style"] = json!({"lineDirection":{"x":-1.,"y":0.,"z":0.}});
                let mut r = runtime(json!([saved]));
                r.execute("style", json!({"style":style}), 0.).unwrap();
                r.execute("visibility", json!({"visible":initially_visible}), 0.).unwrap();
                r.execute("solo", json!({"name":"saved"}), 0.).unwrap();
                r.execute("select", json!({"name":"saved"}), 0.).unwrap();
                r.plan_markers("{}").unwrap();
                r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
                r.marker_frame(300., &IDENTITY, &IDENTITY, 800., 600.);
                let target = if op == "runtimeMorph" { "Brow_Left" } else { "LeftEye" };
                let summary = r.execute(op, json!({"target":target,"mesh":"Body",
                    "options":{"projectToSurface":false}}), 301.).unwrap();
                let name = summary["name"].as_str().unwrap();
                r.plan_markers(&json!({(name):[0.2,0.1,0.1]}).to_string()).unwrap();
                // Even a native hair hit cannot suppress a transient HTML marker.
                let id = r.markers.iter().find(|m| m.region["name"] == name).unwrap().id;
                r.observe_occlusion(&[id as f32, 0.01]);
                let frame = r.marker_frame(302., &IDENTITY, &IDENTITY, 800., 600.);
                assert_eq!(r.visible, initially_visible);
                assert_eq!(r.current.as_deref(), Some("saved"));
                assert_eq!(r.solo.as_deref(), Some("saved"));
                for (marker, record) in r.markers.iter().zip(frame.chunks_exact(markers::FRAME_STRIDE)) {
                    assert_eq!(record[1], if text(&marker.region, "name") == name { 1. } else { 0. });
                }
                assert!(r.snapshot_value()["descriptors"].as_array().unwrap().iter()
                    .filter(|d| d["runtimePreview"] == true).all(|d| d["name"] == name));
                assert_eq!(r.execute("pick", json!({"ids":[id]}), 302.).unwrap(), name);
                assert!(!r.occlusion_queries().chunks_exact(8).any(|query| query[0] == id as f32));
                r.execute("clearRuntime", json!({}), 303.).unwrap();
                r.marker_frame(600., &IDENTITY, &IDENTITY, 800., 600.);
                assert_eq!(r.visible, initially_visible);
                assert_eq!(r.markers.len(), 1);
                assert_eq!(r.markers[0].current_visibility, initially_visible);
            }
        }
    }
}

#[test]
fn transient_marker_rebuilds_preserve_authored_directions_and_track_hidden_bones() {
    let mut first = point_region("first");
    first["style"] = json!({"lineDirection":{"x":1.,"y":0.,"z":0.}});
    let mut second = first.clone();
    second["name"] = json!("second");
    let mut r = runtime(json!([first, second]));
    r.plan_markers("{}").unwrap();
    r.finish_markers(r.generation());
    let directions = r.markers.iter().map(|marker| marker.direction).collect::<Vec<_>>();
    assert_eq!(directions, vec![[1., 0., 0.], [1., 0., 0.]]);
    let layout = r.markers.iter().map(|marker| marker.layout_direction).collect::<Vec<_>>();
    assert!(distance3(layout[0].unwrap(), layout[1].unwrap()) > 0.01);
    assert!(!r.visible);
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{"projectToSurface":false}}), 0.).unwrap();
    r.plan_markers("{}").unwrap();
    r.finish_markers(r.generation());
    assert_eq!(&r.markers[..2].iter().map(|marker| marker.direction).collect::<Vec<_>>(), &directions);
    assert_eq!(r.markers[..2].iter().map(|marker| marker.layout_direction).collect::<Vec<_>>(), layout);
    assert!(r.tracked_objects().contains(&2));
    let mut moved = IDENTITY;
    moved[12] = 0.4;
    r.observe_transforms(&[&[2.][..], &moved[..]].concat());
    r.marker_frame(1., &IDENTITY, &IDENTITY, 800., 600.);
    let bone = r.markers.iter().find(|marker| text(&marker.region["runtimeAnnotation"], "targetType") == "bone").unwrap();
    assert!((bone.start[0] - 0.2).abs() < 1e-5);
    r.execute("clearRuntime", json!({}), 2.).unwrap();
    r.plan_markers("{}").unwrap();
    r.finish_markers(r.generation());
    assert_eq!(r.markers.iter().map(|marker| marker.direction).collect::<Vec<_>>(), directions);
    assert_eq!(r.markers.iter().map(|marker| marker.layout_direction).collect::<Vec<_>>(), layout);
}

#[test]
fn bone_previews_anchor_at_the_posed_bone_unless_surface_projection_is_requested() {
    let mut r = runtime(json!([]));
    for (op, payload) in [
        ("runtimeBone", json!({"target":"LeftEye"})),
        ("runtimeAU", json!({"target":"1","profile":{"auToBones":{"1":["LeftEye"]}}})),
    ] {
        r.execute(op, payload, 0.).unwrap();
        let queries = r.plan_markers("{}").unwrap();
        assert!(parse(&queries).unwrap().as_array().unwrap().is_empty());
        assert_eq!(r.markers.len(), 1);
        let marker = &r.markers[0];
        assert!(!marker.project);
        assert!(marker.ready);
        assert_eq!(marker.track, Some(2));
        assert_eq!(marker.start, [-0.2, 1.6, 0.1]);
        assert_eq!(marker.region["markerAnchor"]["projectToSurface"], false);
    }
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{"projectToSurface":true}}), 1.).unwrap();
    let queries = r.plan_markers("{}").unwrap();
    assert_eq!(parse(&queries).unwrap().as_array().unwrap().len(), 1);
    assert!(r.markers[0].project);
    assert!(!r.markers[0].ready);
}

#[test]
fn runtime_previews_replace_by_default_and_invalid_morph_requests_are_atomic() {
    let mut r = runtime(json!([]));
    r.execute("runtimeBone", json!({"target":"LeftEye"}), 0.).unwrap();
    let morph = r.execute("runtimeMorph", json!({"mesh":"Body","target":"Brow_Left"}), 1.).unwrap();
    assert_eq!(r.runtime_names.len(), 1);
    assert_eq!(morph["targetType"], "morph");
    assert_eq!(morph["label"], "Morph: Brow_Left");
    assert_eq!(morph["morphs"], json!(["Brow_Left"]));
    let before = r.snapshot_value();
    for request in [json!({"mesh":"Missing","target":"Brow_Left"}), json!({"mesh":"Body","target":"Missing"})] {
        assert!(r.execute("runtimeMorph", request, 2.).is_err());
        assert_eq!(r.snapshot_value(), before);
    }
    assert!(r.execute("runtimeBone", json!({"target":"Missing"}), 2.).is_err());
    assert_eq!(r.snapshot_value(), before);
    r.config["profile"] = json!({"boneNodes":{"left_eye":"LeftEye"}});
    let alias = r.execute("runtimeBone", json!({"target":"left_eye","options":{"replaceExisting":false}}), 3.).unwrap();
    assert_eq!(alias["bones"], json!(["left_eye"]));
    assert_eq!(r.runtime_names.len(), 2);
    r.execute("visibility", json!({"visible":true}), 4.).unwrap();
    assert!(r.has_runtime_preview());
    r.execute("visibility", json!({"visible":false}), 5.).unwrap();
    assert!(r.has_runtime_preview());
    r.execute("clearRuntime", json!({}), 6.).unwrap();
    assert!(!r.visible);
    assert!(!r.has_runtime_preview());
}

#[test]
fn html_and_three_share_expansion_solo_style_and_marker_identity() {
    let mut parent = point_region("head");
    parent["children"] = json!(["eye"]);
    let mut child = point_region("eye");
    child["parent"] = json!("head");
    let mut r = runtime(json!([parent, child]));
    r.plan_markers("{}").unwrap();
    let ids = r.markers.iter().map(|m| m.id).collect::<Vec<_>>();
    r.execute("expand", json!({"name":"head"}), 0.).unwrap();
    r.execute("solo", json!({"name":"eye"}), 0.).unwrap();
    r.execute("style", json!({"style":"html"}), 0.).unwrap();
    assert_eq!(r.expanded.get("head"), Some(&true));
    assert_eq!(r.solo.as_deref(), Some("eye"));
    assert_eq!(r.markers.iter().map(|m| m.id).collect::<Vec<_>>(), ids);
    r.execute(
        "updateRegion",
        json!({"name":"eye","update":{"style":{"line":{"curve":"arc"}}}}),
        0.,
    )
    .unwrap();
    r.plan_markers("{}").unwrap();
    assert_eq!(r.markers[1].id, ids[1]);
    assert_eq!(r.markers[1].style["line"]["curve"], "arc");
}
#[test]
fn projected_markers_use_outer_surface_and_fallback_query_before_commit() {
    let mut r = runtime(json!([{"name":"eye","bones":["LeftEye"]}]));
    let plans: Value = serde_json::from_str(&r.plan_markers("{}").unwrap()).unwrap();
    let id = plans[0]["id"].as_u64().unwrap() as u32;
    let generation = r.generation;
    let fallback: Value = serde_json::from_str(&r.surface_result(generation, id, 0, &[])).unwrap();
    assert_eq!(fallback["phase"], 1);
    assert!(!r.markers[0].ready);
    r.surface_result(generation, id, 1, &[0., 1., 0.1, 0., 1., 0.3]);
    assert!(r.markers[0].ready);
    assert!(r.markers[0].start[2] > 0.3);
}
#[test]
fn morph_candidates_handle_relative_absolute_and_semantic_bands() {
    let base = [0., 0., 0., 0., 1., 0., 0., 2., 0., 0., 3., 0.];
    let relative = [0., 0., 0.1, 0., 0., 0.2, 0., 0., 0.3, 0., 0., 0.4];
    let absolute = base
        .iter()
        .zip(relative)
        .map(|(b, m)| b + m)
        .collect::<Vec<_>>();
    assert_eq!(
        markers::morph_candidates(&base, &relative, true),
        markers::morph_candidates(&base, &absolute, false)
    );
    let center = markers::morph_center(
        &json!({"name":"brow"}),
        &[
            0., 0., 0., 1., 0., 1., 0., 1., 0., 2., 0., 1., 0., 3., 0., 1.,
        ],
    )
    .unwrap();
    assert_eq!(center[1], 2.5);
    assert!(markers::morph_candidates(&base, &[0.; 3], true).is_empty());
    assert!(markers::morph_center(&json!({}), &[]).is_none());
}
#[test]
fn native_vertex_selection_uses_weights_without_baking_a_second_skinning_solver() {
    assert_eq!(
        &*annotation_bone_vertices(
            &[0., 1., 0., 0., 1., 2., 0., 0.],
            &[0.9, 0.1, 0., 0., 0.2, 0.8, 0., 0.],
            &[1]
        ),
        &[1]
    );
    assert_eq!(
        &*annotation_point_bounds(&[1., 2., 3., -1., 0., 4.]),
        &[-1., 0., 3., 1., 2., 4.]
    );
}
#[test]
fn preview_and_reveal_deadlines_cancel_without_late_effects() {
    let mut preview = AnnotationLifecycle::new("preview", 1200.);
    assert_eq!(
        preview.execute("start", &json!({}), 0.).unwrap(),
        json!([{"kind":"previewStart"}])
    );
    assert_eq!(
        preview.execute("start", &json!({}), 1000.).unwrap(),
        json!([])
    );
    assert_eq!(preview.deadline(), Some(2200.));
    assert_eq!(
        preview.execute("end", &json!({}), 1100.).unwrap(),
        json!([{"kind":"previewEnd"}])
    );
    assert_eq!(
        preview.execute("tick", &json!({}), 5000.).unwrap(),
        json!([])
    );
    let mut reveal = AnnotationLifecycle::new("visibility", 5000.);
    reveal
        .execute("reveal", &json!({"revealDelayMs":4500}), 0.)
        .unwrap();
    reveal
        .execute("manual", &json!({"visible":false}), 100.)
        .unwrap();
    assert_eq!(
        reveal.execute("tick", &json!({}), 10000.).unwrap(),
        json!([])
    );
}

#[test]
fn parent_pick_expands_children_but_hidden_markers_cannot_be_picked() {
    let mut parent = point_region("head");
    parent["children"] = json!(["eye"]);
    let mut child = point_region("eye");
    child["parent"] = json!("head");
    let mut r = runtime(json!([parent, child]));
    r.plan_markers("{}").unwrap();
    let id = r.markers[0].id;
    assert_eq!(
        r.execute("pick", json!({"ids":[id]}), 0.).unwrap(),
        Value::Null
    );
    r.visible = true;
    r.markers[0].current_visibility = true;
    assert_eq!(
        r.execute("pick", json!({"ids":[id]}), 1.).unwrap(),
        json!("head")
    );
    assert_eq!(r.expanded.get("head"), Some(&true));
    assert!(r.markers[1].transition.is_some());
    r.execute("pick", json!({"ids":[id]}), 2.).unwrap();
    assert_eq!(r.expanded.get("head"), Some(&false));
}
#[test]
fn frames_gate_children_solo_occlusion_and_fully_hidden_tracking() {
    let mut parent = point_region("head");
    parent["children"] = json!(["eye"]);
    let mut child = point_region("eye");
    child["parent"] = json!("head");
    let mut r = runtime(json!([parent, child]));
    r.plan_markers("{}").unwrap();
    r.execute("style", json!({"style":"html"}), 0.).unwrap();
    r.execute("visibility", json!({"visible":true}), 0.)
        .unwrap();
    r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(r.markers[0].current_visibility);
    assert!(!r.markers[1].current_visibility);
    r.execute("expand", json!({"name":"head","duration":0}), 10.)
        .unwrap();
    r.execute("solo", json!({"name":"eye"}), 10.).unwrap();
    r.marker_frame(500., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(!r.markers[0].current_visibility);
    assert!(r.markers[1].current_visibility);
    let queries = r.occlusion_queries();
    assert_eq!(queries.len(), 16);
    r.observe_occlusion(&[r.markers[1].id as f32, 0.25]);
    r.marker_frame(501., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(!r.markers[1].current_visibility);
    r.execute("visibility", json!({"visible":false}), 502.)
        .unwrap();
    r.marker_frame(2000., &IDENTITY, &IDENTITY, 800., 600.);
    assert!(r
        .marker_frame(2001., &IDENTITY, &IDENTITY, 800., 600.)
        .is_empty());
    assert!(r.tracked_objects().is_empty());
}
#[test]
fn zoom_out_collapses_at_each_views_original_distance_threshold() {
    for (style, threshold) in [("3d", 4.), ("html", 5.)] {
        let mut parent = point_region("head");
        parent["children"] = json!(["eye"]);
        let mut r = runtime(json!([parent]));
        r.plan_markers("{}").unwrap();
        r.style = style.into();
        r.visible = true;
        r.expanded.insert("head".into(), true);
        r.camera.position = [0., 1., threshold - 0.1];
        r.marker_frame(0., &IDENTITY, &IDENTITY, 800., 600.);
        assert_eq!(r.expanded.get("head"), Some(&true));
        r.camera.position = [0., 1., threshold + 0.1];
        r.marker_frame(1000., &IDENTITY, &IDENTITY, 800., 600.);
        assert_eq!(r.expanded.get("head"), Some(&false));
    }
}
#[test]
fn region_edits_clear_optional_anchors_and_invalid_settings_are_atomic() {
    let mut r = runtime(json!([point_region("eye")]));
    r.execute(
        "updateRegion",
        json!({"name":"eye","update":{"markerAnchor":null,"bones":["LeftEye"]}}),
        0.,
    )
    .unwrap();
    assert!(r.regions[0]["markerAnchor"].is_null());
    r.plan_markers("{}").unwrap();
    assert!(r.markers[0].project);
    let settings = r.settings.clone();
    assert!(r
        .execute("settings", json!({"minDistance":10,"maxDistance":1}), 1.)
        .is_err());
    assert_eq!(r.settings, settings);
}
#[test]
fn runtime_names_and_labels_match_existing_preview_identifiers() {
    let r = targets::make_region(
        "au",
        "1",
        None,
        Some("Face Mesh"),
        &["Brow_L".into()],
        Some("left"),
        &json!({"label":"Brow"}),
    );
    assert_eq!(r["name"], "runtime:annotation:au:1:left:mesh:Face~20Mesh");
    assert_eq!(r["label"], "Brow");
    let r = targets::make_region("bone", "Head", Some("Head"), None, &[], None, &json!({}));
    assert_eq!(r["name"], "runtime:annotation:bone:Head:bone:Head");
    assert_eq!(r["label"], "Bone: Head");
}
#[test]
fn nested_profile_affixes_and_rotated_laterality_resolve_inside_rust() {
    let mut model = model();
    model.objects[1].name = "Rig_LeftEye_end".into();
    let profile = json!({"profile":{"boneNodes":{"left_eye":"LeftEye"},"bonePrefix":"Rig_","boneSuffix":"_end"}});
    let region = json!({"name":"left_eye","bones":["left_eye"]});
    assert_eq!(model.resolve(&region, &profile), vec![2]);
    assert_eq!(model.laterality(&[region], &profile), (-1., 1.));
}
#[test]
fn intro_lands_on_the_left_eye_and_releases_its_camera_request() {
    let mut eye = point_region("left_eye");
    eye["focusTarget"]["position"] = json!({"x":-0.2,"y":1.6,"z":0.1});
    let mut r = runtime(json!([eye]));
    r.execute("intro", json!({"orbitDuration":100,"zoomDuration":50}), 0.)
        .unwrap();
    r.camera_frame(75., &[]);
    assert!(r.camera.moving());
    r.camera_frame(150., &[]);
    assert!(!r.camera.moving());
    assert_eq!(r.camera.finished, r.camera.generation);
    assert_eq!(r.current.as_deref(), Some("left_eye"));
    assert!((r.camera.target[0] + 0.2).abs() < 1e-5);
    assert!((r.camera.target[1] - 1.6).abs() < 1e-5);
}
#[test]
fn repeated_previews_replace_old_options_without_rebuilding_identical_regions() {
    let mut r = runtime(json!([]));
    r.execute(
        "runtimeBone",
        json!({"target":"LeftEye","options":{"markerColor":123}}),
        0.,
    )
    .unwrap();
    let generation = r.generation;
    r.execute(
        "runtimeBone",
        json!({"target":"LeftEye","options":{"markerColor":123}}),
        1.,
    )
    .unwrap();
    assert_eq!(r.generation, generation);
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{}}), 2.)
        .unwrap();
    assert!(r.regions[0]["style"]["markerColor"].is_null());
}

#[test]
fn gestures_and_observation_queries_do_not_invalidate_region_snapshots() {
    let mut r = runtime(json!([point_region("saved")]));
    r.plan_markers("{}").unwrap();
    let revision = r.revision;
    let config_revision = r.config_revision;
    let initial_position = r.camera.position;
    for (operation, payload) in [
        ("input", json!({"kind":"down","id":1,"x":0,"y":0,"height":600})),
        ("input", json!({"kind":"move","id":1,"x":100,"y":20})),
        ("markerPosition", json!({"name":"saved"})),
        ("morphRequests", json!({})),
        ("focusObjects", json!({"name":"saved"})),
        ("controls", json!({})),
    ] {
        r.execute(operation, payload, 1.).unwrap();
        assert_eq!(r.revision, revision, "{operation} invalidated the snapshot");
        assert_eq!(r.config_revision, config_revision);
    }
    r.camera_frame(16., &[]);
    assert_ne!(r.camera.position, initial_position);
    assert_eq!(r.revision, revision);
}

#[test]
fn config_revision_changes_only_with_configuration_content_or_reset() {
    let mut r = runtime(json!([point_region("saved")]));
    let configured = r.config_revision;
    for (operation, payload) in [
        ("select", json!({"name":"saved"})),
        ("visibility", json!({"visible":true})),
        ("hover", json!({"id":1})),
        ("solo", json!({"name":"saved"})),
        ("style", json!({"style":"html"})),
        ("settings", json!({"minDistance":1})),
    ] {
        r.execute(operation, payload, 0.).unwrap();
        assert_eq!(r.config_revision, configured, "{operation} changed config identity");
    }
    assert_eq!(r.snapshot_value()["configRevision"], json!(configured));
    r.execute("updateRegion", json!({"name":"saved","update":{"label":"Edited"}}), 1.)
        .unwrap();
    assert_eq!(r.config_revision, configured + 1);
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{}}), 2.)
        .unwrap();
    let preview = r.config_revision;
    assert_eq!(preview, configured + 2);
    r.execute("runtimeBone", json!({"target":"LeftEye","options":{}}), 3.)
        .unwrap();
    assert_eq!(r.config_revision, preview);
    r.execute("removeRegion", json!({"name":"saved"}), 4.)
        .unwrap();
    assert_eq!(r.config_revision, preview + 1);
    r.execute("clear", json!({}), 5.).unwrap();
    assert_eq!(r.config_revision, preview + 2);
    r.set_model(&serde_json::to_string(&model()).unwrap()).unwrap();
    assert_eq!(r.config_revision, preview + 3);
    r.execute("clearModel", json!({}), 6.).unwrap();
    assert_eq!(r.config_revision, preview + 4);
    assert!(r.model.is_none());
}

#[test]
fn marker_tracking_and_laterality_honor_target_order_instead_of_scene_order() {
    let mut observed = model();
    // LeftEye traverses before RightEye, but this marker deliberately names
    // RightEye first. Both bones still contribute to its initial center.
    let region = json!({"name":"left_pair","bones":["RightEye","LeftEye"],"markerAnchor":{"type":"region","projectToSurface":false}});
    let config = json!({});
    assert_eq!(observed.resolve(&region, &config), vec![2, 3]);
    assert_eq!(observed.primary_marker_object(&region, &config), Some(3));
    assert_eq!(observed.laterality(&[region.clone()], &config), (1., 1.));
    for object in observed.objects.iter_mut().filter(|object| object.kind == "Bone") {
        object.matrix[12..15].copy_from_slice(&object.position);
        object.inverse[12..15].copy_from_slice(&object.position.map(|value| -value));
    }
    let mut marker = Marker::new(1, region, &observed, &config, 1., [0., 1., 3.], None).unwrap();
    assert_eq!(marker.track, Some(3));
    assert_eq!(marker.start, [0., 1.6, 0.1]);
    observed.objects[1].matrix[12] += 10.;
    observed.objects[2].matrix[12] += 1.;
    marker.observe_anchor(&observed);
    assert!((marker.start[0] - 1.).abs() < 1e-5);

    // Preserve the previous primary-target contract if the first target is
    // missing; do not silently attach the marker to a later configured bone.
    let missing_first = json!({"bones":["Missing","LeftEye"]});
    assert_eq!(observed.primary_marker_object(&missing_first, &config), None);
    // Laterality still uses the first matching candidate as before.
    assert_eq!(observed.laterality(&[json!({"name":"left_pair","bones":["Missing","RightEye","LeftEye"]})], &config), (1., 1.));
}

#[test]
fn mesh_marker_primary_target_preserves_configured_order() {
    let mut observed = model();
    let mut second_mesh = observed.objects[0].clone();
    second_mesh.id = 4;
    second_mesh.name = "Face".into();
    observed.objects.push(second_mesh);
    let region = json!({"meshes":["Face","Body"]});
    assert_eq!(observed.resolve(&region, &json!({})), vec![1, 4]);
    assert_eq!(observed.primary_marker_object(&region, &json!({})), Some(4));
}

#[test]
fn wildcard_anchor_honors_explicit_surface_projection_override() {
    for (projection, expected_queries) in [(Some(false), 0), (Some(true), 1), (None, 1)] {
        let mut region = json!({"name":"whole_model","markerAnchor":{"type":"object","objects":["*"]}});
        if let Some(projection) = projection {
            region["markerAnchor"]["projectToSurface"] = json!(projection);
        }
        let mut runtime = runtime(json!([region]));
        let queries: Value = serde_json::from_str(&runtime.plan_markers("{}").unwrap()).unwrap();
        assert_eq!(queries.as_array().unwrap().len(), expected_queries);
        assert_eq!(runtime.markers[0].start, model().bounds.center());
        assert_eq!(runtime.markers[0].ready, expected_queries == 0);
    }
}

#[test]
fn marker_spheres_preserve_distance_and_selection_scaling() {
    let model = model();
    let mut marker = Marker::new(1, point_region("point"), &model, &json!({}), 1., [0., 1., 3.2], None).unwrap();
    for (distance, selected, expected) in [(1.2, false, 0.25), (2.4, false, 1.5), (3.2, false, 2.), (8., true, 2.6)] {
        let frame = marker.frame(0., &model, [0., 1., distance], &IDENTITY, &IDENTITY, [800., 800.], 1., true, selected, false, false, false);
        assert!((frame[8] - expected).abs() < 1e-5);
    }
}

#[test]
fn reveal_overshoot_fits_rendered_label_without_restarting_transition() {
    let model = model();
    let region = json!({"name":"point","customPosition":{"x":0.,"y":0.,"z":0.},"style":{"lineDirection":{"x":1.,"y":0.,"z":0.},"labelScale":0.04,"line":{"length":3.}}});
    let mut marker = Marker::new(1, region, &model, &json!({}), 1., [0., 1., 1.2], None).unwrap();
    marker.label_aspect = 2.5;
    for now in [0., 220. * 0.68, 220.] {
        let frame = marker.frame(now, &model, [0., 1., 1.2], &IDENTITY, &IDENTITY, [800., 800.], 1., true, false, false, false, false);
        assert_eq!(frame[1], 1.);
        assert!(frame[5].abs() + frame[9] / 2. <= 1. - 24. / 800. + 1e-6);
        assert!(frame[6].abs() + frame[10] / 2. <= 1. - 24. / 800. + 1e-6);
        if now == 220. * 0.68 {
            assert!((frame[9] - 0.085 * 1.28).abs() < 1e-5);
            assert_eq!(marker.transition, Some((true, 0., 220.)));
        }
    }
    assert!(marker.transition.is_none());
}

#[test]
fn temporary_overshoot_clipping_does_not_restart_reveal() {
    let model = model();
    let region = json!({"name":"point","customPosition":{"x":0.,"y":0.,"z":0.},"style":{"lineDirection":{"x":1.,"y":0.,"z":0.},"labelScale":0.4,"line":{"length":12.9}}});
    let mut marker = Marker::new(1, region, &model, &json!({}), 1., [0., 1., 1.2], None).unwrap();
    marker.label_aspect = 1.;
    for (now, expected_visible) in [(0., 1.), (220. * 0.68, 0.), (220., 1.)] {
        let frame = marker.frame(now, &model, [0., 1., 1.2], &IDENTITY, &IDENTITY, [800., 800.], 1., true, false, false, false, false);
        assert_eq!(frame[1], expected_visible);
        assert!(marker.current_visibility);
        if now < 220. {
            assert_eq!(marker.transition, Some((true, 0., 220.)));
        }
    }
    assert!(marker.transition.is_none());
}

#[test]
fn intro_preserves_authored_point_and_bone_focus_without_extra_bias_or_padding() {
    for focus_target in [
        json!({"type":"point","position":{"x":0.4,"y":0.7,"z":0.2},"cameraAngle":0}),
        json!({"type":"bone","bones":["RightEye"],"cameraAngle":0}),
    ] {
        let region = json!({"name":"left_eye","bones":["LeftEye"],
            "focusTarget":focus_target,"cameraOffset":{"x":0.2,"y":0.1,"z":0.05}});
        let mut r = runtime(json!([region]));
        r.execute("focus", json!({"name":"left_eye","duration":0}), 0.).unwrap();
        let position = r.camera.position;
        let target = r.camera.target;
        r.execute("intro", json!({"orbitDuration":100,"zoomDuration":50}), 0.).unwrap();
        r.camera_frame(150., &[]);
        for axis in 0..3 {
            assert!((r.camera.position[axis] - position[axis]).abs() < 1e-5);
            assert!((r.camera.target[axis] - target[axis]).abs() < 1e-5);
        }
        assert_eq!(r.current.as_deref(), Some("left_eye"));
    }
}

#[test]
fn intro_retains_default_eye_composition_without_an_authored_target() {
    let mut r = runtime(json!([{"name":"left_eye","bones":["LeftEye"]}]));
    r.execute("intro", json!({"orbitDuration":100,"zoomDuration":50}), 0.).unwrap();
    r.camera_frame(150., &[]);
    assert!((r.camera.target[0] + 0.2).abs() < 1e-5);
    assert!((r.camera.target[1] - 1.55).abs() < 1e-5);
}
