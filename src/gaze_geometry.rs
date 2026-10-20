//! Stateless camera/character geometry. Scheduling and motor limits belong to consumers.
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

type Vec3 = [f64; 3];
type Quat = [f64; 4];
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    camera_position: Vec3,
    camera_quaternion: Quat,
    character_world_quaternion: Quat,
    eye_origin_world: Vec3,
    vertical_fov_degrees: f64,
    aspect: f64,
    target: Target,
    #[serde(default)]
    target_roll_degrees: f64,
}
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Target {
    Screen { x: f64, y: f64, depth: Option<f64> },
    World { position: Vec3 },
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Angles { pitch: f64, yaw: f64, roll: f64 }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
    target_angles_degrees: Angles,
    camera_angles_degrees: Angles,
    target_direction_character: Vec3,
    character_facing_camera: bool,
}
fn sub(a: Vec3, b: Vec3) -> Vec3 { [a[0]-b[0], a[1]-b[1], a[2]-b[2]] }
fn dot(a: Vec3, b: Vec3) -> f64 { a[0]*b[0]+a[1]*b[1]+a[2]*b[2] }
fn cross(a: Vec3, b: Vec3) -> Vec3 { [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]] }
fn unit(v: Vec3) -> Result<Vec3, String> {
    let n = dot(v,v).sqrt();
    if !n.is_finite() || n <= 1e-12 { return Err("Gaze direction must be finite and nonzero".into()); }
    Ok([v[0]/n,v[1]/n,v[2]/n])
}
fn quaternion(q: Quat) -> Result<Quat,String> {
    let n = q.iter().map(|v|v*v).sum::<f64>().sqrt();
    if !n.is_finite() || n <= 1e-12 { return Err("Gaze quaternion must be finite and nonzero".into()); }
    Ok([q[0]/n,q[1]/n,q[2]/n,q[3]/n])
}
fn rotate(q: Quat, v: Vec3) -> Vec3 {
    let t = cross([q[0],q[1],q[2]],v);
    let u = cross([q[0],q[1],q[2]],t);
    [v[0]+2.0*(q[3]*t[0]+u[0]),v[1]+2.0*(q[3]*t[1]+u[1]),v[2]+2.0*(q[3]*t[2]+u[2])]
}
fn angles(v: Vec3, roll: f64) -> Angles {
    Angles { pitch:v[1].atan2(v[0].hypot(v[2])).to_degrees(), yaw:-v[0].atan2(v[2]).to_degrees(), roll }
}
fn solve(input: Input) -> Result<Output,String> {
    if input.camera_position.iter().chain(input.eye_origin_world.iter()).any(|v|!v.is_finite()) || !input.target_roll_degrees.is_finite() {
        return Err("Gaze positions and roll must be finite".into());
    }
    let camera = quaternion(input.camera_quaternion)?;
    let model = quaternion(input.character_world_quaternion)?;
    let inverse = [-model[0],-model[1],-model[2],model[3]];
    let to_camera = sub(input.camera_position,input.eye_origin_world);
    let camera_direction = unit(to_camera)?;
    let world_direction = match input.target {
        Target::World { position } => unit(sub(position,input.eye_origin_world))?,
        Target::Screen { x,y,depth } => {
            if !x.is_finite() || !y.is_finite() || x.abs()>1.0 || y.abs()>1.0 || !input.vertical_fov_degrees.is_finite() || !(0.0..180.0).contains(&input.vertical_fov_degrees) || input.vertical_fov_degrees == 0.0 || !input.aspect.is_finite() || input.aspect <= 0.0 {
                return Err("Screen gaze requires NDC x/y in [-1,1], FOV in (0,180), and positive aspect".into());
            }
            // Zero offset follows the viewer bearing, independent of scene framing.
            let distance = dot(to_camera,to_camera).sqrt();
            let depth = depth.unwrap_or(distance);
            if !depth.is_finite() || depth <= 0.0 { return Err("Screen gaze depth must be positive and finite".into()); }
            let scale = depth * (input.vertical_fov_degrees.to_radians()/2.0).tan();
            let offset = rotate(camera,[x*scale*input.aspect,y*scale,0.0]);
            unit([to_camera[0]+offset[0],to_camera[1]+offset[1],to_camera[2]+offset[2]])?
        }
    };
    let camera_local = rotate(inverse,camera_direction);
    let camera_up = rotate(inverse,rotate(camera,[0.0,1.0,0.0]));
    // Compare camera up against the character's upright basis around the viewer bearing.
    let right = unit(cross([0.0,1.0,0.0],camera_local)).unwrap_or([1.0,0.0,0.0]);
    let up = cross(camera_local,right);
    let camera_roll = dot(camera_up,right).atan2(dot(camera_up,up)).to_degrees();
    let local = rotate(inverse,world_direction);
    Ok(Output { target_angles_degrees:angles(local,input.target_roll_degrees), camera_angles_degrees:angles(camera_local,camera_roll), target_direction_character:local, character_facing_camera:camera_local[2]>0.0 })
}
/// Pure renderer-neutral facts; no playback, state, or inferred target roll.
#[wasm_bindgen]
pub fn solve_gaze_geometry(input_json: &str) -> Result<String,JsError> {
    let input = serde_json::from_str(input_json).map_err(|e|JsError::new(&format!("Invalid gaze geometry: {e}")))?;
    let output = solve(input).map_err(|e|JsError::new(&e))?;
    serde_json::to_string(&output).map_err(|e|JsError::new(&e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Input { Input { camera_position:[0.0,0.0,5.0], camera_quaternion:[0.0,0.0,0.0,1.0], character_world_quaternion:[0.0,0.0,0.0,1.0], eye_origin_world:[0.0;3], vertical_fov_degrees:90.0, aspect:1.0,target:Target::Screen{x:0.0,y:0.0,depth:None},target_roll_degrees:0.0 } }
    #[test] fn centered_viewer_is_neutral() { let o=solve(input()).unwrap(); assert_eq!(o.target_angles_degrees.yaw,0.0); assert!(o.character_facing_camera); }
    #[test] fn screen_offset_has_semantic_yaw_and_no_invented_roll() { let mut i=input(); i.target=Target::Screen{x:1.0,y:1.0,depth:None}; let o=solve(i).unwrap(); assert!((o.target_angles_degrees.yaw+45.0).abs()<1e-8); assert!(o.target_angles_degrees.pitch>0.0); assert_eq!(o.target_angles_degrees.roll,0.0); }
    #[test] fn model_rotation_changes_camera_and_target_bearing() { let mut i=input(); i.character_world_quaternion=[0.0,(std::f64::consts::FRAC_PI_4).sin(),0.0,(std::f64::consts::FRAC_PI_4).cos()]; let o=solve(i).unwrap(); assert!((o.target_angles_degrees.yaw-90.0).abs()<1e-8); assert!((o.camera_angles_degrees.yaw-90.0).abs()<1e-8); }
    #[test] fn world_target_preserves_authored_roll() { let mut i=input(); i.target=Target::World{position:[-1.0,1.0,1.0]}; i.target_roll_degrees=12.0; let o=solve(i).unwrap(); assert_eq!(o.target_angles_degrees.roll,12.0); assert!((o.target_angles_degrees.yaw-45.0).abs()<1e-8); }
    #[test] fn invalid_quaternion_and_coincident_target_fail() { let mut i=input(); i.camera_quaternion=[0.0;4]; assert!(solve(i).is_err()); let mut i=input(); i.target=Target::World{position:[0.0;3]}; assert!(solve(i).is_err()); }
}
