use super::geometry::*;
use crate::annotation_camera::{
    self as math, add_scaled3, distance3, normalize3, sub3, CameraFlight, CameraOrbit,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;

enum Motion {
    Flight(CameraFlight),
    Intro {
        orbit: CameraOrbit,
        end: Point,
        target: Point,
        zoom: f32,
        landing: Option<CameraFlight>,
        region: Option<String>,
    },
}
pub struct Camera {
    pub position: Point,
    pub target: Point,
    pub enabled: bool,
    pub generation: u32,
    pub finished: u32,
    pub fov: f32,
    pub aspect: f32,
    pub width: f32,
    pub height: f32,
    motion: Option<Motion>,
    started: f64,
    previous_time: Option<f64>,
    pointers: BTreeMap<i32, (f32, f32, i32, bool)>,
    angular: [f32; 2],
    pan: [f32; 2],
    zoom: f32,
}
impl Default for Camera {
    fn default() -> Self {
        Self {
            position: [0., 1., 3.],
            target: [0., 1., 0.],
            enabled: true,
            generation: 0,
            finished: 0,
            fov: 45.,
            aspect: 1.,
            width: 1.,
            height: 1.,
            motion: None,
            started: 0.,
            previous_time: None,
            pointers: BTreeMap::new(),
            angular: [0., 0.],
            pan: [0., 0.],
            zoom: 1.,
        }
    }
}
impl Camera {
    pub fn cancel(&mut self) {
        self.motion = None;
        self.finished = self.generation;
        self.angular = [0., 0.];
        self.pan = [0., 0.];
        self.zoom = 1.;
    }
    pub fn set_pose(&mut self, position: Point, target: Point) {
        self.cancel();
        self.position = position;
        self.target = target;
    }
    pub fn moving(&self) -> bool {
        self.motion.is_some()
            || self.angular.iter().chain(&self.pan).any(|v| v.abs() > 1e-7)
            || (self.zoom - 1.).abs() > 1e-7
    }
    pub fn start(&mut self, position: Point, target: Point, duration: f32, now: f64) -> u32 {
        self.cancel();
        self.generation = self.generation.wrapping_add(1);
        self.started = now;
        self.motion = Some(Motion::Flight(CameraFlight::new(
            &self.position,
            &self.target,
            &position,
            &target,
            duration.max(0.),
        )));
        self.sample(now, &json!({}));
        self.generation
    }
    pub fn intro(
        &mut self,
        model: &Model,
        regions: &[Value],
        config: &Value,
        settings: &Value,
        left: f32,
        orbit_ms: f32,
        zoom_ms: f32,
        now: f64,
    ) -> u32 {
        let eye = intro_region(regions);
        let mut landing = eye.and_then(|r| {
            let mut r = r.clone();
            r["paddingFactor"] = json!((number(
                &r,
                "paddingFactor",
                number(settings, "closeUpPaddingFactor", 1.2)
            ) * 0.72)
                .min(0.85));
            self.focus_pose(model, &r, config, settings, left)
                .map(|(mut pos, mut target)| {
                    let bias = (model.bounds.size()[1] * 0.025).max(0.025);
                    pos[1] -= bias;
                    target[1] -= bias;
                    (pos, target, Some(text(&r, "name").to_owned()))
                })
        });
        if landing.is_none() {
            let full = regions.iter().find(|r| is_full_body(r));
            let mut r = full.cloned().unwrap_or_else(|| json!({"objects":["*"]}));
            r["cameraAngle"] = json!(-30.);
            r["worldAngle"] = json!(true);
            landing = self
                .focus_pose(model, &r, config, settings, left)
                .map(|(pos, target)| (pos, target, full.map(|r| text(r, "name").to_owned())));
        }
        let (end, target, region) = landing.unwrap_or(([0., 0.8, 2.5], [0., 0.8, 0.], None));
        self.cancel();
        self.generation = self.generation.wrapping_add(1);
        self.started = now;
        let size = model.bounds.size();
        let center = model.bounds.center();
        self.motion = Some(Motion::Intro {
            orbit: CameraOrbit::new(
                &center,
                size.into_iter().fold(0., f32::max) * 1.8,
                center[1],
                orbit_ms.max(0.),
            ),
            end,
            target,
            zoom: zoom_ms.max(0.),
            landing: None,
            region,
        });
        self.generation
    }
    pub fn sample(&mut self, now: f64, settings: &Value) -> Option<String> {
        let elapsed = (now - self.started).max(0.) as f32;
        let mut completed = false;
        let mut selected = None;
        if let Some(motion) = self.motion.as_mut() {
            let values = match motion {
                Motion::Flight(flight) => flight.sample(elapsed),
                Motion::Intro {
                    orbit,
                    end,
                    target,
                    zoom,
                    landing,
                    region,
                } => {
                    if elapsed < orbit.duration_ms() {
                        orbit.sample(elapsed)
                    } else {
                        let flight = landing.get_or_insert_with(|| {
                            let last = orbit.sample(orbit.duration_ms());
                            CameraFlight::new(&last[..3], &last[3..6], end, target, *zoom)
                        });
                        let v = flight.sample(elapsed - orbit.duration_ms());
                        if v[6] >= 1. {
                            selected = region.clone()
                        }
                        v
                    }
                }
            };
            self.position.copy_from_slice(&values[..3]);
            self.target.copy_from_slice(&values[3..6]);
            completed = values[6] >= 1.;
            // An intro orbit's final sample starts its landing, not completion.
            if let Motion::Intro { orbit, .. } = motion {
                if elapsed < orbit.duration_ms() {
                    completed = false
                }
            }
        } else {
            self.integrate(now, settings)
        }
        if completed {
            self.motion = None;
            self.finished = self.generation
        }
        self.previous_time = Some(now);
        selected
    }
    fn integrate(&mut self, now: f64, settings: &Value) {
        if !self.moving() {
            return;
        }
        let delta = sub3(self.position, self.target);
        let mut radius = distance3(self.position, self.target).max(1e-6);
        let mut theta = delta[0].atan2(delta[2]);
        let mut phi = (delta[1] / radius).clamp(-1., 1.).acos();
        let dt = self
            .previous_time
            .map(|t| ((now - t) / 1000.).clamp(0., 0.1) as f32)
            .unwrap_or(1. / 60.);
        let damping = if settings["enableDamping"].as_bool().unwrap_or(true) {
            1. - (1. - number(settings, "dampingFactor", 0.05).clamp(0., 1.)).powf(dt * 60.)
        } else {
            1.
        };
        theta -= self.angular[0] * damping;
        phi = (phi - self.angular[1] * damping).clamp(1e-5, std::f32::consts::PI - 1e-5);
        let right = [theta.cos(), 0., -theta.sin()];
        let up = [
            -phi.cos() * theta.sin(),
            phi.sin(),
            -phi.cos() * theta.cos(),
        ];
        let pan_scale = 2. * radius * (self.fov.to_radians() * 0.5).tan() / self.height.max(1.);
        self.target = add_scaled3(self.target, right, -self.pan[0] * pan_scale * damping);
        self.target = add_scaled3(self.target, up, self.pan[1] * pan_scale * damping);
        radius = (radius * self.zoom).clamp(
            number(settings, "minDistance", 0.5).max(1e-6),
            number(settings, "maxDistance", 10.)
                .max(number(settings, "minDistance", 0.5).max(1e-6)),
        );
        self.position = add_scaled3(
            self.target,
            [phi.sin() * theta.sin(), phi.cos(), phi.sin() * theta.cos()],
            radius,
        );
        for v in self.angular.iter_mut().chain(&mut self.pan) {
            *v *= 1. - damping;
            if v.abs() < 1e-7 {
                *v = 0.
            }
        }
        self.zoom = 1.;
    }
    pub fn input(&mut self, event: &Value) {
        let kind = text(event, "kind");
        if kind == "disconnect" {
            self.pointers.clear();
            return;
        }
        let id = number(event, "id", 0.) as i32;
        if kind == "up" || kind == "cancel" {
            self.pointers.remove(&id);
            return;
        }
        if !self.enabled {
            self.pointers.clear();
            return;
        }
        self.width = number(event, "width", self.width).max(1.);
        self.height = number(event, "height", self.height).max(1.);
        if kind == "wheel" {
            self.cancel();
            let unit = match number(event, "deltaMode", 0.) as u32 {
                1 => 16.,
                2 => self.height,
                _ => 1.,
            };
            self.zoom = (number(event, "deltaY", 0.) * unit * 0.001)
                .clamp(-2., 2.)
                .exp();
            return;
        }
        let x = number(event, "x", 0.);
        let y = number(event, "y", 0.);
        let button = number(event, "button", 0.) as i32;
        let modifier = event["modifier"].as_bool().unwrap_or(false);
        if kind == "down" {
            self.cancel();
            self.pointers.insert(id, (x, y, button, modifier));
            return;
        }
        if kind != "move" {
            return;
        }
        let Some((old_x, old_y, button, modifier)) = self.pointers.get(&id).copied() else {
            return;
        };
        let dx = x - old_x;
        let dy = y - old_y;
        if self.pointers.len() >= 2 {
            if let Some((_, other)) = self.pointers.iter().find(|(other, _)| **other != id) {
                let before = ((old_x - other.0).powi(2) + (old_y - other.1).powi(2)).sqrt();
                let after = ((x - other.0).powi(2) + (y - other.1).powi(2)).sqrt();
                if before > 1. && after > 1. {
                    self.zoom *= before / after
                }
                self.pan[0] += dx * 0.5;
                self.pan[1] += dy * 0.5;
            }
        } else if button == 2 || modifier {
            self.pan[0] += dx;
            self.pan[1] += dy
        } else if button == 1 {
            self.zoom *= (dy * 0.01).clamp(-2., 2.).exp()
        } else {
            self.angular[0] += 2. * std::f32::consts::PI * dx / self.height;
            self.angular[1] += 2. * std::f32::consts::PI * dy / self.height
        }
        self.pointers.insert(id, (x, y, button, modifier));
    }
    pub fn focus_pose(
        &self,
        model: &Model,
        region: &Value,
        config: &Value,
        settings: &Value,
        left: f32,
    ) -> Option<(Point, Point)> {
        let target = &region["focusTarget"];
        let kind = text(target, "type");
        let angle = target["cameraAngle"]
            .as_f64()
            .map(|n| n as f32)
            .or_else(|| camera_angle(region, left, false));
        let padding = target["paddingFactor"]
            .as_f64()
            .or_else(|| region["paddingFactor"].as_f64())
            .map(|n| n as f32);
        let min = number(settings, "minDistance", 0.5);
        let close = number(settings, "closeUpPaddingFactor", 1.2);
        let zoom = number(settings, "zoomPaddingFactor", 1.5);
        let full = number(settings, "fullBodyPaddingFactor", 2.);
        let values = if (kind.is_empty() || kind == "region") && is_full_body(region) {
            math::solve_full_body_framing(
                &model.bounds.min,
                &model.bounds.max,
                &model.quaternion,
                self.fov,
                self.aspect,
                min,
                full,
                padding,
                angle,
                region["worldAngle"].as_bool().unwrap_or(false),
            )
        } else {
            let selected = focus_region(region);
            let position = if kind == "point" {
                point(&target["position"])
            } else if kind == "face-center" {
                Some(model.face(&selected, config).0)
            } else {
                None
            };
            let bounds = if let Some(position) = position {
                let extent =
                    (model.bounds.size().into_iter().fold(0., f32::max) * 0.04).max(0.02) * 0.5;
                Some(Bounds {
                    min: position.map(|v| v - extent),
                    max: position.map(|v| v + extent),
                })
            } else {
                let mut bounds: Option<Bounds> = None;
                for id in model.resolve(&selected, config) {
                    if let Some(o) = model.object(id) {
                        let b = o.bounds.unwrap_or_else(|| Bounds::at(o.position));
                        if let Some(all) = bounds.as_mut() {
                            all.union(b)
                        } else {
                            bounds = Some(b)
                        }
                    }
                }
                bounds
            }?;
            let model_bounds = model.bounds.packed();
            math::solve_focus_framing(
                &bounds.packed(),
                if angle == Some(0.) {
                    &[]
                } else {
                    &model_bounds
                },
                &model.quaternion,
                self.fov,
                self.aspect,
                min,
                close,
                zoom,
                full,
                padding,
                angle,
                false,
            )
        };
        let mut position = [values[0], values[1], values[2]];
        for (i, k) in ["x", "y", "z"].iter().enumerate() {
            position[i] += number(&region["cameraOffset"], k, 0.)
        }
        Some((position, [values[3], values[4], values[5]]))
    }
}
pub fn is_full_body(region: &Value) -> bool {
    ["full_body", "fullbody"].contains(
        &text(region, "name")
            .trim()
            .to_lowercase()
            .replace(' ', "_")
            .as_str(),
    ) || strings(&region["objects"]).iter().any(|s| s == "*")
}

/// Resolve explicit focus fields independently of marker-anchor fields.
pub fn focus_region(region: &Value) -> Value {
    let target = &region["focusTarget"];
    let kind = text(target, "type");
    if kind.is_empty() || kind == "region" {
        return region.clone();
    }
    let mut selected = json!({});
    for key in match kind {
        "bone" => vec!["bones"],
        "mesh" => vec!["meshes"],
        "object" => vec!["objects"],
        "face-center" => vec!["bones", "meshes", "objects"],
        _ => vec![],
    } {
        selected[key] = if target[key].is_null() {
            region[key].clone()
        } else {
            target[key].clone()
        };
    }
    selected
}

pub fn intro_region(regions: &[Value]) -> Option<&Value> {
    regions.iter().find(|region| {
        let name = text(region, "name").to_lowercase();
        has(&name, "left_eye|lefteye|eye_l|l_eye")
            || (name.contains("left") && name.contains("eye"))
    })
}
