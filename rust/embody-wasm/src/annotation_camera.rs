//! DPthree annotation camera core.
//!
//! Rust port of the pure camera math from the DPthree camera controller:
//! region framing, auto closeup angles, camera-angle direction resolution,
//! and the spherical camera flight / orbit animation state machines.
//! Scene-graph concerns (bounding boxes, OrbitControls, render loop) stay in
//! the host; this module only consumes packed floats.

use wasm_bindgen::prelude::*;

pub const ANNOTATION_CAMERA_FRAMING_STRIDE: u32 = 7;
pub const CAMERA_FLIGHT_SAMPLE_STRIDE: u32 = 7;

const FALLBACK_FRAMING: [f32; 7] = [0.0, 0.8, 2.5, 0.0, 0.8, 0.0, 2.5];
const FULL_BODY_HERO_PADDING_CAP: f32 = 1.2;
const FULL_BODY_TARGET_HEIGHT_RATIO: f32 = 0.54;
const ANGLED_VIEW_CLEARANCE: f32 = 0.3;
const MIN_BASE_DISTANCE: f32 = 0.5;
const AUTO_CLOSEUP_MAX_FOCUS_SIZE: f32 = 0.25;
const AUTO_CLOSEUP_MIN_OFFSET: f32 = 0.01;
const AUTO_CLOSEUP_SCALE_FACTOR: f32 = 2.5;

#[wasm_bindgen]
pub fn annotation_camera_framing_stride() -> u32 {
    ANNOTATION_CAMERA_FRAMING_STRIDE
}

#[wasm_bindgen]
pub fn camera_flight_sample_stride() -> u32 {
    CAMERA_FLIGHT_SAMPLE_STRIDE
}

// ====== VECTOR / QUATERNION HELPERS ======

pub(crate) fn read_vec3(values: &[f32], offset: usize) -> [f32; 3] {
    [
        *values.get(offset).unwrap_or(&0.0),
        *values.get(offset + 1).unwrap_or(&0.0),
        *values.get(offset + 2).unwrap_or(&0.0),
    ]
}

pub(crate) fn normalize3(v: [f32; 3]) -> [f32; 3] {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if len <= f32::EPSILON {
        return [0.0, 0.0, 0.0];
    }
    [v[0] / len, v[1] / len, v[2] / len]
}

pub(crate) fn dot3(a: [f32; 3], b: [f32; 3]) -> f32 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

pub(crate) fn sub3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

pub(crate) fn add_scaled3(a: [f32; 3], b: [f32; 3], scale: f32) -> [f32; 3] {
    [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale]
}

pub(crate) fn lerp3(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
        a[2] + (b[2] - a[2]) * t,
    ]
}

pub(crate) fn distance3(a: [f32; 3], b: [f32; 3]) -> f32 {
    let d = sub3(a, b);
    (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt()
}

fn quat_or_identity(values: &[f32]) -> [f32; 4] {
    if values.len() < 4 {
        return [0.0, 0.0, 0.0, 1.0];
    }
    let q = [values[0], values[1], values[2], values[3]];
    let len = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if len <= f32::EPSILON || !len.is_finite() {
        return [0.0, 0.0, 0.0, 1.0];
    }
    [q[0] / len, q[1] / len, q[2] / len, q[3] / len]
}

fn rotate_by_quat(q: [f32; 4], v: [f32; 3]) -> [f32; 3] {
    let [qx, qy, qz, qw] = q;
    // t = 2 * cross(q.xyz, v)
    let tx = 2.0 * (qy * v[2] - qz * v[1]);
    let ty = 2.0 * (qz * v[0] - qx * v[2]);
    let tz = 2.0 * (qx * v[1] - qy * v[0]);
    // v' = v + qw * t + cross(q.xyz, t)
    [
        v[0] + qw * tx + (qy * tz - qz * ty),
        v[1] + qw * ty + (qz * tx - qx * tz),
        v[2] + qw * tz + (qx * ty - qy * tx),
    ]
}

// ====== CAMERA ANGLE MATH ======

pub(crate) fn normalize_camera_angle_value(angle: f32) -> f32 {
    if !angle.is_finite() {
        return 0.0;
    }
    ((angle % 360.0) + 360.0) % 360.0
}

#[wasm_bindgen]
pub fn normalize_camera_angle_degrees(angle: f32) -> f32 {
    normalize_camera_angle_value(angle)
}

fn direction_for_camera_angle(model_quat: &[f32], camera_angle: f32) -> [f32; 3] {
    let rad = normalize_camera_angle_value(camera_angle).to_radians();
    let local = [rad.sin(), 0.0, rad.cos()];
    normalize3(rotate_by_quat(quat_or_identity(model_quat), local))
}

/// World-space camera direction for a model-relative camera angle.
/// `model_quat` is the model's world quaternion `[x, y, z, w]`
/// (pass an empty slice for identity).
#[wasm_bindgen]
pub fn world_direction_for_camera_angle(model_quat: &[f32], camera_angle: f32) -> Box<[f32]> {
    direction_for_camera_angle(model_quat, camera_angle)
        .to_vec()
        .into_boxed_slice()
}

fn resolve_focus_camera_direction_value(
    model_quat: &[f32],
    effective_angle: f32,
    has_explicit_angle: bool,
    world_angle_space: bool,
) -> [f32; 3] {
    if world_angle_space {
        let rad = effective_angle.to_radians();
        return normalize3([rad.sin(), 0.0, rad.cos()]);
    }

    // Preserve the legacy "world front" default for generic/full-body framing.
    // Explicit region angles and auto-angled closeups still follow the model's
    // local orientation.
    if !has_explicit_angle && effective_angle == 0.0 {
        return [0.0, 0.0, 1.0];
    }

    direction_for_camera_angle(model_quat, effective_angle)
}

/// Direction the camera should approach from when focusing a region.
#[wasm_bindgen]
pub fn resolve_focus_camera_direction(
    model_quat: &[f32],
    effective_angle: f32,
    has_explicit_angle: bool,
    world_angle_space: bool,
) -> Box<[f32]> {
    resolve_focus_camera_direction_value(
        model_quat,
        effective_angle,
        has_explicit_angle,
        world_angle_space,
    )
    .to_vec()
    .into_boxed_slice()
}

fn resolve_auto_closeup_angle_value(
    horizontal_offset: f32,
    focus_size: [f32; 3],
    model_size: [f32; 3],
) -> Option<f32> {
    let max_size = focus_size[0].max(focus_size[1]).max(focus_size[2]);
    if max_size >= AUTO_CLOSEUP_MAX_FOCUS_SIZE || horizontal_offset.abs() <= AUTO_CLOSEUP_MIN_OFFSET
    {
        return None;
    }

    // Humanoid eye closeups should depend on front/back model depth, not
    // shoulder width, otherwise wide characters get flattened toward straight-on.
    let mut depth_reference = model_size[2] / 2.0;
    if depth_reference == 0.0 {
        depth_reference = 0.5;
    }
    Some(
        (horizontal_offset * AUTO_CLOSEUP_SCALE_FACTOR)
            .atan2(depth_reference)
            .to_degrees(),
    )
}

/// Auto camera angle for small offset focus targets (eye closeups).
/// Returns `undefined` when no auto angle applies.
#[wasm_bindgen]
pub fn resolve_auto_closeup_angle(
    horizontal_offset: f32,
    focus_size: &[f32],
    model_size: &[f32],
) -> Option<f32> {
    resolve_auto_closeup_angle_value(
        horizontal_offset,
        read_vec3(focus_size, 0),
        read_vec3(model_size, 0),
    )
}

fn padding_factor_for_size(
    size: f32,
    close_up_padding: f32,
    zoom_padding: f32,
    full_body_padding: f32,
) -> f32 {
    // Very small targets (individual eyes) get extra tight framing
    if size < 0.1 {
        return close_up_padding * 0.7;
    }
    // Small targets (eyes, mouth) get tighter framing
    if size < 0.3 {
        return close_up_padding;
    }
    // Full body gets wider framing
    if size > 1.5 {
        return full_body_padding;
    }
    zoom_padding
}

/// Padding factor for a focus target of the given max dimension.
#[wasm_bindgen]
pub fn focus_padding_factor(
    size: f32,
    close_up_padding: f32,
    zoom_padding: f32,
    full_body_padding: f32,
) -> f32 {
    padding_factor_for_size(size, close_up_padding, zoom_padding, full_body_padding)
}

// ====== FRAMING SOLVERS ======

struct FovDistances {
    fov_rad: f32,
    fov_h: f32,
}

fn fov_distances(fov_deg: f32, aspect: f32) -> FovDistances {
    let fov_rad = fov_deg.to_radians();
    let fov_h = 2.0 * ((fov_rad / 2.0).tan() * aspect).atan();
    FovDistances { fov_rad, fov_h }
}

/// Solve the camera framing for a focus target.
///
/// * `focus_bounds` - `[centerX, centerY, centerZ, sizeX, sizeY, sizeZ]` of the focus box.
/// * `model_bounds` - same layout for the whole model, or empty when unavailable.
/// * `model_quat` - model world quaternion `[x, y, z, w]`, or empty for identity.
/// * `camera_angle` - explicit region camera angle (degrees), or `undefined`.
/// * `world_angle_space` - whether `camera_angle` is a world-space angle.
///
/// Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_focus_framing(
    focus_bounds: &[f32],
    model_bounds: &[f32],
    model_quat: &[f32],
    fov_deg: f32,
    aspect: f32,
    min_distance: f32,
    close_up_padding: f32,
    zoom_padding: f32,
    full_body_padding: f32,
    override_padding: Option<f32>,
    camera_angle: Option<f32>,
    world_angle_space: bool,
) -> Box<[f32]> {
    if focus_bounds.len() < 6 {
        return FALLBACK_FRAMING.to_vec().into_boxed_slice();
    }

    let center = read_vec3(focus_bounds, 0);
    let size = read_vec3(focus_bounds, 3);
    let has_model = model_bounds.len() >= 6;
    let model_center = read_vec3(model_bounds, 0);
    let model_size = read_vec3(model_bounds, 3);

    let mut effective_angle = camera_angle.unwrap_or(0.0);
    let mut effective_world_space = world_angle_space;

    // Implicit closeup auto-angles stay in world space so rotated characters
    // still frame eyes from the visible front side.
    if has_model && camera_angle.is_none() {
        let horizontal_offset = center[0] - model_center[0];
        if let Some(auto_angle) =
            resolve_auto_closeup_angle_value(horizontal_offset, size, model_size)
        {
            effective_angle = auto_angle;
            effective_world_space = true;
        }
    }

    let fov = fov_distances(fov_deg, aspect);
    let distance_for_height = if size[1] > 0.0 {
        (size[1] / 2.0) / (fov.fov_rad / 2.0).tan()
    } else {
        1.0
    };
    let distance_for_width = if size[0] > 0.0 {
        (size[0] / 2.0) / (fov.fov_h / 2.0).tan()
    } else {
        1.0
    };
    let base_distance = distance_for_height
        .max(distance_for_width)
        .max(MIN_BASE_DISTANCE);

    let padding = override_padding.unwrap_or_else(|| {
        padding_factor_for_size(
            size[0].max(size[1]).max(size[2]),
            close_up_padding,
            zoom_padding,
            full_body_padding,
        )
    });
    let mut distance = (base_distance * padding).max(min_distance);

    let direction = resolve_focus_camera_direction_value(
        model_quat,
        effective_angle,
        camera_angle.is_some(),
        effective_world_space,
    );

    // For angled views, ensure the camera clears the model body.
    if has_model && effective_angle != 0.0 {
        let model_depth_in_direction = (direction[0].abs() * model_size[0]) / 2.0
            + (direction[2].abs() * model_size[2]) / 2.0;
        let target_to_model_center = sub3(model_center, center);
        let offset_in_camera_dir = dot3(target_to_model_center, direction).abs();
        let min_safe_distance =
            model_depth_in_direction + offset_in_camera_dir + ANGLED_VIEW_CLEARANCE;
        distance = distance.max(min_safe_distance * padding);
    }

    let position = add_scaled3(center, direction, distance);

    vec![
        position[0],
        position[1],
        position[2],
        center[0],
        center[1],
        center[2],
        distance,
    ]
    .into_boxed_slice()
}

/// Solve the hero full-body framing.
///
/// * `box_min` / `box_max` - model bounding box corners.
///
/// Returns `[posX, posY, posZ, targetX, targetY, targetZ, distance]`.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_full_body_framing(
    box_min: &[f32],
    box_max: &[f32],
    model_quat: &[f32],
    fov_deg: f32,
    aspect: f32,
    min_distance: f32,
    full_body_padding: f32,
    override_padding: Option<f32>,
    camera_angle: Option<f32>,
    world_angle_space: bool,
) -> Box<[f32]> {
    if box_min.len() < 3 || box_max.len() < 3 {
        return FALLBACK_FRAMING.to_vec().into_boxed_slice();
    }

    let min = read_vec3(box_min, 0);
    let max = read_vec3(box_max, 0);
    let size = sub3(max, min);
    let center = [
        (min[0] + max[0]) / 2.0,
        (min[1] + max[1]) / 2.0,
        (min[2] + max[2]) / 2.0,
    ];

    let mut target = center;
    target[1] = min[1] + size[1] * FULL_BODY_TARGET_HEIGHT_RATIO;

    let fov = fov_distances(fov_deg, aspect);
    let distance_for_height =
        (max[1] - target[1]).max(target[1] - min[1]).max(0.0) / (fov.fov_rad / 2.0).tan();
    let distance_for_width =
        (max[0] - target[0]).max(target[0] - min[0]).max(0.0) / (fov.fov_h / 2.0).tan();
    let base_distance = distance_for_height
        .max(distance_for_width)
        .max(MIN_BASE_DISTANCE);

    let padding = override_padding
        .unwrap_or(full_body_padding)
        .min(FULL_BODY_HERO_PADDING_CAP);
    let distance = (base_distance * padding).max(min_distance);

    let effective_angle = camera_angle.unwrap_or(0.0);
    let direction = resolve_focus_camera_direction_value(
        model_quat,
        effective_angle,
        camera_angle.is_some(),
        world_angle_space,
    );
    let position = add_scaled3(target, direction, distance);

    vec![
        position[0],
        position[1],
        position[2],
        target[0],
        target[1],
        target[2],
        distance,
    ]
    .into_boxed_slice()
}

// ====== CAMERA FLIGHT ANIMATION ======

#[derive(Clone, Copy)]
struct Spherical {
    radius: f32,
    theta: f32,
    phi: f32,
}

fn to_spherical(position: [f32; 3], center: [f32; 3]) -> Spherical {
    let offset = sub3(position, center);
    let radius = (offset[0] * offset[0] + offset[1] * offset[1] + offset[2] * offset[2]).sqrt();
    if radius <= f32::EPSILON {
        return Spherical {
            radius: 0.0,
            theta: 0.0,
            phi: 0.0,
        };
    }
    Spherical {
        radius,
        theta: offset[0].atan2(offset[2]),
        phi: (offset[1] / radius).clamp(-1.0, 1.0).acos(),
    }
}

fn from_spherical(spherical: Spherical, center: [f32; 3]) -> [f32; 3] {
    let Spherical { radius, theta, phi } = spherical;
    [
        center[0] + radius * phi.sin() * theta.sin(),
        center[1] + radius * phi.cos(),
        center[2] + radius * phi.sin() * theta.cos(),
    ]
}

pub(crate) fn ease_in_out_quad(t: f32) -> f32 {
    if t < 0.5 {
        2.0 * t * t
    } else {
        1.0 - (-2.0 * t + 2.0).powi(2) / 2.0
    }
}

/// Spherical camera flight between two camera poses.
///
/// Mirrors the DPthree camera transition: orbital interpolation with a
/// pullback arc so large rotations do not pass through the model.
/// `sample(elapsed_ms)` returns
/// `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
#[wasm_bindgen]
pub struct CameraFlight {
    duration_ms: f32,
    start_target: [f32; 3],
    end_position: [f32; 3],
    end_target: [f32; 3],
    start_spherical: Spherical,
    end_spherical: Spherical,
    delta_theta: f32,
    arc_radius: f32,
}

#[wasm_bindgen]
impl CameraFlight {
    #[wasm_bindgen(constructor)]
    pub fn new(
        start_position: &[f32],
        start_target: &[f32],
        end_position: &[f32],
        end_target: &[f32],
        duration_ms: f32,
    ) -> CameraFlight {
        let start_position = read_vec3(start_position, 0);
        let start_target = read_vec3(start_target, 0);
        let end_position = read_vec3(end_position, 0);
        let end_target = read_vec3(end_target, 0);

        let start_spherical = to_spherical(start_position, start_target);
        let end_spherical = to_spherical(end_position, end_target);

        // Shortest theta path across the wrap-around.
        let mut delta_theta = end_spherical.theta - start_spherical.theta;
        if delta_theta > std::f32::consts::PI {
            delta_theta -= 2.0 * std::f32::consts::PI;
        }
        if delta_theta < -std::f32::consts::PI {
            delta_theta += 2.0 * std::f32::consts::PI;
        }

        // Pullback based on rotation, target movement, and zoom change.
        let rotation_magnitude = delta_theta.abs() / std::f32::consts::PI;
        let target_movement = distance3(start_target, end_target);
        let max_radius = start_spherical.radius.max(end_spherical.radius);
        let movement_magnitude = if max_radius > 0.0 {
            (target_movement / (max_radius * 0.3)).min(1.0)
        } else {
            0.0
        };
        let radius_change = (end_spherical.radius - start_spherical.radius).abs();
        let zoom_magnitude = if max_radius > 0.0 {
            (radius_change / max_radius).min(1.0)
        } else {
            0.0
        };

        let base_magnitude = rotation_magnitude
            .max(movement_magnitude)
            .max(zoom_magnitude * 0.5);
        let combined_magnitude = base_magnitude.max(0.3);
        let pullback_factor = 1.0 + combined_magnitude * 2.0;
        let arc_radius = max_radius * pullback_factor;

        CameraFlight {
            duration_ms,
            start_target,
            end_position,
            end_target,
            start_spherical,
            end_spherical,
            delta_theta,
            arc_radius,
        }
    }

    pub fn sample(&self, elapsed_ms: f32) -> Box<[f32]> {
        if self.duration_ms <= 0.0 || elapsed_ms >= self.duration_ms {
            return vec![
                self.end_position[0],
                self.end_position[1],
                self.end_position[2],
                self.end_target[0],
                self.end_target[1],
                self.end_target[2],
                1.0,
            ]
            .into_boxed_slice();
        }

        let t = (elapsed_ms / self.duration_ms).clamp(0.0, 1.0);
        let ease = ease_in_out_quad(t);

        let current_target = lerp3(self.start_target, self.end_target, ease);

        // Radius with pullback arc.
        let arc_influence = (std::f32::consts::PI * t).sin();
        let base_radius = self.start_spherical.radius
            + (self.end_spherical.radius - self.start_spherical.radius) * ease;
        let pullback_amount = (self.arc_radius - base_radius) * arc_influence;
        let current_radius = base_radius + pullback_amount;

        let current_spherical = Spherical {
            radius: current_radius,
            theta: self.start_spherical.theta + self.delta_theta * ease,
            phi: self.start_spherical.phi
                + (self.end_spherical.phi - self.start_spherical.phi) * ease,
        };

        let position = from_spherical(current_spherical, current_target);

        vec![
            position[0],
            position[1],
            position[2],
            current_target[0],
            current_target[1],
            current_target[2],
            0.0,
        ]
        .into_boxed_slice()
    }

    pub fn duration_ms(&self) -> f32 {
        self.duration_ms
    }
}

/// Full 360-degree eased orbit around a center point.
/// `sample(elapsed_ms)` returns
/// `[posX, posY, posZ, targetX, targetY, targetZ, done]`.
#[wasm_bindgen]
pub struct CameraOrbit {
    center: [f32; 3],
    radius: f32,
    height: f32,
    duration_ms: f32,
}

#[wasm_bindgen]
impl CameraOrbit {
    #[wasm_bindgen(constructor)]
    pub fn new(center: &[f32], radius: f32, height: f32, duration_ms: f32) -> CameraOrbit {
        CameraOrbit {
            center: read_vec3(center, 0),
            radius,
            height,
            duration_ms,
        }
    }

    pub fn sample(&self, elapsed_ms: f32) -> Box<[f32]> {
        let t = if self.duration_ms <= 0.0 {
            1.0
        } else {
            (elapsed_ms / self.duration_ms).clamp(0.0, 1.0)
        };
        let ease = ease_in_out_quad(t);
        let angle = 2.0 * std::f32::consts::PI * ease;

        vec![
            self.center[0] + angle.sin() * self.radius,
            self.height,
            self.center[2] + angle.cos() * self.radius,
            self.center[0],
            self.center[1],
            self.center[2],
            if t >= 1.0 { 1.0 } else { 0.0 },
        ]
        .into_boxed_slice()
    }

    pub fn duration_ms(&self) -> f32 {
        self.duration_ms
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn yaw_quat(degrees: f32) -> [f32; 4] {
        let half = degrees.to_radians() / 2.0;
        [0.0, half.sin(), 0.0, half.cos()]
    }

    #[test]
    fn keeps_default_framing_on_world_front_for_rotated_models() {
        let quat = yaw_quat(180.0);
        let direction = resolve_focus_camera_direction_value(&quat, 0.0, false, false);
        assert!((direction[0]).abs() < 1e-5);
        assert!((direction[1]).abs() < 1e-5);
        assert!((direction[2] - 1.0).abs() < 1e-5);
    }

    #[test]
    fn keeps_explicit_angles_relative_to_model_orientation() {
        let quat = yaw_quat(180.0);
        let direction = resolve_focus_camera_direction_value(&quat, 90.0, true, false);
        assert!((direction[0] + 1.0).abs() < 1e-5);
        assert!((direction[1]).abs() < 1e-5);
        assert!((direction[2]).abs() < 1e-5);
    }

    #[test]
    fn supports_world_space_auto_angles() {
        let quat = yaw_quat(180.0);
        let direction = resolve_focus_camera_direction_value(&quat, 25.0, false, true);
        assert!((direction[0] - 0.4226182617).abs() < 1e-5);
        assert!((direction[1]).abs() < 1e-5);
        assert!((direction[2] - 0.9063077870).abs() < 1e-5);
    }

    #[test]
    fn auto_angled_closeups_follow_model_orientation() {
        let quat = yaw_quat(180.0);
        let direction = resolve_focus_camera_direction_value(&quat, 25.0, false, false);
        let expected = direction_for_camera_angle(&quat, 25.0);
        assert!(distance3(direction, expected) < 1e-6);
    }

    #[test]
    fn resolves_auto_closeup_angles_only_for_small_offset_targets() {
        // Large focus targets never auto-angle.
        assert_eq!(
            resolve_auto_closeup_angle_value(0.2, [0.5, 0.5, 0.5], [0.8, 1.8, 0.4]),
            None
        );
        // Centered targets never auto-angle.
        assert_eq!(
            resolve_auto_closeup_angle_value(0.005, [0.1, 0.1, 0.1], [0.8, 1.8, 0.4]),
            None
        );

        let angle =
            resolve_auto_closeup_angle_value(0.2, [0.1, 0.1, 0.1], [0.8, 1.8, 0.4]).unwrap();
        let expected = (0.2f32 * 2.5).atan2(0.2).to_degrees();
        assert!((angle - expected).abs() < 1e-5);
    }

    #[test]
    fn auto_closeup_uses_fallback_depth_for_flat_models() {
        let angle =
            resolve_auto_closeup_angle_value(-0.1, [0.1, 0.1, 0.1], [0.8, 1.8, 0.0]).unwrap();
        let expected = (-0.1f32 * 2.5).atan2(0.5).to_degrees();
        assert!((angle - expected).abs() < 1e-5);
    }

    #[test]
    fn padding_factor_matches_size_bands() {
        assert!((padding_factor_for_size(0.05, 1.2, 1.5, 2.0) - 0.84).abs() < 1e-6);
        assert!((padding_factor_for_size(0.2, 1.2, 1.5, 2.0) - 1.2).abs() < 1e-6);
        assert!((padding_factor_for_size(1.0, 1.2, 1.5, 2.0) - 1.5).abs() < 1e-6);
        assert!((padding_factor_for_size(1.8, 1.2, 1.5, 2.0) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn solves_front_focus_framing() {
        // Box roughly matching a 0.8 x 1.8 x 0.4 character centered at y=0.9.
        let focus = [0.0, 0.9, 0.0, 0.8, 1.8, 0.4];
        let result = solve_focus_framing(
            &focus, &focus, &[], 45.0, 1.0, 0.5, 1.2, 1.5, 2.0, None, None, false,
        );

        let fov_rad = 45.0f32.to_radians();
        let expected_distance = ((1.8 / 2.0) / (fov_rad / 2.0).tan()) * 2.0; // full-body padding
        assert!((result[6] - expected_distance).abs() < 1e-4);
        // Front framing: camera along +Z from center.
        assert!((result[0]).abs() < 1e-5);
        assert!((result[1] - 0.9).abs() < 1e-5);
        assert!((result[2] - expected_distance).abs() < 1e-4);
        assert_eq!(&result[3..6], &[0.0, 0.9, 0.0]);
    }

    #[test]
    fn angled_framing_clears_the_model_body() {
        let focus = [0.3, 1.35, 0.1, 0.05, 0.05, 0.05];
        let model = [0.0, 0.9, 0.0, 0.8, 1.8, 0.4];
        let result = solve_focus_framing(
            &focus,
            &model,
            &[],
            45.0,
            1.0,
            0.5,
            1.2,
            1.5,
            2.0,
            None,
            Some(90.0),
            false,
        );

        // min safe = |dir.x| * 0.8/2 + offset + 0.3 ; direction is +X for 90deg.
        let offset = 0.3f32;
        let min_safe = (0.4 + offset + 0.3) * 1.2 * 0.7; // closeup padding tier for 0.05 size
        assert!(result[6] >= min_safe - 1e-4);
        assert!(result[0] > focus[0]);
    }

    #[test]
    fn empty_focus_bounds_fall_back_to_default_framing() {
        let result = solve_focus_framing(
            &[], &[], &[], 45.0, 1.0, 0.5, 1.2, 1.5, 2.0, None, None, false,
        );
        assert_eq!(&*result, &FALLBACK_FRAMING);
    }

    #[test]
    fn full_body_framing_targets_hero_height() {
        let result = solve_full_body_framing(
            &[-0.4, 0.0, -0.2],
            &[0.4, 1.8, 0.2],
            &[],
            45.0,
            1.0,
            0.5,
            2.0,
            None,
            None,
            false,
        );

        let expected_target_y = 1.8 * FULL_BODY_TARGET_HEIGHT_RATIO;
        assert!((result[4] - expected_target_y).abs() < 1e-5);

        // Padding capped at the hero cap even though config asks for 2.0.
        let fov_rad = 45.0f32.to_radians();
        let d_height = (1.8 - expected_target_y).max(expected_target_y) / (fov_rad / 2.0).tan();
        let expected_distance = d_height * FULL_BODY_HERO_PADDING_CAP;
        assert!((result[6] - expected_distance).abs() < 1e-4);
    }

    #[test]
    fn camera_flight_ends_exactly_at_the_requested_pose() {
        let flight = CameraFlight::new(
            &[0.0, 1.0, 3.0],
            &[0.0, 1.0, 0.0],
            &[2.0, 1.4, 0.0],
            &[0.1, 1.2, 0.0],
            500.0,
        );

        let mid = flight.sample(250.0);
        assert_eq!(mid[6], 0.0);

        let done = flight.sample(500.0);
        assert_eq!(&done[0..3], &[2.0, 1.4, 0.0]);
        assert_eq!(&done[3..6], &[0.1, 1.2, 0.0]);
        assert_eq!(done[6], 1.0);
    }

    #[test]
    fn camera_flight_pulls_back_mid_transition_on_large_rotations() {
        // 180-degree swing around the same target.
        let flight = CameraFlight::new(
            &[0.0, 1.0, 3.0],
            &[0.0, 1.0, 0.0],
            &[0.0, 1.0, -3.0],
            &[0.0, 1.0, 0.0],
            1000.0,
        );

        let mid = flight.sample(500.0);
        let mid_pos = [mid[0], mid[1], mid[2]];
        let mid_target = [mid[3], mid[4], mid[5]];
        let mid_radius = distance3(mid_pos, mid_target);
        assert!(mid_radius > 3.0 + 1e-3, "expected pullback, got {mid_radius}");
    }

    #[test]
    fn zero_duration_flight_completes_immediately() {
        let flight = CameraFlight::new(
            &[0.0, 1.0, 3.0],
            &[0.0, 1.0, 0.0],
            &[1.0, 1.0, 2.0],
            &[0.0, 1.0, 0.0],
            0.0,
        );
        let sample = flight.sample(0.0);
        assert_eq!(&sample[0..3], &[1.0, 1.0, 2.0]);
        assert_eq!(sample[6], 1.0);
    }

    #[test]
    fn camera_orbit_returns_to_start_after_full_revolution() {
        let orbit = CameraOrbit::new(&[0.0, 1.0, 0.0], 2.0, 1.5, 1000.0);

        let start = orbit.sample(0.0);
        assert!((start[0]).abs() < 1e-5);
        assert!((start[1] - 1.5).abs() < 1e-5);
        assert!((start[2] - 2.0).abs() < 1e-5);
        assert_eq!(start[6], 0.0);

        let end = orbit.sample(1000.0);
        assert!((end[0]).abs() < 1e-4);
        assert!((end[2] - 2.0).abs() < 1e-4);
        assert_eq!(end[6], 1.0);
    }

    #[test]
    fn normalizes_camera_angles() {
        assert_eq!(normalize_camera_angle_value(-90.0), 270.0);
        assert_eq!(normalize_camera_angle_value(450.0), 90.0);
        assert_eq!(normalize_camera_angle_value(0.0), 0.0);
    }
}
