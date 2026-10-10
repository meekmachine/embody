use super::geometry::*;
use crate::annotation_camera::{
    add_scaled3, distance3, normalize3, quat_or_identity, rotate_by_quat, sub3,
};
use crate::annotation_markers as math;
use serde_json::{json, Value};

/// id, visibility, anchor(3), endpoint(3), sphere scale, label size(2),
/// item/line opacity, marker/line color, arrow quaternion(4), 17 curve points,
/// and HTML pixel position(2) plus display scale. All records use world space; HTML values use CSS pixels.
pub const FRAME_STRIDE: usize = 73;
pub struct Marker {
    pub id: u32,
    pub region: Value,
    pub style: Value,
    pub start: Point,
    pub direction: Point,
    pub length: f32,
    pub track: Option<u32>,
    pub local: Point,
    pub ready: bool,
    pub project: bool,
    pub label_aspect: f32,
    pub current_visibility: bool,
    pub occluded: bool,
    pub transition: Option<(bool, f64, f32)>,
    pub last_end: Point,
}
pub fn merged_style(region: &Value, config: &Value) -> Value {
    let mut style = json!({"markerRadius":0.008,"markerColor":0x4299e1,"lineColor":0x4299e1,"labelColor":"#ffffff","labelBackground":"rgba(0, 0, 0, 0.75)","labelFontSize":32,"opacity":1.,"lineDirection":"radial","line":{"style":"solid","curve":"straight","arrowHead":false,"thickness":2.,"length":0.5}});
    merge(&mut style, &config["markerDefaults"]);
    if let Some(length) = config["markerDefaults"]["lineLength"].as_f64() {
        style["line"]["length"] = json!(length);
    }
    merge(&mut style["line"], &config["lineDefaults"]);
    merge(&mut style, &region["style"]);
    if strings(&region["children"]).is_empty()
        && region["style"]["line"]["style"].is_null()
        && config["lineDefaults"]["style"].is_null()
    {
        style["line"]["style"] = json!("dashed")
    }
    style
}
pub fn merge(target: &mut Value, patch: &Value) {
    if let Some(patch) = patch.as_object() {
        for (k, v) in patch {
            if v.is_object() && target[k].is_object() {
                merge(&mut target[k], v)
            } else if !v.is_null() {
                target[k] = v.clone()
            }
        }
    }
}
fn outward(
    region: &Value,
    style: &Value,
    anchor: Point,
    model: &Model,
    left: f32,
    camera: Point,
) -> Point {
    if let Some(p) = point(&style["lineDirection"]) {
        return normalize3(p);
    }
    let named = text(style, "lineDirection");
    let world = |p| model.direction(p);
    match named {
        "camera" => return normalize3(sub3(camera, anchor)),
        "up" => return [0., 1., 0.],
        "down" => return [0., -1., 0.],
        "left" => return world([left, 0., 0.]),
        "right" => return world([-left, 0., 0.]),
        "forward" => return world([0., 0., 1.]),
        "backward" => return world([0., 0., -1.]),
        _ => (),
    }
    if let Some(angle) = camera_angle(region, left, false).filter(|angle| *angle != 0.) {
        let r = angle.to_radians();
        return world([r.sin(), 0., r.cos()]);
    }
    let name = text(region, "name").to_lowercase();
    let sign = side(&name).map(|s| side_sign(s, left));
    if let Some(sign) = sign {
        if has(&name, "eye|hand") {
            return world([sign, 0.1, 0.3]);
        }
    }
    if name == "eye" {
        let mut delta = sub3(anchor, model.bounds.center());
        delta[1] = 0.;
        return if distance3(delta, [0.; 3]) > 0.001 {
            normalize3(delta)
        } else {
            world([0., 0., 1.])
        };
    }
    if has(
        &name,
        "head|face|mouth|full_body|full body|upper_body|torso|chest",
    ) || name == "body"
    {
        return world([0., 0., 1.]);
    }
    if name.contains("pectoral") {
        if let Some(sign) = sign {
            return world([sign, -0.3, 0.2]);
        }
    }
    if has(&name, "foot|feet") {
        return world([0., -0.5, 0.5]);
    }
    if has(&name, "ventral|pelvic") {
        return world([0., -0.7, -0.5]);
    }
    if name.contains("anal") {
        return world([0., -0.6, -0.6]);
    }
    if name.contains("dorsal") {
        return world([0., 1., -0.3]);
    }
    if name.contains("fin") && sign.is_some() {
        return world([sign.unwrap(), 0., 0.]);
    }
    if has(&name, "tail|caudal") {
        return world([0., 0., -1.]);
    }
    if has(&name, "gill|operculum") {
        return world([sign.unwrap_or(-left), 0., 0.3]);
    }
    if name == "mouth" {
        return world([0., 0., 1.]);
    }
    if name.contains("throat") {
        return world([left, 0., 0.3]);
    }
    let delta = sub3(anchor, model.bounds.center());
    if distance3(delta, [0.; 3]) < 0.001 {
        world([0., 0., 1.])
    } else {
        normalize3(delta)
    }
}
pub fn mesh_side_offset(region: &Value, sign: f32, size: Point) -> Option<Point> {
    let metadata = &region["runtimeAnnotation"];
    if text(metadata, "targetType") != "au" || !["left", "right"].contains(&text(metadata, "side"))
    {
        return None;
    }
    let h = if size[1] != 0. { size[1] } else { 1. };
    let w = if size[0] != 0. { size[0] } else { h * 0.35 };
    let d = if size[2] != 0. { size[2] } else { h * 0.25 };
    let text = search_text(region);
    let y = if has(&text, "brow|forehead|frontalis|eye|lid|blink|squint") {
        0.1
    } else if has(&text, "nose|cheek|nasal") {
        0.04
    } else if has(
        &text,
        "mouth|lip|smile|frown|jaw|chin|dimple|pucker|stretch",
    ) {
        -0.06
    } else {
        0.02
    };
    Some([
        sign * (w * 0.18).min(h * 0.08).max(h * 0.035),
        h * y,
        (d * 0.08).max(h * 0.025),
    ])
}
pub fn search_text(region: &Value) -> String {
    format!(
        "{} {} {}",
        text(region, "name"),
        text(region, "label"),
        strings(&region["runtimeAnnotation"]["morphNames"]).join(" ")
    )
    .to_lowercase()
}
pub fn resolve_anchor(
    region: &Value,
    model: &Model,
    config: &Value,
    left: f32,
    morph_anchor: Option<Point>,
) -> Option<(Point, Option<u32>, bool)> {
    let resolved = anchor_region(region);
    let anchor = &resolved["region"];
    let explicit = point(&anchor["customPosition"]);
    if let Some(p) = explicit {
        return Some((p, None, text(&resolved, "projection") == "project"));
    }
    if strings(&anchor["objects"]).iter().any(|n| n == "*") {
        return Some((model.bounds.center(), None, true));
    }
    let face = text(&resolved["anchor"], "type") == "face-center"
        || (resolved["useLegacyRegionSemantics"] == true
            && text(anchor, "name").to_lowercase().contains("face"));
    let ids = model.resolve(anchor, config);
    let track = model.primary_marker_object(anchor, config);
    let mut center = if face {
        model.face(anchor, config).0
    } else {
        let mut bounds: Option<Bounds> = None;
        for id in &ids {
            if let Some(o) = model.object(*id) {
                let mut center = if o.kind == "Bone" {
                    o.position
                } else {
                    o.bounds.map(Bounds::center).unwrap_or(o.position)
                };
                if o.kind == "Mesh" && distance3(center, [0.; 3]) < 0.1 {
                    let bone = if o.name.contains("CC_Base_Eye") {
                        Some(if o.name.contains("_1") {
                            "CC_Base_R_Eye"
                        } else {
                            "CC_Base_L_Eye"
                        })
                    } else if has(&o.name, "Tongue|Teeth") {
                        Some("CC_Base_JawRoot")
                    } else {
                        None
                    };
                    if let Some(bone) =
                        bone.and_then(|name| model.objects.iter().find(|o| o.name == name))
                    {
                        center = bone.position
                    } else if o.name == "EYES_0" {
                        if let Some(head) = model
                            .objects
                            .iter()
                            .find(|o| o.name.contains("001_Armature"))
                        {
                            let offset = [
                                side(text(anchor, "name"))
                                    .map(|s| side_sign(s, left) * 0.035)
                                    .unwrap_or(0.),
                                0.01,
                                0.1,
                            ];
                            center = add_scaled3(
                                head.position,
                                rotate_by_quat(quat_or_identity(&model.quaternion), offset),
                                1.,
                            )
                        }
                    } else {
                        center = o.position
                    }
                }
                let b = Bounds::at(center);
                if let Some(all) = bounds.as_mut() {
                    all.union(b)
                } else {
                    bounds = Some(b)
                }
            }
        }
        bounds?.center()
    };
    if let Some(p) = morph_anchor {
        center = p
    } else if let Some(offset) = mesh_side_offset(
        region,
        side_sign(text(&region["runtimeAnnotation"], "side"), left),
        model.bounds.size(),
    ) {
        center = add_scaled3(
            center,
            rotate_by_quat(quat_or_identity(&model.quaternion), offset),
            1.,
        )
    }
    let mesh_only = !strings(&anchor["meshes"]).is_empty()
        && strings(&anchor["bones"]).is_empty()
        && strings(&anchor["objects"]).is_empty();
    if resolved["useLegacyRegionSemantics"] == true && !face && morph_anchor.is_none() {
        let name = text(anchor, "name").to_lowercase();
        let scale = model.bounds.size().into_iter().fold(0., f32::max) * 0.15;
        let offset = if name.contains("pectoral") {
            side(&name).map(|s| [side_sign(s, left), -0.3, 0.])
        } else if has(&name, "ventral|pelvic") {
            Some([0., -0.5, -0.3])
        } else if name.contains("anal") {
            Some([0., -0.5, -0.5])
        } else if has(&name, "caudal|tail") {
            Some([0., 0., -0.8])
        } else if name.contains("dorsal") {
            Some([0., 0.5, -0.3])
        } else if name == "mouth" {
            Some([0., 0., 0.6])
        } else if has(&name, "operculum|gill") {
            Some([
                0.3 * side(&name).map(|s| side_sign(s, left)).unwrap_or(-left),
                0.,
                0.,
            ])
        } else {
            None
        };
        if let Some(offset) = offset {
            center = add_scaled3(
                center,
                rotate_by_quat(quat_or_identity(&model.quaternion), offset),
                scale,
            )
        }
    }
    let project = match text(&resolved, "projection") {
        "project" => true,
        "skip" => false,
        _ => !mesh_only,
    };
    Some((
        center,
        if face {
            model.face(anchor, config).1.or(track)
        } else {
            track
        },
        project && morph_anchor.is_none(),
    ))
}
impl Marker {
    pub fn new(
        id: u32,
        region: Value,
        model: &Model,
        config: &Value,
        left: f32,
        camera: Point,
        morph: Option<Point>,
    ) -> Option<Self> {
        let (start, track, project) = resolve_anchor(&region, model, config, left, morph)?;
        let style = merged_style(&region, config);
        let direction = outward(&region, &style, start, model, left, camera);
        let length = number(&style["line"], "length", 0.5).max(0.) * model.bounds.size()[1] / 1.8;
        let local = track
            .and_then(|id| model.object(id))
            .map(|o| transform(&o.inverse, start))
            .unwrap_or(start);
        Some(Self {
            id,
            region,
            style,
            start,
            direction,
            length,
            track,
            local,
            ready: !project,
            project,
            label_aspect: 3.,
            current_visibility: false,
            occluded: false,
            transition: None,
            last_end: add_scaled3(start, direction, length),
        })
    }
    pub fn query(&self, phase: u32, model: &Model, generation: u32) -> Value {
        let extent = model.bounds.size().into_iter().fold(0., f32::max);
        let origin = if phase == 0 {
            add_scaled3(self.start, self.direction, extent * 2.)
        } else {
            model.bounds.center()
        };
        let direction = if phase == 0 {
            self.direction.map(|v| -v)
        } else {
            self.direction
        };
        json!({"id":self.id,"generation":generation,"phase":phase,"origin":origin,"direction":direction,"far":extent*if phase==0{4.}else{2.}})
    }
    pub fn commit_hits(
        &mut self,
        phase: u32,
        hits: &[Point],
        model: &Model,
        generation: u32,
    ) -> Value {
        if phase == 0 && hits.is_empty() {
            return self.query(1, model, generation);
        }
        let selected = if phase == 0 {
            hits.first()
        } else {
            hits.last()
        };
        let scale = model.bounds.size()[1] / 1.8;
        self.start = add_scaled3(
            selected.copied().unwrap_or(self.start),
            self.direction,
            if selected.is_some() {
                number(&self.style, "markerRadius", 0.008) * scale
            } else {
                0.05 * scale
            },
        );
        self.local = self
            .track
            .and_then(|id| model.object(id))
            .map(|o| transform(&o.inverse, self.start))
            .unwrap_or(self.start);
        self.ready = true;
        Value::Null
    }
    pub fn descriptor(&self, model: &Model, expanded: bool, number: usize) -> Value {
        let title = self.region["label"]
            .as_str()
            .filter(|label| !label.trim().is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format_label(text(&self.region, "name")));
        let parent = !strings(&self.region["children"]).is_empty();
        let indicator = if expanded { "−" } else { "+" };
        let label = if parent {
            format!("{title} {indicator}")
        } else {
            title.clone()
        };
        let html_text = if parent {
            indicator.to_owned()
        } else {
            number.to_string()
        };
        json!({"id":self.id,"name":self.region["name"],"label":label,"title":title,"htmlText":html_text,"style":self.style,"radius":super::geometry::number(&self.style,"markerRadius",0.008)*model.bounds.size()[1]/1.8,"arrowLength":0.02*model.bounds.size()[1]/1.8,"arrowRadius":0.008*model.bounds.size()[1]/1.8})
    }
    pub fn observe_anchor(&mut self, model: &Model) {
        if let Some(o) = self.track.and_then(|id| model.object(id)) {
            self.start = transform(&o.matrix, self.local)
        }
    }
    #[allow(clippy::too_many_arguments)]
    pub fn frame(
        &mut self,
        now: f64,
        model: &Model,
        camera: Point,
        projection: &[f32],
        view_projection: &[f32],
        viewport: [f32; 2],
        left: f32,
        structural: bool,
        selected: bool,
        hovered: bool,
        html: bool,
        animate_structural: bool,
    ) -> [f32; FRAME_STRIDE] {
        self.observe_anchor(model);
        let distance = distance3(camera, model.bounds.center());
        let height = model.bounds.size()[1].max(1e-5);
        let zoom = distance < height * 0.8;
        let label_y = number(&self.style, "labelScale", 0.024)
            * if selected { 1.1 } else { 1. }
            * if zoom { 0.85 } else { 1. };
        let label_x = label_y * self.label_aspect;
        let end = add_scaled3(
            self.start,
            self.direction,
            self.length * if zoom { 0.3 } else { 1. },
        );
        let projected_start = clip(view_projection, self.start);
        let projected_end = clip(view_projection, end);
        let bounds = math::resolve_viewport_safe_bounds(
            label_x,
            label_y,
            *projection.first().unwrap_or(&1.),
            *projection.get(5).unwrap_or(&1.),
            viewport[0],
            viewport[1],
            None,
        );
        let constrained = math::resolve_viewport_constrained_line_scale(
            &projected_start,
            &projected_end,
            bounds[0],
            bounds[1],
            None,
        );
        let inverse = [
            -model.quaternion[0],
            -model.quaternion[1],
            -model.quaternion[2],
            model.quaternion[3],
        ];
        let local = rotate_by_quat(
            quat_or_identity(&inverse),
            sub3(camera, model.bounds.center()),
        );
        let angle = local[0].atan2(local[2]).to_degrees();
        let visible = self.ready
            && structural
            && !(html && self.occluded)
            && math::passes_marker_camera_angle_gate(
                camera_angle(&self.region, left, true),
                Some(angle),
                None,
            )
            && (html || constrained[0] >= 1.);
        if visible != self.current_visibility {
            self.current_visibility = visible;
            if !self.transition.is_some_and(|(show, _, _)| show == visible) {
                self.transition = if structural || animate_structural {
                    Some((visible, now, 220.))
                } else {
                    None
                };
            }
        }
        let factors = if let Some((show, start, duration)) = self.transition {
            let t = ((now - start) as f32 / duration).clamp(0., 1.);
            if t >= 1. {
                self.transition = None
            }
            math::marker_visibility_animation_factors(show, t)
        } else {
            vec![
                if visible { 1. } else { 0. },
                1.,
                if visible { 1. } else { 0. },
            ]
            .into_boxed_slice()
        };
        let end = add_scaled3(self.start, sub3(end, self.start), constrained[1]);
        self.last_end = end;
        let curve = match text(&self.style["line"], "curve") {
            "bezier" => math::sample_marker_bezier_curve(&self.start, &end, 16),
            "arc" => math::sample_marker_arc_curve(&self.start, &end, 16),
            _ => {
                let mut points = Vec::with_capacity(51);
                for i in 0..17 {
                    points.extend_from_slice(&add_scaled3(
                        self.start,
                        sub3(end, self.start),
                        i as f32 / 16.,
                    ))
                }
                points.into_boxed_slice()
            }
        };
        let direction = normalize3(sub3(
            [curve[48], curve[49], curve[50]],
            [curve[45], curve[46], curve[47]],
        ));
        let quaternion = if direction[1] < -0.99999 {
            [1., 0., 0., 0.]
        } else {
            quat_or_identity(&[direction[2], 0., -direction[0], 1. + direction[1]])
        };
        let mut out = [0.; FRAME_STRIDE];
        out[0] = self.id as f32;
        out[1] = if visible || self.transition.is_some() {
            1.
        } else {
            0.
        };
        out[2..5].copy_from_slice(&self.start);
        out[5..8].copy_from_slice(&end);
        out[8] = if zoom { 0.25 } else { 1. } * if selected { 1.3 } else { 1. };
        out[9] = label_x * factors[1];
        out[10] = label_y * factors[1];
        out[11] = factors[0] * number(&self.style, "opacity", 1.);
        out[12] = factors[2]
            * number(&self.style, "opacity", 1.)
            * if selected {
                1.
            } else if zoom {
                0.6
            } else {
                0.9
            };
        out[13] = if selected || hovered {
            0x63b3ed as f32
        } else {
            number(&self.style, "markerColor", 0x4299e1 as f32)
        };
        out[14] = if selected || hovered {
            0x63b3ed as f32
        } else {
            number(&self.style, "lineColor", 0x4299e1 as f32)
        };
        out[15..19].copy_from_slice(&quaternion);
        out[19..70].copy_from_slice(&curve);
        let html_point = projected_start;
        if html_point[3] <= 0.
            || html_point[2].abs() > html_point[3].abs()
            || !html_point.iter().all(|v| v.is_finite())
        {
            if html {
                out[1] = 0.
            }
        } else {
            out[70] = (html_point[0] / html_point[3] * 0.5 + 0.5) * viewport[0];
            out[71] = (-html_point[1] / html_point[3] * 0.5 + 0.5) * viewport[1];
        }
        out[72] = factors[1]
            * if selected {
                1.3
            } else if hovered {
                1.2
            } else {
                1.
            };
        out
    }
}

/// Pure morph candidate scan. Native adapters only read buffers and evaluate the
/// returned vertex indices in the renderer's current skinned/morphed pose.
pub fn morph_candidates(base: &[f32], morphs: &[f32], relative: bool) -> Vec<f32> {
    if base.len() % 3 != 0 || base.is_empty() || morphs.len() % base.len() != 0 {
        return Vec::new();
    }
    let mut magnitudes = vec![0.0_f32; base.len() / 3];
    for morph in morphs.chunks_exact(base.len()) {
        for (index, p) in morph.chunks_exact(3).enumerate() {
            let d: [f32; 3] = std::array::from_fn(|axis| {
                p[axis] - if relative { 0. } else { base[index * 3 + axis] }
            });
            let magnitude = distance3(d, [0.; 3]);
            if magnitude.is_finite() {
                magnitudes[index] = magnitudes[index].max(magnitude)
            }
        }
    }
    let max = magnitudes.iter().copied().fold(0., f32::max);
    if max <= 1e-5 {
        return Vec::new();
    }
    magnitudes
        .iter()
        .enumerate()
        .filter(|(_, m)| **m >= (max * 0.06).max(1e-5))
        .flat_map(|(i, m)| [i as f32, *m])
        .collect()
}
pub fn morph_center(region: &Value, candidates: &[f32]) -> Option<Point> {
    let values = candidates
        .chunks_exact(4)
        .filter(|p| p.iter().all(|n| n.is_finite()) && p[3] > 0.)
        .collect::<Vec<_>>();
    if values.is_empty() {
        return None;
    }
    let text = search_text(region);
    let band = if has(&text, "brow|forehead|frontalis") {
        Some((0.75, 1.))
    } else if has(&text, "eye|lid|blink|squint|wide|occlusion|tearline|cheek") {
        Some((0.45, 0.9))
    } else if has(&text, "nose|nasal|sneer") {
        Some((0.35, 0.8))
    } else if has(&text, "jaw|chin") {
        Some((0., 0.3))
    } else if has(
        &text,
        "mouth|lip|smile|frown|dimple|pucker|stretch|press|funnel|roll|shrug|close",
    ) {
        Some((0., 0.45))
    } else if text.contains("tongue") {
        Some((0., 0.5))
    } else {
        None
    };
    let mut selected = Vec::new();
    if let Some((low, high)) = band {
        let mut y = values.iter().map(|p| p[1]).collect::<Vec<_>>();
        y.sort_by(f32::total_cmp);
        let lo = y[((y.len() - 1) as f32 * low) as usize];
        let hi = y[((y.len() - 1) as f32 * high) as usize];
        selected = values
            .iter()
            .copied()
            .filter(|p| p[1] >= lo - 1e-5 && p[1] <= hi + 1e-5)
            .collect();
    }
    if selected.len() < 2 {
        let max = values.iter().map(|p| p[3]).fold(0., f32::max);
        selected = values
            .into_iter()
            .filter(|p| p[3] >= (max * 0.18).max(1e-5))
            .collect()
    }
    let mut sum = [0.; 3];
    let mut weight = 0.;
    for p in selected {
        for i in 0..3 {
            sum[i] += p[i] * p[3]
        }
        weight += p[3]
    }
    if weight > 0. {
        Some(sum.map(|v| v / weight))
    } else {
        None
    }
}
