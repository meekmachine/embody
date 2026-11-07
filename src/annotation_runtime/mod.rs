//! Authoritative annotation/camera state. Native adapters supply observations and
//! execute renderer operations; they never select targets or maintain region policy.
mod camera;
mod geometry;
mod lifecycle;
mod markers;
mod morph_anchors;
mod query;
mod targets;
#[cfg(test)]
mod tests;
pub use lifecycle::*;
pub use query::*;

use crate::annotation_camera::{add_scaled3, distance3, normalize3, sub3};
use geometry::*;
use markers::{merge, Marker};
use morph_anchors::MorphAnchorPlan;
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use wasm_bindgen::prelude::*;

fn error(message: String) -> JsError {
    JsError::new(&message)
}
fn parse(json: &str) -> Result<Value, String> {
    serde_json::from_str(json).map_err(|e| format!("Invalid annotation input: {e}"))
}
fn validate_settings(settings: &Value) -> Result<(), String> {
    let min = number(settings, "minDistance", 0.5);
    let max = number(settings, "maxDistance", 10.);
    if min <= 0. || max < min {
        return Err("Camera distances require 0 < minDistance <= maxDistance".into());
    }
    Ok(())
}
fn patch_region(target: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (target.as_object_mut(), patch.as_object()) {
        for (key, value) in patch {
            if value.is_null() {
                target.remove(key);
            } else if value.is_object() && target.get(key).is_some_and(Value::is_object) {
                patch_region(target.get_mut(key).unwrap(), value);
            } else {
                target.insert(key.clone(), value.clone());
            }
        }
    }
}
fn validate_regions(regions: &[Value]) -> Result<(), String> {
    let mut names = BTreeSet::new();
    for region in regions {
        let name = text(region, "name");
        if name.trim().is_empty() || !names.insert(name) {
            return Err("Annotation regions require unique nonempty names".into());
        }
        for field in ["markerAnchor", "focusTarget"] {
            let target = &region[field];
            if target.is_null() {
                continue;
            }
            if !["region", "point", "bone", "mesh", "object", "face-center"]
                .contains(&text(target, "type"))
            {
                return Err(format!("Invalid {field} in {name}"));
            }
            if text(target, "type") == "point" && point(&target["position"]).is_none() {
                return Err(format!("Missing finite point for {name}.{field}"));
            }
        }
    }
    let parents = regions
        .iter()
        .flat_map(|r| {
            strings(&r["children"])
                .into_iter()
                .map(move |child| (child, text(r, "name").to_owned()))
        })
        .collect::<BTreeMap<_, _>>();
    for region in regions {
        let mut visited = BTreeSet::new();
        let mut current = text(region, "name").to_owned();
        while let Some(parent) = parents.get(&current).cloned().or_else(|| {
            regions
                .iter()
                .find(|r| text(r, "name") == current)
                .and_then(|r| r["parent"].as_str().map(str::to_owned))
        }) {
            if !visited.insert(current.clone()) {
                return Err("Annotation parent/child cycle".into());
            }
            current = parent
        }
    }
    Ok(())
}

#[wasm_bindgen]
pub struct AnnotationRuntime {
    config: Value,
    settings: Value,
    model: Option<Model>,
    regions: Vec<Value>,
    markers: Vec<Marker>,
    morph_anchors: BTreeMap<u32, MorphAnchorPlan>,
    morph_geometry_revisions: BTreeMap<u32, u32>,
    next_morph_anchor_id: u32,
    current: Option<String>,
    solo: Option<String>,
    hovered: Option<u32>,
    expanded: BTreeMap<String, bool>,
    runtime_names: BTreeSet<String>,
    ids: BTreeMap<String, u32>,
    next_id: u32,
    visible: bool,
    style: String,
    disposed: bool,
    generation: u32,
    revision: u32,
    config_revision: u32,
    descriptor_revision: u32,
    loaded: bool,
    camera: camera::Camera,
    last_distance: Option<f32>,
    left_side: f32,
}
#[wasm_bindgen]
impl AnnotationRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new(settings_json: &str) -> Result<AnnotationRuntime, JsError> {
        Self::create(parse(settings_json).map_err(error)?).map_err(error)
    }
    pub fn command(
        &mut self,
        operation: &str,
        payload_json: &str,
        now_ms: f64,
    ) -> Result<String, JsError> {
        let payload = parse(payload_json).map_err(error)?;
        let result = self.execute(operation, payload, now_ms).map_err(error)?;
        serde_json::to_string(&result).map_err(|e| error(e.to_string()))
    }
    pub fn snapshot(&self) -> String {
        self.snapshot_value().to_string()
    }
    pub fn revision(&self) -> u32 {
        self.revision
    }
    pub fn generation(&self) -> u32 {
        self.generation
    }
    pub fn completed_camera_request(&self) -> u32 {
        self.camera.finished
    }
    pub fn needs_frame(&self) -> bool {
        !self.disposed
            && (self.camera.moving()
                || self
                    .markers
                    .iter()
                    .any(|m| m.anchor_resolved && m.transition.is_some()))
    }
    pub fn is_current(&self, generation: u32) -> bool {
        !self.disposed && self.generation == generation
    }
    pub fn set_model(&mut self, model_json: &str) -> Result<(), JsError> {
        let model: Model = serde_json::from_str(model_json).map_err(|e| error(e.to_string()))?;
        model.validate().map_err(error)?;
        if self.disposed {
            return Err(error("Annotation runtime is disposed".into()));
        }
        self.invalidate();
        self.model = Some(model);
        self.regions.clear();
        self.config = json!({});
        self.config_revision = self.config_revision.wrapping_add(1);
        self.runtime_names.clear();
        self.current = None;
        self.expanded.clear();
        self.solo = None;
        self.hovered = None;
        self.markers.clear();
        self.loaded = false;
        self.ids.clear();
        self.next_id = 1;
        self.last_distance = None;
        self.descriptor_revision += 1;
        Ok(())
    }
    pub fn observe_model(&mut self, model_json: &str) -> Result<(), JsError> {
        let model: Model = serde_json::from_str(model_json).map_err(|e| error(e.to_string()))?;
        model.validate().map_err(error)?;
        if !self.disposed {
            self.model = Some(model)
        }
        Ok(())
    }
    pub fn tracked_objects(&self) -> Box<[u32]> {
        self.markers
            .iter()
            .filter(|m| {
                self.visible || self.runtime_names.contains(text(&m.region, "name"))
                    || m.current_visibility || m.transition.is_some()
            })
            .filter(|m| m.anchor_resolved && m.animated_anchor.is_none())
            .filter_map(|m| m.track)
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect::<Vec<_>>()
            .into_boxed_slice()
    }
    /// Packed observation records are [object id, column-major matrixWorld(16)].
    pub fn observe_transforms(&mut self, transforms: &[f32]) {
        if self.disposed {
            return;
        }
        let Some(model) = self.model.as_mut() else {
            return;
        };
        for entry in transforms.chunks_exact(17) {
            if !entry.iter().all(|n| n.is_finite()) {
                continue;
            }
            if let Some(object) = model.objects.iter_mut().find(|o| o.id == entry[0] as u32) {
                object.matrix.copy_from_slice(&entry[1..]);
                object.position = [entry[13], entry[14], entry[15]]
            }
        }
    }
    /// Prepare an attachment for this generation from mesh-space geometry.
    /// Returns [plan id, vertex indices...] or an empty array for a fallback anchor.
    /// Report geometry changes with observe_morph_geometry before preparing replacements.
    pub fn prepare_morph_anchor(
        &mut self,
        generation: u32,
        object_id: u32,
        region_name: &str,
        base: &[f32],
        morphs: &[f32],
        relative: bool,
    ) -> Box<[u32]> {
        if !self.is_current(generation) {
            return Box::new([]);
        }
        let Some(region) = self.regions.iter().find(|r| text(r, "name") == region_name) else {
            return Box::new([]);
        };
        if !self.morph_objects(region).contains(&object_id) {
            return Box::new([]);
        }
        let Some(mut plan) = MorphAnchorPlan::new(region, base, morphs, relative) else {
            return Box::new([]);
        };
        plan.object_id = object_id;
        let id = self.next_morph_anchor_id;
        self.next_morph_anchor_id = self.next_morph_anchor_id.wrapping_add(1);
        let indices = std::iter::once(id)
            .chain(plan.vertices.iter().map(|(index, _)| *index))
            .collect::<Vec<_>>();
        self.morph_anchors.insert(id, plan);
        indices.into_boxed_slice()
    }
    /// Native geometry identities/versions advance this per-object revision.
    /// Returns true when new geometry must be supplied. Retires old plan IDs
    /// without changing the region generation, marker IDs or reveal state.
    pub fn observe_morph_geometry(
        &mut self,
        generation: u32,
        object_id: u32,
        revision: u32,
        morph_names_json: &str,
    ) -> Result<bool, JsError> {
        if !self.is_current(generation)
            || self
                .morph_geometry_revisions
                .get(&object_id)
                .is_some_and(|seen| revision <= *seen)
            || !self.model.as_ref().is_some_and(|model| {
                model
                    .object(object_id)
                    .is_some_and(|object| object.kind == "Mesh")
            })
        {
            return Ok(false);
        }
        let names: Vec<String> =
            serde_json::from_str(morph_names_json).map_err(|e| error(e.to_string()))?;
        let affected = self
            .morph_anchors
            .values()
            .filter(|plan| plan.object_id == object_id)
            .map(|plan| plan.region.clone())
            .collect::<BTreeSet<_>>();
        self.morph_anchors
            .retain(|_, plan| plan.object_id != object_id);
        self.morph_geometry_revisions.insert(object_id, revision);
        if let Some(object) = self
            .model
            .as_mut()
            .and_then(|model| model.objects.iter_mut().find(|object| object.id == object_id))
        {
            object.morph_names = names;
        }
        for name in affected {
            self.refresh_morph_anchor(&name);
        }
        Ok(true)
    }
    /// Packed world-space XYZ observations in the prepared vertex order. Stale,
    /// incomplete or nonfinite observations leave the last valid anchor intact.
    pub fn observe_morph_anchor(&mut self, generation: u32, plan_id: u32, positions: &[f32]) -> bool {
        if !self.is_current(generation) {
            return false;
        }
        let Some(plan) = self.morph_anchors.get_mut(&plan_id) else {
            return false;
        };
        if !plan.observe(positions) {
            return false;
        }
        let name = plan.region.clone();
        self.refresh_morph_anchor(&name);
        true
    }
    /// The only camera integrator: pose observation(6), fov/aspect/viewport(4).
    /// Returns pose(6), active request id, completed request id, needs frame.
    pub fn camera_frame(&mut self, now_ms: f64, observation: &[f32]) -> Box<[f32]> {
        if self.disposed {
            return Box::new([]);
        }
        let before_position = self.camera.position;
        let before_target = self.camera.target;
        if observation.len() >= 10 && observation.iter().take(10).all(|v| v.is_finite()) {
            let position = [observation[0], observation[1], observation[2]];
            let target = [observation[3], observation[4], observation[5]];
            if distance3(position, self.camera.position) > 1e-5
                || distance3(target, self.camera.target) > 1e-5
            {
                self.camera.set_pose(position, target)
            }
            self.camera.fov = observation[6].clamp(1., 179.);
            self.camera.aspect = observation[7].max(0.001);
            self.camera.width = observation[8].max(1.);
            self.camera.height = observation[9].max(1.);
        }
        if let Some(region) = self.camera.sample(now_ms, &self.settings) {
            self.current = Some(region);
            self.revision += 1
        }
        let changed = distance3(before_position, self.camera.position) > 1e-7
            || distance3(before_target, self.camera.target) > 1e-7;
        let mut values = self.camera.position.to_vec();
        values.extend_from_slice(&self.camera.target);
        values.extend([
            self.camera.generation as f32,
            self.camera.finished as f32,
            if self.camera.moving() { 1. } else { 0. },
            if changed { 1. } else { 0. },
        ]);
        values.into_boxed_slice()
    }
    pub fn marker_frame(
        &mut self,
        now_ms: f64,
        projection: &[f32],
        view_projection: &[f32],
        width: f32,
        height: f32,
    ) -> Box<[f32]> {
        if self.disposed
            || !self.loaded
            || (!self.visible
                && !self.has_runtime_preview()
                && self
                    .markers
                    .iter()
                    .all(|m| !m.current_visibility && m.transition.is_none()))
        {
            return Box::new([]);
        }
        let Some(model) = self.model.as_ref() else {
            return Box::new([]);
        };
        let left = self.left_side;
        let runtime_preview = self.has_runtime_preview();
        let distance = distance3(self.camera.position, model.bounds.center());
        let threshold = model.bounds.size()[1] * if self.style == "html" { 2.5 } else { 2. };
        if !runtime_preview
            && self
                .last_distance
                .is_some_and(|previous| previous <= threshold)
            && distance > threshold
        {
            for expanded in self.expanded.values_mut() {
                *expanded = false
            }
            self.revision += 1;
            self.descriptor_revision += 1;
        }
        self.last_distance = Some(distance);
        // Runtime morph and bone leaders follow the current pose and view.
        // Saved explicit directions keep their authored meaning.
        let mut runtime_indices = Vec::new();
        for (index, marker) in self.markers.iter_mut().enumerate() {
            let name = text(&marker.region, "name");
            if runtime_preview && !self.runtime_names.contains(name) {
                continue;
            }
            marker.observe_anchor(model);
            if let Some(direction) = markers::runtime_outward(
                &marker.region,
                &marker.style,
                marker.start,
                model,
                left,
                self.camera.position,
                [0, 4, 8].map(|i| view_projection.get(i).copied().unwrap_or(0.)),
                Some(view_projection),
            ) {
                marker.direction = direction;
                runtime_indices.push(index);
            }
        }
        if runtime_indices.len() > 1 {
            let starts = runtime_indices
                .iter()
                .flat_map(|i| self.markers[*i].start)
                .collect::<Vec<_>>();
            let ends = runtime_indices
                .iter()
                .flat_map(|i| {
                    let marker = &self.markers[*i];
                    add_scaled3(marker.start, marker.direction, marker.length)
                })
                .collect::<Vec<_>>();
            let adjusted = crate::annotation_markers::separate_overlapping_marker_endpoints(
                &starts,
                &ends,
                &model.bounds.center(),
                model.bounds.size()[1],
            );
            for (index, end) in runtime_indices.into_iter().zip(adjusted.chunks_exact(3)) {
                let marker = &mut self.markers[index];
                let direction = normalize3(sub3([end[0], end[1], end[2]], marker.start));
                // Endpoint separation must preserve the chosen projected side.
                let outward = match (
                    markers::projected_x(view_projection, marker.start),
                    markers::projected_x(view_projection, add_scaled3(marker.start, marker.direction, marker.length)),
                    markers::projected_x(view_projection, [end[0], end[1], end[2]]),
                ) {
                    (Some(start), Some(original), Some(adjusted)) => (original - start) * (adjusted - start) > 0.,
                    _ => true,
                };
                if outward && crate::annotation_camera::dot3(direction, marker.direction) > 0.5 {
                    marker.direction = direction;
                }
            }
        }
        let mut values = Vec::with_capacity(self.markers.len() * markers::FRAME_STRIDE);
        for marker in &mut self.markers {
            let name = text(&marker.region, "name").to_owned();
            let parent = marker.region["parent"].as_str().or_else(|| {
                self.regions
                    .iter()
                    .find(|r| strings(&r["children"]).iter().any(|n| n == &name))
                    .map(|r| text(r, "name"))
            });
            let expanded = parent
                .map(|p| self.expanded.get(p) == Some(&true))
                .unwrap_or(true);
            let preview_marker = self.runtime_names.contains(&name);
            let included = if runtime_preview {
                preview_marker
            } else {
                self.visible && expanded && self.solo.as_ref().map(|s| s == &name).unwrap_or(true)
            };
            if runtime_preview && !included {
                // Cancel even an already-running hide animation: no other
                // labels may remain onscreen underneath a slider preview.
                marker.current_visibility = false;
                marker.transition = None;
            }
            if preview_marker {
                // Transient callouts remain readable through hair and other meshes.
                marker.occluded = false;
            }
            let structural = included && marker.region["isFallback"] != true;
            values.extend_from_slice(&marker.frame(
                now_ms,
                model,
                self.camera.position,
                projection,
                view_projection,
                [width, height],
                left,
                structural,
                self.current.as_deref() == Some(name.as_str()),
                self.hovered == Some(marker.id),
                self.style == "html",
                !self.visible && !runtime_preview,
            ));
        }
        values.into_boxed_slice()
    }
    /// HTML occlusion rays: [id, origin(3), direction(3), maximum distance].
    /// Three reports the nearest native hit; Rust owns its visibility meaning.
    pub fn occlusion_queries(&mut self) -> Box<[f32]> {
        if self.disposed || !self.loaded || !self.visible || self.style != "html" {
            return Box::new([]);
        }
        let Some(model) = self.model.as_ref() else {
            return Box::new([]);
        };
        let mut values = Vec::new();
        for marker in &mut self.markers {
            if self.runtime_names.contains(text(&marker.region, "name")) {
                marker.occluded = false;
                continue;
            }
            if !marker.ready || !marker.anchor_resolved {
                continue;
            }
            marker.observe_anchor(model);
            let delta = sub3(marker.start, self.camera.position);
            let distance = distance3(marker.start, self.camera.position);
            let tolerance =
                number(&marker.style, "markerRadius", 0.008) * model.bounds.size()[1] / 1.8 * 2.;
            values.push(marker.id as f32);
            values.extend_from_slice(&self.camera.position);
            values.extend_from_slice(&normalize3(delta));
            values.push((distance - tolerance).max(0.));
            marker.occluded = false;
        }
        values.into_boxed_slice()
    }
    /// Native hit observations are [marker id, nearest distance], with infinity for no hit.
    pub fn observe_occlusion(&mut self, hits: &[f32]) {
        if self.disposed {
            return;
        }
        for hit in hits.chunks_exact(2) {
            if let Some(marker) = self.markers.iter_mut().find(|m| m.id == hit[0] as u32) {
                marker.occluded = hit[1].is_finite() && hit[1] >= 0.;
            }
        }
    }
    /// Plans contain native ray queries, never native handles. Every result is
    /// tied to this generation; a stale query cannot resurrect cleared markers.
    pub fn plan_markers(&mut self, morph_anchors_json: &str) -> Result<String, JsError> {
        let anchors = parse(morph_anchors_json).map_err(error)?;
        let mut previous = std::mem::take(&mut self.markers)
            .into_iter()
            .map(|m| (text(&m.region, "name").to_owned(), m))
            .collect::<BTreeMap<_, _>>();
        if self.disposed {
            return Ok("[]".into());
        }
        let Some(model) = self.model.as_ref() else {
            return Ok("[]".into());
        };
        let left = self.left_side;
        for region in &self.regions {
            let name = text(region, "name").to_owned();
            let animated_anchor = self.morph_anchor(&name);
            let id = *self.ids.entry(name.clone()).or_insert_with(|| {
                let id = self.next_id;
                self.next_id += 1;
                id
            });
            if let Some(mut marker) = previous.remove(&name) {
                if marker.region == *region && marker.ready {
                    marker.animated_anchor = animated_anchor;
                    marker.observe_anchor(model);
                    self.markers.push(marker);
                    continue;
                }
            }
            if let Some(mut marker) = Marker::new(
                id,
                region.clone(),
                model,
                &self.config,
                left,
                self.camera.position,
                animated_anchor.or_else(|| point(&anchors[&name])),
            ) {
                marker.animated_anchor = animated_anchor;
                self.markers.push(marker)
            }
        }
        self.loaded = true;
        self.descriptor_revision += 1;
        self.revision += 1;
        Ok(Value::Array(
            self.markers
                .iter()
                .filter(|m| m.project && !m.ready)
                .map(|m| m.query(0, model, self.generation))
                .collect(),
        )
        .to_string())
    }
    pub fn surface_result(&mut self, generation: u32, id: u32, phase: u32, hits: &[f32]) -> String {
        if !self.is_current(generation) {
            return "null".into();
        }
        let Some(model) = self.model.as_ref() else {
            return "null".into();
        };
        let points = hits
            .chunks_exact(3)
            .filter(|p| p.iter().all(|v| v.is_finite()))
            .map(|p| [p[0], p[1], p[2]])
            .collect::<Vec<_>>();
        self.markers
            .iter_mut()
            .find(|m| m.id == id)
            .map(|m| m.commit_hits(phase, &points, model, generation).to_string())
            .unwrap_or_else(|| "null".into())
    }
    pub fn finish_markers(&mut self, generation: u32) {
        if !self.is_current(generation) {
            return;
        }
        let Some(model) = self.model.as_ref() else {
            return;
        };
        let runtime_preview = self.has_runtime_preview();
        let indices = self.markers.iter().enumerate()
            .filter(|(_, marker)| {
                text(&marker.style, "lineDirection") == "radial"
                    && (!runtime_preview || self.runtime_names.contains(text(&marker.region, "name")))
            })
            .map(|(index, _)| index)
            .collect::<Vec<_>>();
        let starts = indices.iter().flat_map(|index| self.markers[*index].start).collect::<Vec<_>>();
        let ends = indices.iter().flat_map(|index| {
            let marker = &self.markers[*index];
            add_scaled3(marker.start, marker.direction, marker.length)
        }).collect::<Vec<_>>();
        let adjusted = crate::annotation_markers::separate_overlapping_marker_endpoints(
            &starts,
            &ends,
            &model.bounds.center(),
            model.bounds.size()[1],
        );
        for (index, end) in indices.into_iter().zip(adjusted.chunks_exact(3)) {
            let marker = &mut self.markers[index];
            marker.direction = normalize3(sub3([end[0], end[1], end[2]], marker.start))
        }
    }
    pub fn label_metrics(&mut self, id: u32, width: f32, height: f32) {
        if width.is_finite() && height.is_finite() && height > 0. {
            if let Some(m) = self.markers.iter_mut().find(|m| m.id == id) {
                m.label_aspect = width / height
            }
        }
    }
    pub fn dispose(&mut self) {
        if !self.disposed {
            self.invalidate();
            self.disposed = true;
            self.markers.clear();
            self.regions.clear();
            self.model = None;
            self.config = Value::Null;
            self.config_revision = self.config_revision.wrapping_add(1);
        }
    }
}

impl AnnotationRuntime {
    fn create(settings: Value) -> Result<Self, String> {
        if !settings.is_object() {
            return Err("Annotation settings must be an object".into());
        }
        validate_settings(&settings)?;
        Ok(Self {
            config: json!({}),
            settings,
            model: None,
            regions: Vec::new(),
            markers: Vec::new(),
            morph_anchors: BTreeMap::new(),
            morph_geometry_revisions: BTreeMap::new(),
            next_morph_anchor_id: 0,
            current: None,
            solo: None,
            hovered: None,
            expanded: BTreeMap::new(),
            runtime_names: BTreeSet::new(),
            ids: BTreeMap::new(),
            next_id: 1,
            visible: false,
            style: "3d".into(),
            disposed: false,
            generation: 0,
            revision: 0,
            config_revision: 0,
            descriptor_revision: 0,
            loaded: false,
            camera: camera::Camera::default(),
            last_distance: None,
            left_side: -1.,
        })
    }
    fn invalidate(&mut self) {
        self.clear_morph_anchors();
        self.generation = self.generation.wrapping_add(1);
        self.revision = self.revision.wrapping_add(1);
        self.camera.cancel();
    }
    fn changed_regions(&mut self) {
        self.clear_morph_anchors();
        self.left_side = self
            .model
            .as_ref()
            .map(|model| model.laterality(&self.regions, &self.config).0)
            .unwrap_or(-1.);
        self.generation = self.generation.wrapping_add(1);
        self.revision += 1;
        self.config_revision = self.config_revision.wrapping_add(1);
        self.config["regions"] = json!(self.regions)
    }
    fn clear_morph_anchors(&mut self) {
        self.morph_anchors.clear();
        self.morph_geometry_revisions.clear();
        self.next_morph_anchor_id = 0;
        for marker in &mut self.markers {
            marker.animated_anchor = None;
            marker.anchor_resolved = true;
        }
    }
    fn morph_anchor(&self, name: &str) -> Option<Point> {
        // Geometry replacement changes plan IDs, never configured mesh precedence.
        let region = self
            .regions
            .iter()
            .find(|region| text(region, "name") == name)?;
        self.morph_objects(region)
            .into_iter()
            .rev()
            .find_map(|object_id| {
                self.morph_anchors
                    .values()
                    .rev()
                    .find(|plan| {
                        plan.object_id == object_id && plan.region == name && plan.position.is_some()
                    })
                    .and_then(|plan| plan.position)
            })
    }
    fn refresh_morph_anchor(&mut self, name: &str) {
        let position = self.morph_anchor(name);
        if let Some(marker) = self
            .markers
            .iter_mut()
            .find(|m| text(&m.region, "name") == name)
        {
            marker.animated_anchor = position;
            marker.anchor_resolved = position.is_some();
            if let Some(position) = position {
                marker.start = position;
            }
        }
    }
    fn morph_objects(&self, region: &Value) -> Vec<u32> {
        let Some(model) = &self.model else {
            return Vec::new();
        };
        let names = strings(&region["runtimeAnnotation"]["morphNames"]);
        let resolved = anchor_region(region);
        let anchor = &resolved["region"];
        if names.is_empty()
            || point(&anchor["customPosition"]).is_some()
            || strings(&anchor["objects"]).iter().any(|name| name == "*")
        {
            return Vec::new();
        }
        model
            .resolve(anchor, &self.config)
            .into_iter()
            .filter(|id| {
                model.object(*id).is_some_and(|object| {
                    object.kind == "Mesh"
                        && names.iter().any(|name| object.morph_names.contains(name))
                })
            })
            .collect()
    }
    fn snapshot_value(&self) -> Value {
        let descriptors = self
            .model
            .as_ref()
            .map(|model| {
                self.markers
                    .iter()
                    .map(|m| {
                        let mut descriptor = m.descriptor(
                            model,
                            self.expanded
                                .get(text(&m.region, "name"))
                                .copied()
                                .unwrap_or(false),
                            self.regions
                                .iter()
                                .position(|r| r["name"] == m.region["name"])
                                .unwrap_or(0)
                                + 1,
                        );
                        descriptor["runtimePreview"] = json!(self.runtime_names.contains(text(&m.region, "name")));
                        descriptor
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        json!({"generation":self.generation,"revision":self.revision,"configRevision":self.config_revision,"descriptorRevision":self.descriptor_revision,"disposed":self.disposed,"loaded":self.loaded,"visible":self.visible,"style":self.style,"currentRegion":self.current,"solo":self.solo,"regions":self.regions,"config":self.config,"descriptors":descriptors,"camera":{"position":self.camera.position,"target":self.camera.target},"expanded":self.regions.iter().filter(|r|!strings(&r["children"]).is_empty()).map(|r|json!({"regionName":r["name"],"isExpanded":self.expanded.get(text(r,"name")).copied().unwrap_or(false),"children":r["children"]})).collect::<Vec<_>>()})
    }
    fn upsert(&mut self, name: &str, patch: &Value) -> Result<(), String> {
        if !patch.is_object() {
            return Err("Annotation update must be an object".into());
        }
        let mut regions = self.regions.clone();
        if let Some(r) = regions.iter_mut().find(|r| text(r, "name") == name) {
            patch_region(r, patch);
            r["name"] = json!(name)
        } else {
            let mut r = patch.clone();
            r["name"] = json!(name);
            regions.push(r)
        }
        validate_regions(&regions)?;
        self.regions = regions;
        self.changed_regions();
        Ok(())
    }
    fn remove(&mut self, name: &str) {
        self.regions.retain(|r| text(r, "name") != name);
        self.markers.retain(|m| text(&m.region, "name") != name);
        self.expanded.remove(name);
        self.runtime_names.remove(name);
        if self.current.as_deref() == Some(name) {
            self.current = None
        }
        if self.solo.as_deref() == Some(name) {
            self.solo = None
        }
        self.changed_regions();
        self.descriptor_revision += 1
    }
    fn has_runtime_preview(&self) -> bool {
        !self.runtime_names.is_empty()
    }
    fn execute(&mut self, op: &str, p: Value, now: f64) -> Result<Value, String> {
        if !now.is_finite() {
            return Err("Annotation time must be finite milliseconds".into());
        }
        if self.disposed {
            return Err("Annotation runtime is disposed".into());
        }
        let name = text(&p, "name").to_owned();
        let result = match op {
            "beginLoad" => {
                self.invalidate();
                json!(self.generation)
            }
            "configure" => {
                if let Some(expected) = p["generation"].as_u64() {
                    if expected as u32 != self.generation {
                        return Ok(json!(false));
                    }
                }
                let mut config = p["config"].clone();
                if !config.is_object() {
                    return Err("Annotation config must be an object".into());
                }
                let regions = config["regions"]
                    .as_array()
                    .or_else(|| config["annotationRegions"].as_array())
                    .cloned()
                    .unwrap_or_default();
                validate_regions(&regions)?;
                if let Some(style) = config["markerStyle"].as_str() {
                    if !["3d", "html"].contains(&style) {
                        return Err("Unknown marker style".into());
                    }
                }
                let mut defaults = self.settings["markerDefaults"].clone();
                if !defaults.is_object() {
                    defaults = json!({});
                }
                merge(&mut defaults, &config["markerDefaults"]);
                config["markerDefaults"] = defaults;
                self.invalidate();
                self.config = config;
                self.regions = regions;
                self.runtime_names.clear();
                self.expanded.clear();
                self.solo = None;
                self.hovered = None;
                self.current = None;
                if let Some(style) = self.config["markerStyle"].as_str() {
                    self.style = style.to_owned()
                }
                self.markers.clear();
                self.loaded = false;
                self.changed_regions();
                self.descriptor_revision += 1;
                json!(true)
            }
            "clear" | "clearModel" => {
                self.invalidate();
                if op == "clearModel" {
                    self.model = None;
                    self.ids.clear();
                    self.next_id = 1;
                }
                self.regions.clear();
                self.runtime_names.clear();
                self.expanded.clear();
                self.current = None;
                self.solo = None;
                self.hovered = None;
                self.markers.clear();
                self.loaded = false;
                self.config = json!({});
                self.config_revision = self.config_revision.wrapping_add(1);
                self.descriptor_revision += 1;
                Value::Null
            }
            "settings" => {
                let mut settings = self.settings.clone();
                merge(&mut settings, &p);
                validate_settings(&settings)?;
                self.settings = settings;
                if let Some(enabled) = p["enabled"].as_bool() {
                    self.camera.enabled = enabled;
                    if !enabled {
                        self.camera.cancel()
                    }
                }
                Value::Null
            }
            "controls" => {
                return Ok(
                    json!({"enabled":self.camera.enabled,"enableDamping":self.settings["enableDamping"].as_bool().unwrap_or(true),"dampingFactor":number(&self.settings,"dampingFactor",0.05),"minDistance":number(&self.settings,"minDistance",0.5),"maxDistance":number(&self.settings,"maxDistance",10.)}),
                )
            }
            "input" => {
                self.camera.input(&p);
                Value::Null
            }
            "setCamera" => {
                let position = point(&p["position"]).ok_or("Camera position must be finite")?;
                let target = point(&p["target"]).ok_or("Camera target must be finite")?;
                self.camera.set_pose(position, target);
                Value::Null
            }
            "animateCamera" => {
                let position = point(&p["position"]).ok_or("Camera position must be finite")?;
                let target = point(&p["target"]).ok_or("Camera target must be finite")?;
                json!(self.camera.start(
                    position,
                    target,
                    number(
                        &p,
                        "duration",
                        number(&self.settings, "transitionDuration", 800.)
                    ),
                    now
                ))
            }
            "focus" => {
                let region = if p["region"].is_object() {
                    p["region"].clone()
                } else {
                    self.regions
                        .iter()
                        .find(|r| text(r, "name") == name)
                        .cloned()
                        .unwrap_or(Value::Null)
                };
                if region.is_null() {
                    return Ok(Value::Null);
                }
                let Some(model) = self.model.as_ref() else {
                    return Ok(Value::Null);
                };
                let left = self.left_side;
                let Some((position, target)) =
                    self.camera
                        .focus_pose(model, &region, &self.config, &self.settings, left)
                else {
                    return Ok(Value::Null);
                };
                if !name.is_empty() {
                    self.current = Some(name)
                }
                json!(self.camera.start(
                    position,
                    target,
                    number(
                        &p,
                        "duration",
                        number(&self.settings, "transitionDuration", 800.)
                    ),
                    now
                ))
            }
            "intro" => {
                let Some(model) = self.model.as_ref() else {
                    return Ok(Value::Null);
                };
                let left = self.left_side;
                json!(self.camera.intro(
                    model,
                    &self.regions,
                    &self.config,
                    &self.settings,
                    left,
                    number(&p, "orbitDuration", 3000.),
                    number(&p, "zoomDuration", 1500.),
                    now
                ))
            }
            "startConfigured" => {
                if self.config["playIntroOnLoad"] == true {
                    return self.execute("intro", json!({}), now);
                }
                let name = text(&self.config, "defaultRegion").to_owned();
                if !name.is_empty() {
                    return self.execute("focus", json!({"name":name,"duration":0}), now);
                }
                Value::Null
            }
            "pick" => {
                let picked = p["ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_u64)
                    .find_map(|id| {
                        self.markers
                            .iter()
                            .find(|m| {
                                m.id == id as u32 && m.current_visibility
                                    && (self.visible || self.runtime_names.contains(text(&m.region, "name")))
                            })
                    })
                    .map(|m| m.region.clone());
                if let Some(region) = picked {
                    if !strings(&region["children"]).is_empty() {
                        let animation = region["expandAnimation"].as_str().unwrap_or("staggered");
                        self.execute(
                            "toggle",
                            json!({"name":region["name"], "animation":animation}),
                            now,
                        )?;
                    }
                    region["name"].clone()
                } else {
                    Value::Null
                }
            }
            "select" => {
                self.current = p["name"].as_str().map(str::to_owned);
                Value::Null
            }
            "visibility" => {
                self.visible = p["visible"]
                    .as_bool()
                    .ok_or("Marker visibility must be boolean")?;
                Value::Null
            }
            "style" => {
                let style = text(&p, "style");
                if !["3d", "html"].contains(&style) {
                    return Err("Unknown marker style".into());
                }
                self.style = style.to_owned();
                self.descriptor_revision += 1;
                Value::Null
            }
            "hover" => {
                self.hovered = p["id"].as_u64().map(|id| id as u32);
                Value::Null
            }
            "solo" => {
                self.solo = p["name"].as_str().map(str::to_owned);
                Value::Null
            }
            "expand" | "collapse" | "toggle" => {
                let expand = if op == "toggle" {
                    !self.expanded.get(&name).copied().unwrap_or(false)
                } else {
                    op == "expand"
                };
                let children = self
                    .regions
                    .iter()
                    .find(|r| text(r, "name") == name)
                    .map(|r| strings(&r["children"]))
                    .unwrap_or_default();
                if children.is_empty()
                    || self.expanded.get(&name).copied().unwrap_or(false) == expand
                {
                    return Ok(Value::Null);
                }
                self.expanded.insert(name.clone(), expand);
                self.descriptor_revision += 1;
                let default_duration = if self.style == "html" { 400. } else { 220. };
                let duration = number(&p, "duration", default_duration)
                    * if op == "toggle" && !expand { 0.75 } else { 1. };
                for (index, child) in children.iter().enumerate() {
                    if let Some(marker) = self
                        .markers
                        .iter_mut()
                        .find(|m| text(&m.region, "name") == child)
                    {
                        marker.current_visibility = expand;
                        marker.transition = Some((
                            expand,
                            now + if text(&p, "animation") == "staggered" {
                                index as f64 * 50.
                            } else {
                                0.
                            },
                            duration.max(1.),
                        ))
                    }
                }
                Value::Null
            }
            "updateRegion" => {
                self.upsert(&name, &p["update"])?;
                Value::Null
            }
            "removeRegion" => {
                self.remove(&name);
                Value::Null
            }
            "markerPosition" => self
                .markers
                .iter()
                .find(|m| text(&m.region, "name") == name && m.anchor_resolved)
                .map(|m| point_json(m.start))
                .unwrap_or(Value::Null),
            "runtimeBone" | "runtimeAU" | "runtimeMorph" => {
                let target = p["target"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| p["target"].to_string());
                let target = target.trim();
                if target.is_empty() || target == "null" {
                    return Err("Annotation target is required".into());
                }
                let options = &p["options"];
                let generated = if op == "runtimeAU" {
                    targets::au_regions(&self.config, &p["profile"], target, &p["meshes"], options)?
                } else if op == "runtimeMorph" {
                    let mesh = text(&p, "mesh").trim();
                    let mapped = self.model.as_ref().is_some_and(|model| {
                        model.objects.iter().any(|object| {
                            object.kind == "Mesh" && object.name == mesh
                                && object.morph_names.iter().any(|name| name == target)
                        })
                    });
                    if !mapped {
                        return Err(format!("Morph {target} is not available on mesh {mesh}"));
                    }
                    vec![targets::make_region(
                        "morph", target, None, Some(mesh), &[target.to_owned()],
                        options["targetSide"].as_str().or_else(|| side(target)), options,
                    )]
                } else {
                    vec![targets::make_region(
                        "bone",
                        target,
                        Some(target),
                        None,
                        &[],
                        options["targetSide"].as_str(),
                        options,
                    )]
                };
                if op == "runtimeBone" {
                    let resolved = anchor_region(&generated[0]);
                    if !self.model.as_ref().is_some_and(|model| {
                        !model.resolve(&resolved["region"], &self.config).is_empty()
                    }) {
                        return Err(format!("Bone {target} is not available on the loaded model"));
                    }
                }
                let target_type = match op {
                    "runtimeAU" => "au",
                    "runtimeMorph" => "morph",
                    _ => "bone",
                };
                let wanted = generated
                    .iter()
                    .map(|r| text(r, "name").to_owned())
                    .collect::<BTreeSet<_>>();
                let removed = self
                    .regions
                    .iter()
                    .filter(|r| {
                        self.runtime_names.contains(text(r, "name"))
                            && !wanted.contains(text(r, "name"))
                            && (options["replaceExisting"] != false
                                || (!options["targetSide"].is_null()
                                    && text(&r["runtimeAnnotation"], "target") == target
                                    && text(&r["runtimeAnnotation"], "targetType") == target_type))
                    })
                    .map(|r| text(r, "name").to_owned())
                    .collect::<BTreeSet<_>>();
                let mut regions = self
                    .regions
                    .iter()
                    .filter(|r| !removed.contains(text(r, "name")))
                    .cloned()
                    .collect::<Vec<_>>();
                for region in &generated {
                    if let Some(existing) = regions.iter_mut().find(|r| r["name"] == region["name"])
                    {
                        *existing = region.clone();
                    } else {
                        regions.push(region.clone());
                    }
                }
                validate_regions(&regions)?;
                if self.regions != regions {
                    self.regions = regions;
                    self.markers
                        .retain(|m| !removed.contains(text(&m.region, "name")));
                    self.runtime_names.retain(|name| !removed.contains(name));
                    self.expanded.retain(|name, _| !removed.contains(name));
                    if self
                        .current
                        .as_ref()
                        .is_some_and(|name| removed.contains(name))
                    {
                        self.current = None;
                    }
                    if self
                        .solo
                        .as_ref()
                        .is_some_and(|name| removed.contains(name))
                    {
                        self.solo = None;
                    }
                    self.changed_regions();
                    self.descriptor_revision += 1;
                }
                self.runtime_names.extend(wanted);
                if op != "runtimeAU" {
                    targets::summary(&generated[0])
                } else {
                    Value::Array(generated.iter().map(targets::summary).collect())
                }
            }
            "clearRuntime" => {
                let names = self.runtime_names.iter().cloned().collect::<Vec<_>>();
                for name in &names {
                    self.remove(name)
                }
                json!(names)
            }
            "morphRequests" => {
                let mut requests = Vec::new();
                for region in &self.regions {
                    for id in self.morph_objects(region) {
                        requests.push(json!({"objectId": id, "region": region,
                            "morphNames": region["runtimeAnnotation"]["morphNames"]}));
                    }
                }
                json!(requests)
            }
            "focusObjects" => {
                let Some(model) = self.model.as_ref() else {
                    return Ok(json!([]));
                };
                let intro = p["intro"] == true
                    || (p["configured"] == true && self.config["playIntroOnLoad"] == true);
                let region = if intro {
                    camera::intro_region(&self.regions)
                        .cloned()
                        .unwrap_or(json!({}))
                } else if p["region"].is_object() {
                    p["region"].clone()
                } else {
                    let name = if p["configured"] == true {
                        text(&self.config, "defaultRegion")
                    } else {
                        &name
                    };
                    self.regions
                        .iter()
                        .find(|r| text(r, "name") == name)
                        .cloned()
                        .unwrap_or(json!({}))
                };
                json!(model.resolve(&camera::focus_region(&region), &self.config))
            }
            _ => return Err(format!("Unknown annotation operation {op}")),
        };
        // Camera gestures advance through the packed frame API. Queries and
        // gestures must not force consumers to rebuild the full region snapshot.
        if !matches!(op, "input" | "markerPosition" | "morphRequests" | "focusObjects") {
            self.revision += 1;
        }
        Ok(result)
    }
}

#[wasm_bindgen]
pub fn annotation_marker_frame_stride() -> u32 {
    markers::FRAME_STRIDE as u32
}
