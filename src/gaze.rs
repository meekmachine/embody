//! Profile-aware screen-space gaze geometry.
//!
//! Hosts own scene objects and reduce them to packed camera/model facts. This
//! module reconstructs a viewer target on the rendered-camera plane, measures
//! the trajectory from the character's eye origin, converts it to model-local
//! angles, and distributes those angles across the rig's head and eye AUs.

use wasm_bindgen::prelude::*;

use crate::annotation_camera::{distance3, quat_or_identity, read_vec3, rotate_by_quat, sub3};
use crate::bones::{multiply_quat, quat_from_channel};
use crate::profile::{deserialize_json, AuSelector, ProfileData};

pub const SCREEN_SPACE_GAZE_SOLUTION_STRIDE: u32 = 14;

const DEFAULT_VERTICAL_FOV_DEGREES: f32 = 45.0;
const DEFAULT_ASPECT: f32 = 1.0;
const DEFAULT_VIEWER_VERTICAL_FOV_DEGREES: f32 = 50.0;
const DEFAULT_VIEWER_ASPECT: f32 = 4.0 / 3.0;
const DEFAULT_VIEWER_DEPTH: f32 = 0.8;
const EPSILON: f32 = 1.0e-5;

#[wasm_bindgen]
pub fn screen_space_gaze_solution_stride() -> u32 {
    SCREEN_SPACE_GAZE_SOLUTION_STRIDE
}

#[derive(Clone, Copy, Debug, Default)]
struct AxisLimits {
    negative: f32,
    positive: f32,
}

impl AxisLimits {
    fn clamp(self, value: f32) -> f32 {
        value.clamp(-self.negative, self.positive)
    }

    fn capacity(self, value: f32) -> f32 {
        if value < 0.0 {
            self.negative
        } else {
            self.positive
        }
    }

    fn ratio(self, value: f32) -> f32 {
        let capacity = self.capacity(value);
        if capacity > EPSILON {
            (value / capacity).clamp(-1.0, 1.0)
        } else {
            0.0
        }
    }

    fn plus(self, other: Self) -> Self {
        Self {
            negative: self.negative + other.negative,
            positive: self.positive + other.positive,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct GazeLimits {
    head_yaw: AxisLimits,
    head_pitch: AxisLimits,
    eye_yaw: AxisLimits,
    eye_pitch: AxisLimits,
}

fn finite_positive(value: f32, fallback: f32) -> f32 {
    if value.is_finite() && value > EPSILON {
        value
    } else {
        fallback
    }
}

fn finite_coordinate(value: f32) -> f32 {
    if value.is_finite() {
        value.clamp(-1.0e12, 1.0e12)
    } else {
        0.0
    }
}

fn finite_vec3(values: &[f32]) -> [f32; 3] {
    read_vec3(values, 0).map(finite_coordinate)
}

fn normalized_coordinate(values: &[f32], index: usize) -> f32 {
    finite_coordinate(values.get(index).copied().unwrap_or(0.0)).clamp(-1.0, 1.0)
}

fn configured_bone_name(profile: &ProfileData, node: &str) -> String {
    let base = profile
        .bone_nodes
        .get(node)
        .map(String::as_str)
        .unwrap_or(node);
    let prefix = profile.bone_prefix.as_deref().unwrap_or("");
    let suffix = profile.bone_suffix.as_deref().unwrap_or("");
    format!(
        "{}{}{}",
        if base.starts_with(prefix) { "" } else { prefix },
        base,
        if base.ends_with(suffix) { "" } else { suffix }
    )
}

fn au_capacity(profile: &ProfileData, id: u32) -> f32 {
    let Some(bindings) = profile.au_to_bones.get(&id.to_string()) else {
        return 0.0;
    };
    // Use the same CC4 composite fallback as RuntimeCore when saved profiles
    // omit their table. A bone rotation mapping without a matching composite
    // cannot be driven by the runtime and therefore supplies no capacity.
    let composites = if profile.composite_rotations.is_empty() {
        &crate::presets::load_profile("cc4")
            .expect("embedded CC4 profile")
            .composite_rotations
    } else {
        &profile.composite_rotations
    };
    // Runtime selects the first binding for an AU on each bone. Repeated
    // bindings must not inflate its capacity. A shared binocular command is
    // limited by its smaller actuator; unequal eyes need per-eye calibration.
    let mut seen = std::collections::HashSet::new();
    let mut capacity = f32::INFINITY;
    for composite in composites {
        let axis = if [51, 52, 61, 62].contains(&id) {
            &composite.yaw
        } else {
            &composite.pitch
        };
        let Some(axis) = axis else {
            continue;
        };
        fn ids(selector: &Option<AuSelector>) -> &[u32] {
            match selector {
                Some(AuSelector::One(id)) => std::slice::from_ref(id),
                Some(AuSelector::Many(ids)) => ids,
                None => &[],
            }
        }
        let negative = ids(&axis.negative);
        let positive = ids(&axis.positive);
        let active = if !negative.is_empty() && !positive.is_empty() {
            negative.contains(&id) || positive.contains(&id)
        } else {
            axis.aus.contains(&id)
        };
        if !active {
            continue;
        }
        let node = configured_bone_name(profile, &composite.node);
        let Some(binding) = bindings
            .iter()
            .find(|binding| configured_bone_name(profile, &binding.node) == node)
        else {
            continue;
        };
        if !seen.insert(node) {
            continue;
        }
        if !matches!(binding.channel.as_str(), "rx" | "ry" | "rz") {
            continue;
        }
        let angle = (binding.max_degrees.unwrap_or(0.0) * binding.scale).abs() as f32;
        capacity = capacity.min(if angle.is_finite() { angle } else { 0.0 });
    }
    if capacity.is_finite() {
        capacity
    } else {
        0.0
    }
}

fn gaze_limits(profile: &ProfileData) -> GazeLimits {
    GazeLimits {
        // Limits are in geometric (+X yaw / +Y pitch) coordinates. FACS
        // horizontal output is inverted only at the public result boundary.
        head_yaw: AxisLimits {
            negative: au_capacity(profile, 52),
            positive: au_capacity(profile, 51),
        },
        head_pitch: AxisLimits {
            negative: au_capacity(profile, 54),
            positive: au_capacity(profile, 53),
        },
        eye_yaw: AxisLimits {
            negative: au_capacity(profile, 62),
            positive: au_capacity(profile, 61),
        },
        eye_pitch: AxisLimits {
            negative: au_capacity(profile, 64),
            positive: au_capacity(profile, 63),
        },
    }
}

fn add3(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(value: [f32; 3], scale: f32) -> [f32; 3] {
    [value[0] * scale, value[1] * scale, value[2] * scale]
}

fn inverse_unit_quat(values: &[f32]) -> [f32; 4] {
    let q = quat_or_identity(values);
    [-q[0], -q[1], -q[2], q[3]]
}

fn direction_angles_degrees(from: [f32; 3], to: [f32; 3], inverse_model: [f32; 4]) -> [f32; 2] {
    let local = rotate_by_quat(inverse_model, sub3(to, from));
    let horizontal = (local[0] * local[0] + local[2] * local[2]).sqrt();
    if horizontal <= EPSILON && local[1].abs() <= EPSILON {
        return [0.0, 0.0];
    }
    [
        local[0].atan2(local[2]).to_degrees(),
        local[1].atan2(horizontal.max(EPSILON)).to_degrees(),
    ]
}

fn shortest_angle_delta_degrees(target: f32, origin: f32) -> f32 {
    let mut delta = (target - origin) % 360.0;
    if delta > 180.0 {
        delta -= 360.0;
    } else if delta < -180.0 {
        delta += 360.0;
    }
    delta
}

fn gaze_rotation([yaw, pitch]: [f32; 2]) -> [f32; 4] {
    // Same order as RuntimeCore's composite axes: yaw, then local pitch.
    multiply_quat(
        quat_from_channel(1, yaw.to_radians()),
        quat_from_channel(0, -pitch.to_radians()),
    )
}

fn eye_angles(direction: [f32; 3], head: [f32; 2]) -> [f32; 2] {
    direction_angles_degrees([0.0; 3], direction, inverse_unit_quat(&gaze_rotation(head)))
}

fn posed_direction(head: [f32; 2], eye: [f32; 2]) -> [f32; 3] {
    rotate_by_quat(
        multiply_quat(gaze_rotation(head), gaze_rotation(eye)),
        [0.0, 0.0, 1.0],
    )
}

fn squared_length(v: [f32; 3]) -> f32 {
    v.iter().map(|component| component * component).sum()
}

fn clamped_eye(direction: [f32; 3], head: [f32; 2], limits: GazeLimits) -> [f32; 2] {
    let eye = eye_angles(direction, head);
    [limits.eye_yaw.clamp(eye[0]), limits.eye_pitch.clamp(eye[1])]
}

fn allocate_gaze(
    total: [f32; 2],
    camera: [f32; 2],
    follow: f32,
    limits: GazeLimits,
) -> ([f32; 2], [f32; 2]) {
    let direction = rotate_by_quat(gaze_rotation(total), [0.0, 0.0, 1.0]);
    let head_limits = [limits.head_yaw, limits.head_pitch];
    let mut head = [
        limits
            .head_yaw
            .clamp(camera[0] + shortest_angle_delta_degrees(total[0], camera[0]) * follow),
        limits
            .head_pitch
            .clamp(camera[1] + (total[1] - camera[1]) * follow),
    ];

    // Camera-facing is a preference. When the eyes cannot reach the target,
    // move the head just enough to reduce the remaining angular error. Solve
    // both axes together: subtracting Euler angles fails on pitched heads.
    // Damped least squares is bounded, only runs for eye overflow, and retains
    // the best pose when the requested direction is outside all joint limits.
    for _ in 0..16 {
        let eye = clamped_eye(direction, head, limits);
        let actual = posed_direction(head, eye);
        let error = sub3(direction, actual);
        let error_squared = squared_length(error);
        if error_squared < 1.0e-12 {
            break;
        }
        let mut jacobian = [[0.0; 3]; 2];
        for axis in 0..2 {
            // Central differences also work when one side hits a joint limit.
            let mut below = head;
            let mut above = head;
            below[axis] = head_limits[axis].clamp(head[axis] - 0.05);
            above[axis] = head_limits[axis].clamp(head[axis] + 0.05);
            let span = above[axis] - below[axis];
            if span > EPSILON {
                let low_direction = posed_direction(below, clamped_eye(direction, below, limits));
                let high_direction = posed_direction(above, clamped_eye(direction, above, limits));
                jacobian[axis] = scale3(sub3(high_direction, low_direction), 1.0 / span);
            }
        }
        let dot = |a: [f32; 3], b: [f32; 3]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
        let a = dot(jacobian[0], jacobian[0]) + 1.0e-8;
        let b = dot(jacobian[0], jacobian[1]);
        let d = dot(jacobian[1], jacobian[1]) + 1.0e-8;
        let x = dot(jacobian[0], error);
        let y = dot(jacobian[1], error);
        let determinant = a * d - b * b;
        let step = [
            ((d * x - b * y) / determinant).clamp(-20.0, 20.0),
            ((a * y - b * x) / determinant).clamp(-20.0, 20.0),
        ];
        let mut improved = false;
        for fraction in [1.0, 0.5, 0.25, 0.125] {
            let candidate = [
                head_limits[0].clamp(head[0] + step[0] * fraction),
                head_limits[1].clamp(head[1] + step[1] * fraction),
            ];
            let candidate_eye = clamped_eye(direction, candidate, limits);
            if squared_length(sub3(direction, posed_direction(candidate, candidate_eye)))
                < error_squared
            {
                head = candidate;
                improved = true;
                break;
            }
        }
        if !improved {
            break;
        }
    }
    (clamped_eye(direction, head, limits), head)
}

fn solution_from_world_target(
    viewer_target: [f32; 3],
    camera: [f32; 3],
    origin: [f32; 3],
    model_quaternion: &[f32],
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let inverse_model = inverse_unit_quat(model_quaternion);
    let [total_yaw, total_pitch] = direction_angles_degrees(origin, viewer_target, inverse_model);
    let [camera_yaw, camera_pitch] = direction_angles_degrees(origin, camera, inverse_model);
    let active = GazeLimits {
        head_yaw: if head_enabled {
            limits.head_yaw
        } else {
            AxisLimits::default()
        },
        head_pitch: if head_enabled {
            limits.head_pitch
        } else {
            AxisLimits::default()
        },
        eye_yaw: if eyes_enabled {
            limits.eye_yaw
        } else {
            AxisLimits::default()
        },
        eye_pitch: if eyes_enabled {
            limits.eye_pitch
        } else {
            AxisLimits::default()
        },
    };
    let follow = if !eyes_enabled {
        1.0
    } else if lock_head_to_camera {
        0.0
    } else if head_follow_fraction.is_finite() {
        head_follow_fraction.clamp(0.0, 1.0)
    } else {
        0.35
    };
    let ([eye_yaw, eye_pitch], [head_yaw, head_pitch]) = allocate_gaze(
        [total_yaw, total_pitch],
        [camera_yaw, camera_pitch],
        follow,
        active,
    );
    let active_yaw_capacity = active.head_yaw.plus(active.eye_yaw);
    let active_pitch_capacity = active.head_pitch.plus(active.eye_pitch);
    let distance = distance3(origin, camera).max(EPSILON);

    // FACS left/right is subject-relative. With Embody's canonical +Z front,
    // model-local +X is the character's left, so horizontal outputs invert the
    // geometric yaw sign. Positive pitch remains up.
    [
        -active_yaw_capacity.ratio(total_yaw),
        active_pitch_capacity.ratio(total_pitch),
        -active.eye_yaw.ratio(eye_yaw),
        active.eye_pitch.ratio(eye_pitch),
        -active.head_yaw.ratio(head_yaw),
        active.head_pitch.ratio(head_pitch),
        -total_yaw,
        total_pitch,
        -camera_yaw,
        camera_pitch,
        distance,
        viewer_target[0],
        viewer_target[1],
        viewer_target[2],
    ]
}

#[allow(clippy::too_many_arguments)]
fn solve(
    screen_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    vertical_fov_degrees: f32,
    aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let camera = finite_vec3(camera_position);
    let origin = finite_vec3(gaze_origin);
    let distance = distance3(origin, camera).max(EPSILON);
    let fov = finite_positive(vertical_fov_degrees, DEFAULT_VERTICAL_FOV_DEGREES)
        .clamp(1.0, 179.0)
        .to_radians();
    let aspect = finite_positive(aspect, DEFAULT_ASPECT).clamp(0.01, 100.0);
    let half_height = distance * (fov / 2.0).tan();
    let half_width = half_height * aspect;
    let screen_x = normalized_coordinate(screen_target, 0);
    let screen_y = normalized_coordinate(screen_target, 1);

    let camera_quat = quat_or_identity(camera_quaternion);
    let camera_right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
    let camera_up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
    let viewer_target = add3(
        add3(camera, scale3(camera_right, screen_x * half_width)),
        scale3(camera_up, screen_y * half_height),
    );

    solution_from_world_target(
        viewer_target,
        camera,
        origin,
        model_quaternion,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        false,
        limits,
    )
}

#[allow(clippy::too_many_arguments)]
fn solve_viewer(
    viewer_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    viewer_vertical_fov_degrees: f32,
    viewer_aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    limits: GazeLimits,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let camera = finite_vec3(camera_position);
    let origin = finite_vec3(gaze_origin);
    let fov = finite_positive(
        viewer_vertical_fov_degrees,
        DEFAULT_VIEWER_VERTICAL_FOV_DEGREES,
    )
    .clamp(1.0, 179.0)
    .to_radians();
    let aspect = finite_positive(viewer_aspect, DEFAULT_VIEWER_ASPECT).clamp(0.01, 100.0);
    let viewer_depth = finite_positive(
        viewer_target
            .get(2)
            .copied()
            .unwrap_or(DEFAULT_VIEWER_DEPTH),
        DEFAULT_VIEWER_DEPTH,
    )
    .clamp(0.2, 10.0);
    let half_height = viewer_depth * (fov / 2.0).tan();
    let half_width = half_height * aspect;
    let viewer_x = normalized_coordinate(viewer_target, 0);
    let viewer_y = normalized_coordinate(viewer_target, 1);

    let camera_quat = quat_or_identity(camera_quaternion);
    let camera_right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
    let camera_up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
    // Three.js cameras look down local -Z. A real viewer is behind the rendered
    // camera/lens, on local +Z, so webcam image offsets must be placed on that
    // side of the camera instead of on the rendered image plane.
    let camera_back = rotate_by_quat(camera_quat, [0.0, 0.0, 1.0]);
    let world_viewer_target = add3(
        add3(
            add3(camera, scale3(camera_right, viewer_x * half_width)),
            scale3(camera_up, viewer_y * half_height),
        ),
        scale3(camera_back, viewer_depth),
    );

    solution_from_world_target(
        world_viewer_target,
        camera,
        origin,
        model_quaternion,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        lock_head_to_camera,
        limits,
    )
}

/// Solve a screen-space eye target against rendered-camera and character-eye
/// geometry using the profile's authored AU rotation limits.
///
/// Output layout (14 floats): combined target x/y, eye target x/y, head target
/// x/y, total yaw/pitch degrees, camera-center yaw/pitch degrees, eye-to-camera
/// distance, and viewer-target world x/y/z.
///
/// The profile must describe the active rig and calibrated semantic yaw/pitch
/// axes: neutral forward is model +Z, up is +Y, and head yaw precedes pitch.
/// Bone availability/rest and optical-axis calibration are not encoded by this
/// ABI. Missing or morph-only AUs have no inferred angular capacity. Shared eye
/// outputs cannot represent vergence or independently calibrated eye ranges.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_screen_space_gaze(
    profile_json: &str,
    screen_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    vertical_fov_degrees: f32,
    aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve(
        screen_target,
        camera_position,
        camera_quaternion,
        gaze_origin,
        model_quaternion,
        vertical_fov_degrees,
        aspect,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        gaze_limits(&profile),
    )
    .to_vec()
    .into_boxed_slice())
}

/// Solve a webcam/user target against the rendered camera. `viewer_target` is
/// x/y in webcam NDC and z as estimated viewer distance behind the rendered
/// camera in the same units as `camera_position` and `gaze_origin`. Hosts must
/// convert estimated meters to scene units before calling. Unlike screen-space solve, the target is placed behind the
/// rendered camera/lens so oblique character-camera angles still converge on
/// the user's eye position.
/// `lock_head_to_camera` prefers the camera bearing while eyes can reach; it
/// allows head overflow correction and follows the viewer with eyes disabled.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_viewer_space_gaze(
    profile_json: &str,
    viewer_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    viewer_vertical_fov_degrees: f32,
    viewer_aspect: f32,
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve_viewer(
        viewer_target,
        camera_position,
        camera_quaternion,
        gaze_origin,
        model_quaternion,
        viewer_vertical_fov_degrees,
        viewer_aspect,
        eyes_enabled,
        head_enabled,
        head_follow_fraction,
        lock_head_to_camera,
        gaze_limits(&profile),
    )
    .to_vec()
    .into_boxed_slice())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime::RuntimeCore;

    fn cc4_profile() -> &'static ProfileData {
        crate::presets::load_profile("cc4").expect("cc4 preset")
    }

    fn canonical_profile() -> ProfileData {
        let mut profile = cc4_profile().clone();
        // This fixture has identity eye rests and +Z optical axes. CC4's rz
        // eye yaw describes a different authored rest frame, so explicitly
        // calibrate the fixture instead of assuming a CC4 GLB's optical axes.
        for au in [61, 62, 65, 66, 69, 70] {
            for binding in profile.au_to_bones.get_mut(&au.to_string()).unwrap() {
                binding.channel = "ry".into();
            }
        }
        profile
    }

    fn canonical_runtime(profile: &ProfileData) -> RuntimeCore {
        let mut core = RuntimeCore::new(0);
        core.configure_with_profile(
            &serde_json::to_string(profile).unwrap(),
            r#"{"meshes":[],"morphTargets":[],"bones":[
                {"id":1,"name":"CC_Base_Head"},
                {"id":2,"name":"CC_Base_L_Eye"},
                {"id":3,"name":"CC_Base_R_Eye"}] }"#,
        )
        .unwrap();
        core
    }

    fn runtime_viewing_direction(core: &mut RuntimeCore, solution: &[f32]) -> [f32; 3] {
        for (value, negative, positive) in [
            (solution[4], 51, 52),
            (solution[5], 54, 53),
            (solution[2], 61, 62),
            (solution[3], 64, 63),
        ] {
            core.set_au(negative, (-value).max(0.0), 0.0);
            core.set_au(positive, value.max(0.0), 0.0);
        }
        let rows = core.evaluate_bone_frame_delta();
        let rotation = |id: f32| -> [f32; 4] {
            rows.chunks(9)
                .find(|row| row[0] == id)
                .map(|row| [row[4], row[5], row[6], row[7]])
                .unwrap_or([0.0, 0.0, 0.0, 1.0])
        };
        // Forward kinematics of the fixture's actual head -> eye chain using
        // the runtime-produced bone rotations, not the solver's AU arithmetic.
        rotate_by_quat(multiply_quat(rotation(1.0), rotation(2.0)), [0.0, 0.0, 1.0])
    }

    fn angular_error(actual: [f32; 3], target: [f32; 3]) -> f32 {
        let target = scale3(target, 1.0 / squared_length(target).sqrt());
        let cross = [
            actual[1] * target[2] - actual[2] * target[1],
            actual[2] * target[0] - actual[0] * target[2],
            actual[0] * target[1] - actual[1] * target[0],
        ];
        let dot: f32 = actual.iter().zip(target).map(|(a, b)| a * b).sum();
        squared_length(cross).sqrt().atan2(dot).to_degrees()
    }

    fn ray(yaw: f32, pitch: f32) -> [f32; 3] {
        let (yaw, pitch) = (yaw.to_radians(), pitch.to_radians());
        [
            yaw.sin() * pitch.cos(),
            pitch.sin(),
            yaw.cos() * pitch.cos(),
        ]
    }

    #[test]
    fn runtime_eye_ray_converges_for_coupled_oblique_and_pitched_targets() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        for camera_yaw in [-45.0, 0.0, 45.0] {
            for camera_pitch in [-25.0, 0.0, 25.0] {
                for target_yaw in [-75.0, -35.0, 0.0, 35.0, 75.0] {
                    for target_pitch in [-35.0, -15.0, 0.0, 15.0, 35.0] {
                        let target = ray(target_yaw, target_pitch);
                        let result = solution_from_world_target(
                            target,
                            ray(camera_yaw, camera_pitch),
                            [0.0; 3],
                            &[0.0, 0.0, 0.0, 1.0],
                            true,
                            true,
                            0.35,
                            true,
                            gaze_limits(&profile),
                        );
                        let actual = runtime_viewing_direction(&mut core, &result);
                        let error = angular_error(actual, target);
                        assert!(error < 0.02, "camera {camera_yaw}/{camera_pitch}, target {target_yaw}/{target_pitch}: error {error}, solution {result:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn directional_limits_and_binding_scale_reach_the_authored_rotation() {
        let mut profile = canonical_profile();
        profile.au_to_bones.get_mut("51").unwrap()[0].scale = 0.5;
        profile.au_to_bones.get_mut("53").unwrap()[0].max_degrees = Some(15.0);
        let mut core = canonical_runtime(&profile);
        for (yaw, pitch, expected_x, expected_y) in [
            (30.0, 0.0, -1.0, 0.0),
            (-60.0, 0.0, 1.0, 0.0),
            (0.0, 15.0, 0.0, 1.0),
            (0.0, -30.0, 0.0, -1.0),
        ] {
            let target = ray(yaw, pitch);
            let result = solution_from_world_target(
                target,
                [0.0, 0.0, 1.0],
                [0.0; 3],
                &[0.0, 0.0, 0.0, 1.0],
                false,
                true,
                0.35,
                true,
                gaze_limits(&profile),
            );
            assert!((result[4] - expected_x).abs() < 1.0e-5);
            assert!((result[5] - expected_y).abs() < 1.0e-5);
            assert!(angular_error(runtime_viewing_direction(&mut core, &result), target) < 0.002);
        }
    }

    #[test]
    fn capacity_uses_selected_composite_binding_and_requires_a_driven_axis() {
        let mut profile = canonical_profile();
        let mut unused = profile.au_to_bones["51"][0].clone();
        unused.max_degrees = Some(180.0);
        profile
            .au_to_bones
            .get_mut("51")
            .unwrap()
            .push(unused.clone());
        unused.node = "NotTheHead".into();
        profile.au_to_bones.get_mut("51").unwrap().insert(0, unused);
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 60.0);
        for composite in &mut profile.composite_rotations {
            if composite.node == "HEAD" {
                composite.yaw = None;
            }
        }
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 0.0);
    }

    #[test]
    fn disabled_or_unmapped_actuators_do_not_absorb_the_target() {
        for eyes in [false, true] {
            let mut profile = canonical_profile();
            for au in if eyes {
                [51, 52, 53, 54]
            } else {
                [61, 62, 63, 64]
            } {
                profile.au_to_bones.remove(&au.to_string());
            }
            let mut core = canonical_runtime(&profile);
            let target = ray(-15.0, 12.0);
            let result = solution_from_world_target(
                target,
                [0.0, 0.0, 1.0],
                [0.0; 3],
                &[0.0, 0.0, 0.0, 1.0],
                true,
                true,
                0.35,
                true,
                gaze_limits(&profile),
            );
            let missing = if eyes { &result[4..6] } else { &result[2..4] };
            assert!(missing.iter().all(|value| value.abs() < 1.0e-6));
            assert!(angular_error(runtime_viewing_direction(&mut core, &result), target) < 0.002);
        }
        let mut morph_only = canonical_profile();
        morph_only.au_to_bones.clear();
        let result = solution_from_world_target(
            [1.0, 1.0, 1.0],
            [0.0, 0.0, 1.0],
            [0.0; 3],
            &[0.0, 0.0, 0.0, 1.0],
            true,
            true,
            0.35,
            true,
            gaze_limits(&morph_only),
        );
        assert!(result[..6].iter().all(|value| *value == 0.0));
    }

    #[test]
    fn unreachable_and_nonfinite_inputs_remain_bounded() {
        let profile = canonical_profile();
        for target in [[1.0, 1.0, -1.0], [-1.0, -1.0, -1.0], [0.0, 0.0, -1.0]] {
            let result = solution_from_world_target(
                target,
                [0.0, 0.0, 1.0],
                [0.0; 3],
                &[0.0, 0.0, 0.0, 1.0],
                true,
                true,
                f32::NAN,
                true,
                gaze_limits(&profile),
            );
            assert!(result.iter().all(|value| value.is_finite()));
            assert!(result[..6].iter().all(|value| value.abs() <= 1.0));
        }
        let result = solve_viewer(
            &[f32::NAN, f32::INFINITY, f32::NAN],
            &[f32::NAN, 0.0, 1.0],
            &[f32::NAN; 4],
            &[0.0; 3],
            &[f32::NAN; 4],
            f32::NAN,
            f32::INFINITY,
            true,
            true,
            f32::NAN,
            false,
            gaze_limits(&profile),
        );
        assert!(result.iter().all(|value| value.is_finite()));
    }

    fn solve_cc4(
        screen: &[f32],
        camera: &[f32],
        camera_quat: &[f32],
        origin: &[f32],
        model_quat: &[f32],
    ) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
        solve(
            screen,
            camera,
            camera_quat,
            origin,
            model_quat,
            90.0,
            1.0,
            true,
            true,
            0.35,
            gaze_limits(cc4_profile()),
        )
    }

    fn solve_viewer_cc4(
        viewer: &[f32],
        camera: &[f32],
        camera_quat: &[f32],
        origin: &[f32],
        model_quat: &[f32],
        lock_head_to_camera: bool,
    ) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
        solve_viewer(
            viewer,
            camera,
            camera_quat,
            origin,
            model_quat,
            90.0,
            1.0,
            true,
            true,
            0.35,
            lock_head_to_camera,
            gaze_limits(cc4_profile()),
        )
    }

    #[test]
    fn centered_front_camera_is_neutral_and_reports_eye_distance() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!(result[0].abs() < 1.0e-6);
        assert!(result[2].abs() < 1.0e-6);
        assert!(result[4].abs() < 1.0e-6);
        assert!((result[10] - 3.0).abs() < 1.0e-6);
        assert!((result[11] - 0.0).abs() < 1.0e-6);
        assert!((result[12] - 1.6).abs() < 1.0e-6);
        assert!((result[13] - 3.0).abs() < 1.0e-6);
    }

    #[test]
    fn camera_center_turns_the_head_to_face_the_camera() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[3.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!((result[8] + 45.0).abs() < 1.0e-4);
        assert!((result[4] + 0.75).abs() < 1.0e-4);
        assert!(result[2].abs() < 1.0e-4);
    }

    #[test]
    fn screen_motion_uses_projection_and_splits_eye_lead_from_head_follow() {
        let result = solve_cc4(
            &[0.5, 0.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        // A 90-degree vertical FOV at aspect 1 makes x=0.5 a 26.565-degree
        // target. Eyes lead 65% while the head follows 35%.
        assert!((result[6] + 26.56505).abs() < 1.0e-3);
        assert!((result[2] + 0.69069).abs() < 1.0e-3);
        assert!((result[4] + 0.15496).abs() < 1.0e-3);
    }

    #[test]
    fn eye_overflow_reaches_full_range_after_head_saturates() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[1000.0, 1.6, 87.4887],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!((result[4] + 1.0).abs() < 1.0e-3);
        assert!((result[2] + 1.0).abs() < 1.0e-3);
        assert!((result[0] + 1.0).abs() < 1.0e-3);
    }

    #[test]
    fn viewer_space_places_the_user_behind_the_rendered_camera() {
        let result = solve_viewer_cc4(
            &[0.5, 0.0, 1.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            true,
        );

        // x=0.5 at a 1m viewer distance and 90-degree webcam FOV is 0.5m to
        // camera-right, one meter behind the rendered camera: (0.5, 1.6, 4).
        // The head stays camera-facing while the eyes take the off-center
        // viewer delta.
        assert!((result[6] + 7.125016).abs() < 1.0e-3);
        assert!((result[2] + 0.285).abs() < 1.0e-3);
        assert!(result[4].abs() < 1.0e-4);
        assert!((result[11] - 0.5).abs() < 1.0e-4);
        assert!((result[12] - 1.6).abs() < 1.0e-4);
        assert!((result[13] - 4.0).abs() < 1.0e-4);
    }

    #[test]
    fn viewer_space_respects_oblique_rendered_camera_orientation() {
        let half_yaw = (std::f32::consts::FRAC_PI_4 / 2.0).sin();
        let half_w = (std::f32::consts::FRAC_PI_4 / 2.0).cos();
        let result = solve_viewer_cc4(
            &[0.0, 0.0, 1.0],
            &[3.0, 1.6, 3.0],
            &[0.0, half_yaw, 0.0, half_w],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            true,
        );
        let expected = 3.0 + std::f32::consts::FRAC_1_SQRT_2;

        // The user is behind the camera lens along the rendered camera's
        // local +Z/back vector, so an off-front virtual camera still produces
        // the same camera-facing head baseline.
        assert!((result[8] + 45.0).abs() < 1.0e-3);
        assert!((result[4] + 0.75).abs() < 1.0e-3);
        assert!(result[2].abs() < 1.0e-4);
        assert!((result[11] - expected).abs() < 1.0e-3);
        assert!((result[13] - expected).abs() < 1.0e-3);
    }

    #[test]
    fn camera_baseline_allows_eye_overflow_to_turn_the_head() {
        let result = solve_viewer(
            &[1.0, 0.0, 1.0],
            &[0.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            150.0,
            1.0,
            true,
            true,
            0.35,
            true,
            gaze_limits(cc4_profile()),
        );

        assert!((result[2] + 1.0).abs() < 1.0e-4);
        assert!(result[4] < -0.1, "head must help eyes reach the user");
        assert!((result[2] * 25.0 + result[4] * 60.0 - result[6]).abs() < 1.0e-3);
    }

    #[test]
    fn model_orientation_changes_the_local_trajectory() {
        let half = (std::f32::consts::FRAC_PI_2 / 2.0).sin();
        let half_w = (std::f32::consts::FRAC_PI_2 / 2.0).cos();
        let result = solve_cc4(
            &[0.0, 0.0],
            &[3.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, half, 0.0, half_w],
        );
        assert!(result[8].abs() < 1.0e-4);
    }
}
