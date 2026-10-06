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
    assert!((r.camera.target[1] - 1.55).abs() < 1e-5);
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
