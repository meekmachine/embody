//! Profile-aware gaze geometry and compatibility gaze solvers.
//!
//! Hosts own scene objects and reduce them to packed camera/model facts. This
//! module exposes camera bearings and authored angular capacities independently
//! of tracking decisions. The existing solvers also reconstruct viewer targets and
//! distribute their angles across head and eye AUs for compatibility.
//!
//! The geometry-only entry point is `resolve_profile_gaze_geometry_json`.
//! It deliberately receives no tracking input, strength, follow fraction,
//! enablement, or time. Polymer owns those movement decisions and schedules
//! ordinary AU clips; RuntimeCore still compiles their saved bone/morph outputs.
//! Sharing the capacity reader below with compatibility solvers keeps an edited
//! profile's range consistent without making the new query invoke a solver.

use serde::Serialize;
use wasm_bindgen::prelude::*;

use crate::annotation_camera::{distance3, dot3, quat_or_identity, read_vec3, rotate_by_quat, sub3};
use crate::bones::{multiply_quat, quat_from_channel};
use crate::body_controls::configured_bone_name;
use crate::math::finite_or;
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

// These are two nonnegative magnitudes in degrees, not signed output values.
// Keeping the directions independent preserves asymmetric authored limits and
// one-sided mappings. Converting a requested angle to a normalized AU value is
// a consumer decision that divides by the corresponding directional capacity.
#[derive(Clone, Copy, Debug, Default, Serialize)]
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

// The field names are semantic gaze controls. They do not require a profile to
// store its physical rotation in a correspondingly named composite slot.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GazeLimits {
    head_yaw: AxisLimits,
    head_pitch: AxisLimits,
    eye_yaw: AxisLimits,
    eye_pitch: AxisLimits,
}

// This pair is used both for degree-valued bearings and dimensionless tangent
// projections. The enclosing JSON field name/doc contract distinguishes them;
// a projection must not be mistaken for a requested angular displacement.
#[derive(Clone, Copy, Debug, Serialize)]
struct Bearing {
    yaw: f32,
    pitch: f32,
}

// Named JSON avoids adding another positional packed-array ABI for facts with
// different units. Optional bearings become JSON null when no camera ray exists;
// capacities remain useful even in that case because they depend only on profile.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GazeGeometry {
    camera_bearing_degrees: Option<Bearing>,
    camera_distance_scene_units: f32,
    display_right_in_model: [f32; 3],
    display_up_in_model: [f32; 3],
    display_right_in_bearing: Option<Bearing>,
    display_up_in_bearing: Option<Bearing>,
    limits_degrees: GazeLimits,
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

fn au_capacity(profile: &ProfileData, id: u32) -> f32 {
    // Capacity describes the unit AU's authored rotational response. This is a
    // profile query, not a live skeleton query: it cannot tell whether a named
    // bone is currently bound, measure its optical accuracy, or alter its pose.
    let Some(bindings) = profile.au_to_bones.get(&id.to_string()) else {
        return 0.0;
    };
    // Use the same CC4 composite fallback as RuntimeCore when saved profiles
    // omit their table. A bone rotation mapping without a matching composite
    // cannot be driven by the runtime and therefore supplies no capacity.
    // `unspecified` differs from explicit []: the latter is an author's clear
    // operation and must never be replaced by an embedded preset here.
    let composites = if profile.composite_rotations.is_unspecified() {
        &crate::presets::load_profile("cc4")
            .expect("embedded CC4 profile")
            .composite_rotations
    } else {
        &profile.composite_rotations
    };
    // A secondary output of a head/eye AU must not shrink the optical joint's
    // range. Runtime still applies all those outputs when the AU is sampled.
    // For example, AU51 may rotate HEAD by 60 degrees and an auxiliary bone by
    // 7 degrees. Both outputs belong in the clip, but its head travel is 60,
    // not the minimum of every downstream bone affected by that AU.
    let roles: &[&str] = if id < 60 { &["HEAD"] } else { &["EYE_L", "EYE_R"] };
    let nodes: Vec<_> = roles.iter().map(|node| configured_bone_name(profile, node)).collect();
    let mut responses: std::collections::HashMap<String, (usize, f32)> = std::collections::HashMap::new();
    for composite in composites.iter() {
        let node = configured_bone_name(profile, &composite.node);
        if !nodes.contains(&node) { continue; }
        // The compiler selects the FIRST binding on this bone, independent of
        // which composite slot was authored. Do not search past a cleared or
        // non-rotation first binding, and do not assume semantic yaw is stored
        // in the compiler's yaw slot.
        let Some(binding) = bindings
            .iter()
            .find(|binding| configured_bone_name(profile, &binding.node) == node)
        else {
            continue;
        };
        if !matches!(binding.channel.as_str(), "rx" | "ry" | "rz") {
            continue;
        }
        // Use the evaluator's scalar defaults and preserve authored scaling.
        // A negative physical axis/scale changes actual rotation direction;
        // the capacity exposes only its nonnegative magnitude. The saved
        // binding, not this query's yaw label, controls the resulting quaternion.
        let angle = (finite_or(binding.max_degrees.unwrap_or(0.0) as f32, 0.0)
            * finite_or(binding.scale as f32, 1.0)).abs();
        for axis in [&composite.yaw, &composite.pitch, &composite.roll].into_iter().flatten() {
            fn ids(selector: &Option<AuSelector>) -> &[u32] {
                match selector {
                    Some(AuSelector::One(id)) => std::slice::from_ref(id),
                    Some(AuSelector::Many(ids)) => ids,
                    None => &[],
                }
            }
            let negative = ids(&axis.negative);
            let positive = ids(&axis.positive);
            // Directional selectors are active as a pair, matching the core
            // compiler. With only one selector side present, its plain AU list
            // remains authoritative. Inspect all composition slots because an
            // authored head-yaw AU can legitimately live in pitch or roll order.
            let active = if !negative.is_empty() && !positive.is_empty() {
                // A unit probe present on both directional sides cancels in
                // composite_axis_value and supplies no rotation.
                negative.contains(&id) != positive.contains(&id)
            } else {
                axis.aus.contains(&id)
            };
            if active {
                let angle = if angle.is_finite() && angle > 1e-8 { angle } else { 0.0 };
                let response = responses.entry(node.clone()).or_insert((0, angle));
                response.0 += 1;
            }
        }
    }
    // Multiple responses on one joint cannot be advertised as one axis's range.
    // Shared eye commands use the smaller response among mapped eye actuators;
    // an absent eye is not inserted as a synthetic zero response. With no mapped
    // response at all, the result is zero. Live binding availability and actual
    // binocular measurements belong to the renderer observation boundary.
    responses.values().map(|(count, angle)| if *count == 1 { *angle } else { 0.0 })
        .reduce(f32::min).unwrap_or(0.0)
}

fn gaze_limits(profile: &ProfileData) -> GazeLimits {
    GazeLimits {
        // Limits are in geometric (+X yaw / +Y pitch) coordinates. FACS
        // horizontal output is inverted only by compatibility solver results
        // (or by Polymer when it emits AU controls). The geometry query itself
        // leaves these signs untouched: negative yaw selects AU52/AU62 and
        // positive yaw selects AU51/AU61, regardless of a custom physical axis.
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

fn gaze_rotation([yaw, pitch]: [f32; 2]) -> [f32; 4] {
    // Same order as RuntimeCore's composite axes: yaw, then local pitch.
    multiply_quat(
        quat_from_channel(1, yaw.to_radians()),
        quat_from_channel(0, -pitch.to_radians()),
    )
}

fn profile_gaze_geometry(
    profile: &ProfileData,
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
) -> GazeGeometry {
    // Normalize the supplied facts once. Position differences are taken in a
    // common world frame, then orientation-only inverse model rotation makes
    // the result relative to the character's neutral front (+Z). No current
    // head/eye pose is subtracted, and no scene node is read or changed.
    let camera = finite_vec3(camera_position);
    let origin = finite_vec3(gaze_origin);
    let inverse_model = inverse_unit_quat(model_quaternion);
    let camera_rotation = quat_or_identity(camera_quaternion);
    // Screen right/up first travel from camera-local to world, then to model
    // coordinates. Camera position determines bearing; camera orientation
    // determines these display axes. Keeping those inputs separate matters for
    // oblique framing and camera roll, even when the camera faces elsewhere.
    let display_axis = |axis| rotate_by_quat(inverse_model, rotate_by_quat(camera_rotation, axis));
    let right = display_axis([1.0, 0.0, 0.0]);
    let up = display_axis([0.0, 1.0, 0.0]);
    let distance = distance3(origin, camera);
    // A coincident origin/camera has distance zero but no meaningful direction.
    // Returning null here prevents a consumer from confusing missing geometry
    // with a measured neutral-facing camera. Reach limits do not clamp a ray.
    let bearing = (distance > EPSILON).then(|| {
        let [yaw, pitch] = direction_angles_degrees(origin, camera, inverse_model);
        Bearing { yaw, pitch }
    });
    let project = |axis| {
        bearing.map(|bearing| {
            let rotation = gaze_rotation([bearing.yaw, bearing.pitch]);
            // These are raw geometric projections. Whether to normalize them
            // when mapping a display control into travel is a consumer decision.
            // Rotate +X/+Y tangents into the bearing frame and take dot products
            // with each display axis. These are dimensionless components, not
            // degrees, head participation, or a percentage of the AU range.
            Bearing {
                yaw: dot3(axis, rotate_by_quat(rotation, [1.0, 0.0, 0.0])),
                pitch: dot3(axis, rotate_by_quat(rotation, [0.0, 1.0, 0.0])),
            }
        })
    };
    GazeGeometry {
        camera_bearing_degrees: bearing,
        camera_distance_scene_units: distance,
        display_right_in_model: right,
        display_up_in_model: up,
        display_right_in_bearing: project(right),
        display_up_in_bearing: project(up),
        limits_degrees: gaze_limits(profile),
    }
}

/// Read camera geometry and authored angular capacities without selecting a
/// target or allocating motion. Returns named JSON fields with camelCase keys.
/// Positions use a common world frame and scene units; quaternions are XYZW.
/// Model-neutral +Z is forward and +Y is up. Bearings use geometric degrees:
/// positive yaw points toward model +X, positive pitch toward +Y. This yaw sign
/// is opposite the existing solvers' subject-relative FACS output sign.
/// The quaternion input represents orientation, not negative-scale reflection.
///
/// `cameraBearingDegrees` is {yaw, pitch}, without clamping to AU limits;
/// `cameraDistanceSceneUnits` is the distance from gaze origin to camera.
/// `displayRightInModel` and
/// `displayUpInModel` are unit XYZ vectors. `displayRightInBearing` and
/// `displayUpInBearing` are dimensionless {yaw, pitch} dot products against the
/// camera bearing's unit tangents, without renormalizing their projection.
/// At distance <= 1e-5 scene units, bearing and its projections are null.
///
/// `limitsDegrees` contains headYaw/headPitch/eyeYaw/eyePitch, each with
/// nonnegative `negative` and `positive` capacities in geometric coordinates.
/// Head yaw negative/positive select AU52/AU51, pitch selects AU54/AU53;
/// eye yaw selects AU62/AU61 and pitch AU64/AU63. These labels do not override
/// the signed physical channel in the saved AU binding. Capacities describe
/// the named HEAD or EYE_L/EYE_R actuators, ignoring auxiliary mapped bones.
/// Shared eye capacity is the smaller mapped eye response, excluding unmapped
/// eyes. An AU with no usable mapped response supplies zero range; a mapped
/// zero/ambiguous response also bounds the shared capacity to zero. The
/// query does not inspect a live skeleton or pose or modify any AU binding.
/// Missing/nonfinite position components become zero, finite components clamp
/// to +/-1e12; invalid quaternions use identity and valid ones are normalized.
/// Invalid profile JSON returns an error. No runtime state is read or mutated.
#[wasm_bindgen]
pub fn resolve_profile_gaze_geometry_json(
    profile_json: &str,
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
) -> Result<String, JsError> {
    // Deserialize through the same typed profile boundary used by the core.
    // Malformed JSON is an error, while an explicitly empty profile is valid
    // and reports geometry with no invented AU capacity. Serialization names
    // and units above are the public contract; no RuntimeCore is constructed.
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    let geometry = profile_gaze_geometry(
        &profile,
        camera_position,
        camera_quaternion,
        gaze_origin,
        model_quaternion,
    );
    serde_json::to_string(&geometry)
        .map_err(|error| JsError::new(&format!("Failed to serialize gaze geometry: {error}")))
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
    preferred_head: [f32; 2],
    limits: GazeLimits,
) -> ([f32; 2], [f32; 2]) {
    let direction = rotate_by_quat(gaze_rotation(total), [0.0, 0.0, 1.0]);
    let head_limits = [limits.head_yaw, limits.head_pitch];
    let mut head = [
        limits.head_yaw.clamp(preferred_head[0]),
        limits.head_pitch.clamp(preferred_head[1]),
    ];

    // The requested head participation or camera lock is a preference.
    // When the eyes cannot reach the target,
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
    } else if head_follow_fraction.is_finite() {
        head_follow_fraction.clamp(0.0, 1.0)
    } else {
        0.35
    };
    // Ordinary following participates toward the common target from neutral.
    // Blending from the camera can put the head on the opposite side of the
    // target; camera-facing belongs only to the explicit policy. With eyes
    // disabled the head must carry the target regardless of that preference.
    let preferred_head = if lock_head_to_camera && eyes_enabled {
        [camera_yaw, camera_pitch]
    } else {
        [total_yaw * follow, total_pitch * follow]
    };
    let ([eye_yaw, eye_pitch], [head_yaw, head_pitch]) =
        allocate_gaze([total_yaw, total_pitch], preferred_head, active);
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

#[cfg(test)]
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
    solve_viewer_scaled(
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
        limits,
        1.0,
    )
}

#[allow(clippy::too_many_arguments)]
fn solve_viewer_scaled(
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
    world_units_per_meter: f32,
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
    let viewer_depth_meters = finite_positive(
        viewer_target
            .get(2)
            .copied()
            .unwrap_or(DEFAULT_VIEWER_DEPTH),
        DEFAULT_VIEWER_DEPTH,
    )
    .clamp(0.2, 10.0);
    let world_units_per_meter = if world_units_per_meter.is_finite() && world_units_per_meter > 0.0
    {
        world_units_per_meter
    } else {
        1.0
    };
    // Depth bounds describe the physical viewer, independent of scene units.
    // Convert before projecting lateral offsets so XYZ use one common scale.
    let viewer_depth = viewer_depth_meters * world_units_per_meter;
    let half_height = viewer_depth * (fov / 2.0).tan();
    let half_width = half_height * aspect;
    let viewer_x = normalized_coordinate(viewer_target, 0);
    let viewer_y = normalized_coordinate(viewer_target, 1);

    let camera_quat = quat_or_identity(camera_quaternion);
    let camera_right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
    let camera_up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
    // Zero viewer XY means eye contact with the rendered camera. Extend that
    // eye-to-camera bearing, not the camera optical axis: scene framing may
    // put the character's eyes away from the image center. Keep image offsets
    // in camera-right/up so an oblique or rolled camera retains its convention.
    // If the camera coincides with the eyes, its local +Z is a finite fallback.
    let camera_back = rotate_by_quat(camera_quat, [0.0, 0.0, 1.0]);
    let eye_to_camera = sub3(camera, origin);
    let eye_to_camera_distance = squared_length(eye_to_camera).sqrt();
    let viewer_bearing = if eye_to_camera_distance > EPSILON {
        scale3(eye_to_camera, 1.0 / eye_to_camera_distance)
    } else {
        camera_back
    };
    let world_viewer_target = add3(
        add3(
            add3(camera, scale3(camera_right, viewer_x * half_width)),
            scale3(camera_up, viewer_y * half_height),
        ),
        scale3(viewer_bearing, viewer_depth),
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

/// Map a normalized tracking axis around the camera bearing onto the complete
/// signed AU range. Projection FOV and viewer distance must not shrink it.
fn tracking_axis(value: f32, center: f32, limits: AxisLimits) -> f32 {
    let center = limits.clamp(center);
    let value = value.clamp(-1.0, 1.0);
    let endpoint = if value < 0.0 { -limits.negative } else { limits.positive };
    center + (endpoint - center) * value.abs()
}

#[allow(clippy::too_many_arguments)]
fn solve_tracking(
    tracking_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    limits: GazeLimits,
    world_units_per_meter: f32,
) -> [f32; SCREEN_SPACE_GAZE_SOLUTION_STRIDE as usize] {
    let camera = finite_vec3(camera_position);
    let origin = finite_vec3(gaze_origin);
    let inverse_model = inverse_unit_quat(model_quaternion);
    let center = direction_angles_degrees(origin, camera, inverse_model);
    // Project display right/up onto the model's bearing tangents. This keeps
    // source parity when the camera is rolled or the character is rotated.
    let camera_rotation = quat_or_identity(camera_quaternion);
    let model_right = rotate_by_quat(inverse_model, rotate_by_quat(camera_rotation, [1.0, 0.0, 0.0]));
    let model_up = rotate_by_quat(inverse_model, rotate_by_quat(camera_rotation, [0.0, 1.0, 0.0]));
    let center_rotation = gaze_rotation(center);
    let yaw_tangent = rotate_by_quat(center_rotation, [1.0, 0.0, 0.0]);
    let pitch_tangent = rotate_by_quat(center_rotation, [0.0, 1.0, 0.0]);
    let dot = |a: [f32; 3], b: [f32; 3]| -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() };
    let display_axis = |axis| {
        let yaw = dot(axis, yaw_tangent);
        let pitch = dot(axis, pitch_tangent);
        let length = (yaw * yaw + pitch * pitch).sqrt();
        if length > EPSILON { [yaw / length, pitch / length] } else { [0.0; 2] }
    };
    let right = display_axis(model_right);
    let up = display_axis(model_up);
    let x = normalized_coordinate(tracking_target, 0);
    let y = normalized_coordinate(tracking_target, 1);
    let (yaw_limits, pitch_limits) = if head_enabled {
        (limits.head_yaw, limits.head_pitch)
    } else if eyes_enabled {
        (limits.eye_yaw, limits.eye_pitch)
    } else {
        (AxisLimits::default(), AxisLimits::default())
    };
    let angles = [
        tracking_axis(x * right[0] + y * up[0], center[0], yaw_limits),
        tracking_axis(x * right[1] + y * up[1], center[1], pitch_limits),
    ];
    let direction = rotate_by_quat(
        quat_or_identity(model_quaternion),
        rotate_by_quat(gaze_rotation(angles), [0.0, 0.0, 1.0]),
    );
    // Retain a finite binocular target. Depth affects convergence, not travel.
    let depth = finite_positive(tracking_target.get(2).copied().unwrap_or(DEFAULT_VIEWER_DEPTH), DEFAULT_VIEWER_DEPTH)
        .clamp(0.2, 10.0) * finite_positive(world_units_per_meter, 1.0);
    let target = add3(origin, scale3(direction, distance3(origin, camera) + depth));
    solution_from_world_target(
        target, camera, origin, model_quaternion, eyes_enabled, head_enabled,
        head_follow_fraction, lock_head_to_camera, limits,
    )
}

/// Normalized tracking controls span the active profile's signed head AU range
/// (or eye range with the head disabled). At full head participation, +/-1 on
/// an aligned display axis reaches the same rotation as its AU at intensity 1.
/// Zero input retains the camera bearing, bounded by that range. Camera roll
/// rotates display axes into the model frame. X/Y are clamped to [-1, 1]; Z is
/// finite-target depth in meters and does not attenuate angular movement.
/// Pass 1 for full head participation; smaller explicit fractions retain the
/// existing allocation policy. Output layout matches the physical gaze solvers.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_tracking_gaze(
    profile_json: &str,
    tracking_target: &[f32],
    camera_position: &[f32],
    camera_quaternion: &[f32],
    gaze_origin: &[f32],
    model_quaternion: &[f32],
    eyes_enabled: bool,
    head_enabled: bool,
    head_follow_fraction: f32,
    lock_head_to_camera: bool,
    world_units_per_meter: f32,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve_tracking(
        tracking_target, camera_position, camera_quaternion, gaze_origin,
        model_quaternion, eyes_enabled, head_enabled, head_follow_fraction,
        lock_head_to_camera, gaze_limits(&profile), world_units_per_meter,
    ).to_vec().into_boxed_slice())
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
/// Head follow is participation from model-neutral +Z toward the shared target;
/// zero prefers neutral, with additional head movement allowed for eye overflow.
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
/// convert estimated meters to scene units before calling. Zero x/y extends the
/// eye-to-camera bearing; camera-right/up offsets retain the viewer projection
/// without making eye contact depend on where the eyes sit in the image.
/// `lock_head_to_camera` prefers the camera bearing while eyes can reach; it
/// allows head overflow correction and follows the viewer with eyes disabled.
/// Without that explicit lock, head follow participates from model-neutral +Z
/// toward the shared target. A zero follow fraction does not imply camera lock.
/// New consumers with metric viewer depth should use
/// `solve_profile_viewer_space_gaze_scaled` to supply the scene conversion.
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
    solve_profile_viewer_space_gaze_scaled(
        profile_json,
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
        1.0,
    )
}

/// Solve a webcam/user target with an explicit scene-unit conversion.
/// `viewer_target` x/y are normalized webcam coordinates and z is estimated
/// viewer distance in meters. `world_units_per_meter` converts both that depth
/// and its projected lateral offsets into the units of `camera_position` and
/// `gaze_origin`. Positive finite scales are accepted; malformed scales use 1.
/// The output layout and head/eye allocation match the unscaled export.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn solve_profile_viewer_space_gaze_scaled(
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
    world_units_per_meter: f32,
) -> Result<Box<[f32]>, JsError> {
    let profile: ProfileData = deserialize_json(profile_json, "Invalid gaze profile JSON")
        .map_err(|error| JsError::new(&error))?;
    Ok(solve_viewer_scaled(
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
        world_units_per_meter,
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

    // Exercise the public JSON boundary instead of asserting only private
    // structs. This catches field naming/nullability drift for Wasm consumers;
    // package smoke separately covers the generated JavaScript export.
    fn geometry_json(
        profile: &ProfileData,
        camera: &[f32],
        camera_quaternion: &[f32],
        origin: &[f32],
        model_quaternion: &[f32],
    ) -> serde_json::Value {
        let result = resolve_profile_gaze_geometry_json(
            &serde_json::to_string(profile).unwrap(),
            camera,
            camera_quaternion,
            origin,
            model_quaternion,
        )
        .unwrap();
        serde_json::from_str(&result).unwrap()
    }

    fn assert_geometry_number(value: &serde_json::Value, expected: f64) {
        let actual = value.as_f64().expect("finite geometry number");
        assert!((actual - expected).abs() < 1.0e-4, "{actual} != {expected}");
    }

    #[test]
    fn geometry_reports_unbounded_camera_bearing_and_raw_display_projections() {
        // A 2/1/2 world offset gives independently calculable bearing, distance,
        // and non-unit projection magnitudes. Normalizing the projections here
        // would silently introduce an input-range decision into the fact API.
        let result = geometry_json(cc4_profile(), &[2.0, 1.0, 2.0], &[], &[0.0; 3], &[]);
        assert_geometry_number(&result["cameraBearingDegrees"]["yaw"], 45.0);
        assert_geometry_number(
            &result["cameraBearingDegrees"]["pitch"],
            (1.0_f64 / 8.0_f64.sqrt()).atan().to_degrees(),
        );
        assert_geometry_number(&result["cameraDistanceSceneUnits"], 3.0);
        assert_geometry_number(&result["displayRightInBearing"]["yaw"], 0.5_f64.sqrt());
        assert_geometry_number(
            &result["displayRightInBearing"]["pitch"],
            -1.0 / (3.0 * 2.0_f64.sqrt()),
        );
        assert_geometry_number(&result["displayUpInBearing"]["yaw"], 0.0);
        assert_geometry_number(
            &result["displayUpInBearing"]["pitch"],
            8.0_f64.sqrt() / 3.0,
        );
        // The query reports geometry even when no head AU can reach it. Both
        // choosing a target and clamping it belong to the consumer's policy.
        for (x, expected) in [(2.0, 135.0), (-2.0, -135.0)] {
            let behind = geometry_json(cc4_profile(), &[x, 0.0, -2.0], &[], &[0.0; 3], &[]);
            assert_geometry_number(&behind["cameraBearingDegrees"]["yaw"], expected);
            assert!(
                expected.abs()
                    > behind["limitsDegrees"]["headYaw"]["positive"]
                        .as_f64()
                        .unwrap()
            );
        }
    }

    #[test]
    fn geometry_resolves_model_orientation_and_camera_roll_in_separate_frames() {
        // Translation, a nonidentity model orientation, and camera roll vary
        // independently. A world-axis-only implementation can pass frontal
        // examples but fails this separation of model front and display right.
        let model = quat_from_channel(1, std::f32::consts::FRAC_PI_2);
        let rolled_camera = multiply_quat(model, quat_from_channel(2, std::f32::consts::FRAC_PI_2));
        let result = geometry_json(
            cc4_profile(),
            &[7.0, 7.0, -3.0],
            &rolled_camera,
            &[5.0, 7.0, -3.0],
            &model,
        );
        // The camera lies on world +X, which is this model's neutral +Z.
        assert_geometry_number(&result["cameraBearingDegrees"]["yaw"], 0.0);
        assert_geometry_number(&result["cameraBearingDegrees"]["pitch"], 0.0);
        assert_geometry_number(&result["cameraDistanceSceneUnits"], 2.0);
        for (axis, expected) in [
            ("displayRightInModel", [0.0, 1.0, 0.0]),
            ("displayUpInModel", [-1.0, 0.0, 0.0]),
        ] {
            for (index, component) in expected.iter().enumerate() {
                assert_geometry_number(&result[axis][index], *component);
            }
        }
        assert_geometry_number(&result["displayRightInBearing"]["yaw"], 0.0);
        assert_geometry_number(&result["displayRightInBearing"]["pitch"], 1.0);
        assert_geometry_number(&result["displayUpInBearing"]["yaw"], -1.0);
        assert_geometry_number(&result["displayUpInBearing"]["pitch"], 0.0);

        // Removing only model orientation changes bearing but not camera world
        // position, proving that character-front orientation is an input.
        let unrotated = geometry_json(
            cc4_profile(),
            &[7.0, 7.0, -3.0],
            &rolled_camera,
            &[5.0, 7.0, -3.0],
            &[],
        );
        assert_geometry_number(&unrotated["cameraBearingDegrees"]["yaw"], 90.0);
    }

    #[test]
    fn geometry_reports_asymmetric_scaled_and_missing_au_capacities() {
        // Deliberately asymmetric maxDegrees and signed scales distinguish
        // authored unit-AU capacity from a hardcoded angle or a fixed fraction.
        // The eyes differ so the shared result must honor the smaller mapped
        // actuator; a missing opposite AU and a translation-only AU yield zero.
        let mut profile = cc4_profile().clone();
        for (id, degrees, scale) in [
            (51, 80.0, 0.25),
            (52, 30.0, -1.5),
            (53, 50.0, -0.6),
            (54, 90.0, 0.2),
            (61, 28.0, 0.5),
            (64, 20.0, 0.8),
        ] {
            for binding in profile.au_to_bones.get_mut(&id.to_string()).unwrap() {
                binding.max_degrees = Some(degrees);
                binding.scale = scale;
            }
        }
        profile.au_to_bones.get_mut("61").unwrap()[0].max_degrees = Some(35.0);
        profile.au_to_bones.remove("62");
        for binding in profile.au_to_bones.get_mut("63").unwrap() {
            binding.channel = "tx".into();
        }
        // Duplicate and unrelated mappings cannot inflate the selected head
        // composite's capacity; both must retain existing runtime semantics.
        let mut duplicate = profile.au_to_bones["51"][0].clone();
        duplicate.max_degrees = Some(180.0);
        profile
            .au_to_bones
            .get_mut("51")
            .unwrap()
            .push(duplicate.clone());
        duplicate.node = "NotTheHead".into();
        profile.au_to_bones.get_mut("51").unwrap().insert(0, duplicate);
        let result = geometry_json(&profile, &[0.0, 0.0, 2.0], &[], &[0.0; 3], &[]);
        for (axis, negative, positive) in [
            ("headYaw", 45.0, 20.0),
            ("headPitch", 18.0, 30.0),
            ("eyeYaw", 0.0, 14.0),
            ("eyePitch", 16.0, 0.0),
        ] {
            assert_geometry_number(&result["limitsDegrees"][axis]["negative"], negative);
            assert_geometry_number(&result["limitsDegrees"][axis]["positive"], positive);
        }

        // Explicitly clearing composites must remain a clear operation, even
        // though the same profile still contains otherwise valid AU bindings.
        let mut value = serde_json::to_value(&profile).unwrap();
        value["compositeRotations"] = serde_json::json!([]);
        let cleared: ProfileData = serde_json::from_value(value).unwrap();
        let result = geometry_json(&cleared, &[0.0, 0.0, 2.0], &[], &[0.0; 3], &[]);
        for axis in ["headYaw", "headPitch", "eyeYaw", "eyePitch"] {
            assert_geometry_number(&result["limitsDegrees"][axis]["negative"], 0.0);
            assert_geometry_number(&result["limitsDegrees"][axis]["positive"], 0.0);
        }
    }

    #[test]
    fn geometry_marks_coincident_bearing_absent_and_normalizes_invalid_facts() {
        // Packed callers can supply short slices, NaN, and degenerate quats.
        // Safe coordinate/quaternion fallbacks must still mark the resulting
        // coincident bearing as absent rather than claiming a zero-degree ray.
        let result = geometry_json(
            cc4_profile(),
            &[f32::NAN, f32::INFINITY],
            &[0.0; 4],
            &[],
            &[f32::NAN; 4],
        );
        assert!(result["cameraBearingDegrees"].is_null());
        assert!(result["displayRightInBearing"].is_null());
        assert!(result["displayUpInBearing"].is_null());
        assert_geometry_number(&result["cameraDistanceSceneUnits"], 0.0);
        assert_eq!(
            result["displayRightInModel"],
            serde_json::json!([1.0, 0.0, 0.0])
        );
        assert_eq!(
            result["displayUpInModel"],
            serde_json::json!([0.0, 1.0, 0.0])
        );
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
    fn full_tracking_input_matches_full_head_au_with_authored_signed_limits() {
        let mut profile = canonical_profile();
        profile.au_to_bones.get_mut("51").unwrap()[0].scale = 0.5;
        profile.au_to_bones.get_mut("53").unwrap()[0].max_degrees = Some(18.0);
        for (input, au, head_target) in [
            ([1.0, 0.0, 0.8], 51, [-1.0, 0.0]),
            ([-1.0, 0.0, 0.8], 52, [1.0, 0.0]),
            ([0.0, 1.0, 0.8], 53, [0.0, 1.0]),
            ([0.0, -1.0, 0.8], 54, [0.0, -1.0]),
        ] {
            let result = solve_tracking(
                &input, &[0.0, 0.0, 3.0], &[0.0, 0.0, 0.0, 1.0],
                &[0.0; 3], &[0.0, 0.0, 0.0, 1.0], true, true, 1.0, false,
                gaze_limits(&profile), 1.0,
            );
            assert!((result[4] - head_target[0]).abs() < 1.0e-5, "AU {au}: {result:?}");
            assert!((result[5] - head_target[1]).abs() < 1.0e-5, "AU {au}: {result:?}");

            let mut direct = canonical_runtime(&profile);
            direct.set_au(au, 1.0, 0.0);
            let mut tracking = canonical_runtime(&profile);
            for (value, negative, positive) in [(result[4], 51, 52), (result[5], 54, 53)] {
                tracking.set_au(negative, (-value).max(0.0), 0.0);
                tracking.set_au(positive, value.max(0.0), 0.0);
            }
            let direct_frame = direct.evaluate_bone_frame_delta();
            let tracking_frame = tracking.evaluate_bone_frame_delta();
            let expected = direct_frame.chunks(9).find(|row| row[0] == 1.0).unwrap();
            let actual = tracking_frame.chunks(9).find(|row| row[0] == 1.0).unwrap();
            for i in 4..8 {
                assert!((actual[i] - expected[i]).abs() < 1.0e-5, "AU {au}: bone quaternion differs");
            }
        }
    }

    #[test]
    fn tracking_range_is_independent_of_viewer_depth_and_camera_distance() {
        for distance in [0.5, 3.0, 100.0] {
            for depth in [0.2, 0.8, 10.0] {
                for input in [-2.0_f32, -1.0, -0.5, 0.0, 0.5, 1.0, 2.0] {
                    let result = solve_tracking(
                        &[input, 0.0, depth], &[0.0, 0.0, distance], &[0.0, 0.0, 0.0, 1.0],
                        &[0.0; 3], &[0.0, 0.0, 0.0, 1.0], true, true, 1.0, false,
                        gaze_limits(cc4_profile()), 1.0,
                    );
                    assert!((result[4] + input.clamp(-1.0, 1.0)).abs() < 1.0e-5);
                    assert!(result.iter().all(|value| value.is_finite()));
                }
            }
        }
    }

    #[test]
    fn tracking_retains_camera_center_and_rotates_display_axes() {
        let limits = gaze_limits(cc4_profile());
        let camera = ray(25.0, 10.0);
        let camera_rotation = gaze_rotation([25.0, 10.0]);
        for (input, expected) in [
            ([0.0, 0.0, 0.8], [-25.0 / 60.0, 10.0 / 30.0]),
            ([1.0, 0.0, 0.8], [-1.0, 10.0 / 30.0]),
            ([-1.0, 0.0, 0.8], [1.0, 10.0 / 30.0]),
            ([0.0, 1.0, 0.8], [-25.0 / 60.0, 1.0]),
            ([0.0, -1.0, 0.8], [-25.0 / 60.0, -1.0]),
        ] {
            let result = solve_tracking(
                &input, &camera, &camera_rotation, &[0.0; 3], &[0.0, 0.0, 0.0, 1.0],
                true, true, 1.0, false, limits, 1.0,
            );
            assert!((result[4] - expected[0]).abs() < 1.0e-4);
            assert!((result[5] - expected[1]).abs() < 1.0e-4);
        }
        let rolled = solve_tracking(
            &[1.0, 0.0, 0.8], &[0.0, 0.0, 1.0], &quat_from_channel(2, std::f32::consts::FRAC_PI_2),
            &[0.0; 3], &[0.0, 0.0, 0.0, 1.0], true, true, 1.0, false, limits, 1.0,
        );
        assert!(rolled[4].abs() < 1.0e-5);
        assert!((rolled[5] - 1.0).abs() < 1.0e-5);
    }

    #[test]
    fn tracking_handles_disabled_missing_and_invalid_controls_without_inventing_range() {
        for (eyes, head) in [(true, false), (false, true), (false, false)] {
            let result = solve_tracking(
                &[1.0, 0.0, 0.8], &[0.0, 0.0, 1.0], &[0.0, 0.0, 0.0, 1.0],
                &[0.0; 3], &[0.0, 0.0, 0.0, 1.0], eyes, head, 1.0, false,
                gaze_limits(cc4_profile()), 1.0,
            );
            assert!((result[4] - if head { -1.0 } else { 0.0 }).abs() < 1.0e-5);
            assert!((result[2] - if eyes && !head { -1.0 } else { 0.0 }).abs() < 1.0e-5);
        }
        let mut unmapped = canonical_profile();
        unmapped.au_to_bones.clear();
        let result = solve_tracking(
            &[f32::NAN, f32::INFINITY, f32::NAN], &[0.0; 3], &[0.0, 0.0, 0.0, 1.0],
            &[0.0; 3], &[0.0, 0.0, 0.0, 1.0], true, true, 1.0, false,
            gaze_limits(&unmapped), f32::NAN,
        );
        assert!(result.iter().all(|value| value.is_finite()));
        assert!(result[..6].iter().all(|value| value.abs() < 1.0e-5));
    }

    #[test]
    fn runtime_eye_ray_converges_for_coupled_oblique_and_pitched_targets() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        for camera_yaw in [-45.0, 0.0, 45.0] {
            for camera_pitch in [-25.0, 0.0, 25.0] {
                for target_yaw in [-75.0, -35.0, 0.0, 35.0, 75.0] {
                    for target_pitch in [-35.0, -15.0, 0.0, 15.0, 35.0] {
                        for locked in [false, true] {
                            let target = ray(target_yaw, target_pitch);
                            let result = solution_from_world_target(
                                target,
                                ray(camera_yaw, camera_pitch),
                                [0.0; 3],
                                &[0.0, 0.0, 0.0, 1.0],
                                true,
                                true,
                                0.35,
                                locked,
                                gaze_limits(&profile),
                            );
                            let actual = runtime_viewing_direction(&mut core, &result);
                            let error = angular_error(actual, target);
                            assert!(error < 0.02, "camera {camera_yaw}/{camera_pitch}, target {target_yaw}/{target_pitch}, locked {locked}: error {error}, solution {result:?}");
                        }
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
        for composite in profile.composite_rotations.iter_mut() {
            if composite.node == "HEAD" {
                composite.yaw = None;
            }
        }
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 0.0);
    }

    #[test]
    fn geometry_capacities_ignore_secondary_outputs_and_follow_compiled_actuators() {
        // Compare reported capacity to the core's actual unit-AU bone frame,
        // not to a second hand-written mapping evaluator. This keeps custom
        // physical channels and composition slots tied to runtime semantics.
        let mut profile = canonical_profile();
        let mut extra = profile.au_to_bones["51"][0].clone();
        extra.node = "Extra".into();
        extra.max_degrees = Some(10.0);
        profile.au_to_bones.get_mut("51").unwrap().push(extra);
        let mut composite = profile.composite_rotations.iter().find(|row| row.node == "HEAD").unwrap().clone();
        composite.node = "Extra".into();
        // Round-trip the table to append without changing its explicit/missing
        // representation. This is an extra mapped destination, not head range.
        let mut value = serde_json::to_value(&profile).unwrap();
        value["compositeRotations"].as_array_mut().unwrap().push(serde_json::to_value(composite).unwrap());
        let mut profile: ProfileData = serde_json::from_value(value).unwrap();
        let geometry = geometry_json(&profile, &[0.0, 0.0, 3.0], &[], &[0.0; 3], &[]);
        assert_geometry_number(&geometry["limitsDegrees"]["headYaw"]["positive"], 60.0);

        // Named compiler slots set composition order. They do not rename the
        // ordinary AU51 response or remove its full authored magnitude.
        let head = profile.composite_rotations.iter_mut().find(|row| row.node == "HEAD").unwrap();
        std::mem::swap(&mut head.yaw, &mut head.roll);
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 60.0);
        let mut runtime = canonical_runtime(&profile);
        runtime.set_au(51, 1.0, 0.0);
        let frame = runtime.evaluate_active_bone_frame();
        let head_row = frame.chunks_exact(9).find(|row| row[0] == 1.0).unwrap();
        assert!((head_row[5] - (30.0_f32).to_radians().sin()).abs() < 1e-6);

        // A custom physical channel and signed scale keep their authored
        // magnitude even though the semantic control is still named head yaw.
        let binding = &mut profile.au_to_bones.get_mut("51").unwrap()[0];
        binding.channel = "rx".into();
        binding.scale = -0.5;
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 30.0);
        let mut runtime = canonical_runtime(&profile);
        runtime.set_au(51, 1.0, 0.0);
        let frame = runtime.evaluate_active_bone_frame();
        let head_row = frame.chunks_exact(9).find(|row| row[0] == 1.0).unwrap();
        assert!((head_row[4] + (15.0_f32).to_radians().sin()).abs() < 1e-6);

        // A duplicate response cannot be advertised as one axis; a selector
        // that includes the same AU on both sides also cancels canonically.
        let head = profile.composite_rotations.iter_mut().find(|row| row.node == "HEAD").unwrap();
        head.pitch = head.roll.clone();
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 0.0);
        let head = profile.composite_rotations.iter_mut().find(|row| row.node == "HEAD").unwrap();
        head.pitch = None;
        head.roll.as_mut().unwrap().positive = Some(AuSelector::One(51));
        head.roll.as_mut().unwrap().negative = Some(AuSelector::One(51));
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 0.0);
    }

    #[test]
    fn explicit_empty_composites_disable_gaze_capacity_but_null_and_missing_inherit() {
        let mut value = serde_json::to_value(canonical_profile()).unwrap();
        value["compositeRotations"] = serde_json::json!([]);
        let profile: ProfileData = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 0.0);
        assert_eq!(gaze_limits(&profile).eye_pitch.positive, 0.0);
        value["compositeRotations"] = serde_json::Value::Null;
        let profile: ProfileData = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 60.0);
        value.as_object_mut().unwrap().remove("compositeRotations");
        let profile: ProfileData = serde_json::from_value(value).unwrap();
        assert_eq!(gaze_limits(&profile).head_yaw.positive, 60.0);
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
    fn camera_center_uses_target_follow_and_eye_overflow() {
        let result = solve_cc4(
            &[0.0, 0.0],
            &[3.0, 1.6, 3.0],
            &[0.0, 0.0, 0.0, 1.0],
            &[0.0, 1.6, 0.0],
            &[0.0, 0.0, 0.0, 1.0],
        );
        assert!((result[8] + 45.0).abs() < 1.0e-4);
        // Default participation prefers 15.75 degrees from neutral, then
        // overflow advances to 20 so the eyes can supply their remaining 25.
        assert!((-result[4] * 60.0 - 20.0).abs() < 0.01);
        assert!((-result[2] * 25.0 - 25.0).abs() < 0.01);
    }

    #[test]
    fn target_follow_participates_from_neutral_on_both_axes() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        for target_yaw in [-12.0, 12.0] {
            for target_pitch in [-8.0, 8.0] {
                for follow in [0.0, 0.35, 1.0] {
                    let target = ray(target_yaw, target_pitch);
                    let result = solution_from_world_target(
                        target,
                        ray(-target_yaw, -target_pitch),
                        [0.0; 3],
                        &[0.0, 0.0, 0.0, 1.0],
                        true,
                        true,
                        follow,
                        false,
                        gaze_limits(&profile),
                    );
                    assert!((-result[4] * 60.0 - target_yaw * follow).abs() < 1.0e-4);
                    assert!((result[5] * 30.0 - target_pitch * follow).abs() < 1.0e-4);
                    assert!(
                        angular_error(runtime_viewing_direction(&mut core, &result), target)
                            < 0.002
                    );
                }
            }
        }
    }

    #[test]
    fn viewer_projection_keeps_following_head_on_the_target_side() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        let origin = [0.0, 1.6, 0.0];
        for camera_yaw in [-8.0, 8.0] {
            let camera = add3(origin, scale3(ray(camera_yaw, 0.0), 1.5));
            for follow in [0.0, 0.35, 1.0] {
                let result = solve_viewer_scaled(
                    &[-camera_yaw.signum(), 0.0, 0.8],
                    &camera,
                    &gaze_rotation([camera_yaw, 0.0]),
                    &origin,
                    &[0.0, 0.0, 0.0, 1.0],
                    50.0,
                    4.0 / 3.0,
                    true,
                    true,
                    follow,
                    false,
                    gaze_limits(&profile),
                    1.0,
                );
                let target_yaw = -result[6];
                let head_yaw = -result[4] * 60.0;
                assert!(target_yaw * camera_yaw < 0.0, "viewer must cross neutral");
                assert!((head_yaw - target_yaw * follow).abs() < 1.0e-4);
                assert!(
                    head_yaw * target_yaw >= 0.0,
                    "head must follow target, not camera"
                );
                assert!(
                    angular_error(
                        runtime_viewing_direction(&mut core, &result),
                        sub3([result[11], result[12], result[13]], origin),
                    ) < 0.002
                );
            }
        }
    }

    #[test]
    fn explicit_camera_lock_is_distinct_from_zero_follow_and_respects_disabled_channels() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        let target = ray(-10.0, 0.0);
        for (eyes, head, locked, expected_head) in [
            (true, true, false, 0.0),
            (true, true, true, 8.0),
            (false, true, false, -10.0),
            (false, true, true, -10.0),
            (true, false, false, 0.0),
            (true, false, true, 0.0),
        ] {
            let result = solution_from_world_target(
                target,
                ray(8.0, 0.0),
                [0.0; 3],
                &[0.0, 0.0, 0.0, 1.0],
                eyes,
                head,
                0.0,
                locked,
                gaze_limits(&profile),
            );
            assert!((-result[4] * 60.0 - expected_head).abs() < 1.0e-4);
            assert!(angular_error(runtime_viewing_direction(&mut core, &result), target) < 0.002);
        }
    }

    #[test]
    fn zero_follow_still_allows_eye_overflow_to_recruit_the_head() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        let target = ray(40.0, 0.0);
        let result = solution_from_world_target(
            target,
            ray(-10.0, 0.0),
            [0.0; 3],
            &[0.0, 0.0, 0.0, 1.0],
            true,
            true,
            0.0,
            false,
            gaze_limits(&profile),
        );
        assert!((-result[4] * 60.0 - 15.0).abs() < 1.0e-3);
        assert!((result[2] + 1.0).abs() < 1.0e-4);
        assert!(angular_error(runtime_viewing_direction(&mut core, &result), target) < 0.002);
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
    fn scaled_viewer_gaze_is_invariant_under_uniform_scene_unit_changes() {
        let profile_json = serde_json::to_string(&canonical_profile()).unwrap();
        for (origin, camera, camera_angles) in [
            ([0.25, 1.75, 0.1], [-0.8, 1.4, 2.4], [30.0, -20.0]),
            ([-0.3, 1.1, -0.2], [1.2, 2.2, 2.8], [-35.0, 25.0]),
        ] {
            let camera_quat = gaze_rotation(camera_angles);
            for viewer in [[0.0, 0.0, 0.2], [0.5, -0.4, 0.8], [-0.5, 0.4, 2.0]] {
                for lock_head in [false, true] {
                    let solve_at_scale = |scale: f32| {
                        solve_profile_viewer_space_gaze_scaled(
                            &profile_json,
                            &viewer,
                            &scale3(camera, scale),
                            &camera_quat,
                            &scale3(origin, scale),
                            &[0.0, 0.0, 0.0, 1.0],
                            50.0,
                            4.0 / 3.0,
                            true,
                            true,
                            0.35,
                            lock_head,
                            scale,
                        )
                        .unwrap()
                    };
                    let meters = solve_at_scale(1.0);
                    for scale in [0.001, 0.01, 100.0, 1000.0] {
                        let scaled = solve_at_scale(scale);
                        // AU outputs and angles are invariant; distance and
                        // target position stay in the host's world units.
                        for index in 0..10 {
                            assert!(
                                (scaled[index] - meters[index]).abs() < 1.0e-4,
                                "scale {scale}, index {index}: {} != {}",
                                scaled[index],
                                meters[index]
                            );
                        }
                        for index in 10..14 {
                            assert!((scaled[index] / scale - meters[index]).abs() < 1.0e-4);
                        }
                        if viewer[0] == 0.0 && viewer[1] == 0.0 {
                            assert!((scaled[6] - scaled[8]).abs() < 1.0e-4);
                            assert!((scaled[7] - scaled[9]).abs() < 1.0e-4);
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn scaled_viewer_depth_bounds_and_xy_projection_are_metric() {
        let profile_json = serde_json::to_string(cc4_profile()).unwrap();
        for (depth, expected_depth) in [(0.1, 0.2), (0.8, 0.8), (100.0, 10.0)] {
            let result = solve_profile_viewer_space_gaze_scaled(
                &profile_json,
                &[0.5, -0.25, depth],
                &[0.0, 160.0, 300.0],
                &[0.0, 0.0, 0.0, 1.0],
                &[0.0, 160.0, 0.0],
                &[0.0, 0.0, 0.0, 1.0],
                90.0,
                4.0 / 3.0,
                true,
                true,
                0.35,
                false,
                100.0,
            )
            .unwrap();
            // A centimeter scene must retain the viewer's real lateral and
            // depth offsets, including after the physical depth clamp.
            let expected = [
                0.5 * expected_depth * 100.0 * 4.0 / 3.0,
                160.0 - 0.25 * expected_depth * 100.0,
                300.0 + expected_depth * 100.0,
            ];
            for axis in 0..3 {
                assert!((result[11 + axis] - expected[axis]).abs() < 1.0e-4);
            }
        }
    }

    #[test]
    fn scaled_viewer_invalid_units_fall_back_to_the_legacy_export() {
        let profile_json = serde_json::to_string(cc4_profile()).unwrap();
        let viewer = [0.3, -0.2, 0.8];
        let camera = [-0.8, 2.2, 2.4];
        let camera_quat = gaze_rotation([30.0, -20.0]);
        let origin = [0.25, 1.75, 0.1];
        let model_quat = [0.0, 0.0, 0.0, 1.0];
        let legacy = solve_profile_viewer_space_gaze(
            &profile_json,
            &viewer,
            &camera,
            &camera_quat,
            &origin,
            &model_quat,
            50.0,
            4.0 / 3.0,
            true,
            true,
            0.35,
            false,
        )
        .unwrap();
        for scale in [1.0, 0.0, -1.0, f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            let result = solve_profile_viewer_space_gaze_scaled(
                &profile_json,
                &viewer,
                &camera,
                &camera_quat,
                &origin,
                &model_quat,
                50.0,
                4.0 / 3.0,
                true,
                true,
                0.35,
                false,
                scale,
            )
            .unwrap();
            assert!(result.iter().all(|value| value.is_finite()));
            assert_eq!(result, legacy);
        }
    }

    #[test]
    fn centered_viewer_keeps_eye_contact_when_character_is_off_camera_axis() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        for (origin, camera, camera_angles) in [
            ([0.25, 1.75, 0.1], [-0.8, 1.4, 2.4], [45.0, -18.0]),
            ([-0.3, 1.1, -0.2], [1.2, 2.2, 2.8], [-35.0, 25.0]),
        ] {
            let camera_quat = gaze_rotation(camera_angles);
            let eye_to_camera = sub3(camera, origin);
            let bearing = scale3(eye_to_camera, 1.0 / squared_length(eye_to_camera).sqrt());
            for depth in [0.2, 0.8, 2.0] {
                let result = solve_viewer(
                    &[0.0, 0.0, depth],
                    &camera,
                    &camera_quat,
                    &origin,
                    &[0.0, 0.0, 0.0, 1.0],
                    50.0,
                    4.0 / 3.0,
                    true,
                    true,
                    0.35,
                    false,
                    gaze_limits(&profile),
                );
                let expected_target = add3(camera, scale3(bearing, depth));
                for axis in 0..3 {
                    assert!((result[11 + axis] - expected_target[axis]).abs() < 1.0e-5);
                }
                assert!((result[6] - result[8]).abs() < 1.0e-4);
                assert!((result[7] - result[9]).abs() < 1.0e-4);
                assert!(
                    angular_error(runtime_viewing_direction(&mut core, &result), eye_to_camera)
                        < 0.002
                );
            }
        }
    }

    #[test]
    fn viewer_offsets_keep_camera_right_and_up_around_the_eye_contact_bearing() {
        let profile = canonical_profile();
        let mut core = canonical_runtime(&profile);
        let origin = [0.25, 1.75, 0.1];
        let camera = [-0.8, 1.4, 2.4];
        let camera_quat = gaze_rotation([30.0, -20.0]);
        let eye_to_camera = sub3(camera, origin);
        let bearing = scale3(eye_to_camera, 1.0 / squared_length(eye_to_camera).sqrt());
        let depth = 0.8;
        let half_height = depth * (50.0_f32.to_radians() / 2.0).tan();
        let right = rotate_by_quat(camera_quat, [1.0, 0.0, 0.0]);
        let up = rotate_by_quat(camera_quat, [0.0, 1.0, 0.0]);
        for x in [-0.6, 0.6] {
            for y in [-0.4, 0.4] {
                let expected_target = add3(
                    add3(
                        add3(camera, scale3(bearing, depth)),
                        scale3(right, x * half_height * 4.0 / 3.0),
                    ),
                    scale3(up, y * half_height),
                );
                let result = solve_viewer(
                    &[x, y, depth],
                    &camera,
                    &camera_quat,
                    &origin,
                    &[0.0, 0.0, 0.0, 1.0],
                    50.0,
                    4.0 / 3.0,
                    true,
                    true,
                    0.35,
                    false,
                    gaze_limits(&profile),
                );
                for axis in 0..3 {
                    assert!((result[11 + axis] - expected_target[axis]).abs() < 1.0e-5);
                }
                assert!(
                    angular_error(
                        runtime_viewing_direction(&mut core, &result),
                        sub3(expected_target, origin)
                    ) < 0.002
                );
            }
        }
    }

    #[test]
    fn coincident_eye_and_camera_uses_camera_back_as_finite_fallback() {
        let origin = [0.3, 1.6, -0.2];
        let camera_quat = gaze_rotation([25.0, -12.0]);
        let expected_target = add3(
            origin,
            scale3(rotate_by_quat(camera_quat, [0.0, 0.0, 1.0]), 0.8),
        );
        let result = solve_viewer_cc4(
            &[0.0, 0.0, 0.8],
            &origin,
            &camera_quat,
            &origin,
            &[0.0, 0.0, 0.0, 1.0],
            false,
        );
        assert!(result.iter().all(|value| value.is_finite()));
        for axis in 0..3 {
            assert!((result[11 + axis] - expected_target[axis]).abs() < 1.0e-5);
        }
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
