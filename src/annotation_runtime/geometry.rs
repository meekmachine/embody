use crate::annotation_camera::{add_scaled3, normalize3, quat_or_identity, rotate_by_quat, sub3};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub type Point = [f32; 3];
pub const IDENTITY: [f32; 16] = [
    1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1., 0., 0., 0., 0., 1.,
];
pub fn number(v: &Value, key: &str, fallback: f32) -> f32 {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .map(|n| n as f32)
        .filter(|n| n.is_finite())
        .unwrap_or(fallback)
}
pub fn text<'a>(v: &'a Value, key: &str) -> &'a str {
    v[key].as_str().unwrap_or("")
}
pub fn strings(v: &Value) -> Vec<String> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
pub fn point(v: &Value) -> Option<Point> {
    let p = if v.is_array() {
        [v[0].as_f64()?, v[1].as_f64()?, v[2].as_f64()?]
    } else {
        [v["x"].as_f64()?, v["y"].as_f64()?, v["z"].as_f64()?]
    };
    let p = p.map(|x| x as f32);
    p.iter().all(|x| x.is_finite()).then_some(p)
}
pub fn point_json(p: Point) -> Value {
    json!({"x":p[0],"y":p[1],"z":p[2]})
}
pub fn has(text: &str, words: &str) -> bool {
    words.split('|').any(|word| text.contains(word))
}
pub fn side(name: &str) -> Option<&'static str> {
    let mut normalized = String::new();
    let mut previous = ' ';
    for ch in name.chars() {
        if previous.is_lowercase() && ch.is_uppercase() {
            normalized.push(' ');
        }
        normalized.extend(ch.to_lowercase());
        previous = ch;
    }
    let tokens: Vec<_> = normalized
        .split(|c: char| !c.is_ascii_alphanumeric())
        .collect();
    match (
        tokens.iter().any(|v| *v == "left" || *v == "l"),
        tokens.iter().any(|v| *v == "right" || *v == "r"),
    ) {
        (true, false) => Some("left"),
        (false, true) => Some("right"),
        _ => None,
    }
}
pub fn side_sign(side: &str, left: f32) -> f32 {
    if side == "left" {
        left
    } else {
        -left
    }
}
pub fn format_label(name: &str) -> String {
    name.split('_')
        .map(|part| {
            let mut chars = part.chars();
            chars
                .next()
                .map(|c| c.to_uppercase().to_string() + chars.as_str())
                .unwrap_or_default()
        })
        .collect::<Vec<_>>()
        .join(" ")
}
pub fn transform(m: &[f32; 16], p: Point) -> Point {
    let w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    let w = if w.abs() > f32::EPSILON { w } else { 1. };
    [
        (m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12]) / w,
        (m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13]) / w,
        (m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]) / w,
    ]
}
pub fn clip(m: &[f32], p: Point) -> [f32; 4] {
    if m.len() != 16 {
        return [0., 0., 0., -1.];
    }
    std::array::from_fn(|i| m[i] * p[0] + m[i + 4] * p[1] + m[i + 8] * p[2] + m[i + 12])
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct Bounds {
    pub min: Point,
    pub max: Point,
}
impl Bounds {
    pub fn at(p: Point) -> Self {
        Self { min: p, max: p }
    }
    pub fn center(self) -> Point {
        std::array::from_fn(|i| (self.min[i] + self.max[i]) * 0.5)
    }
    pub fn size(self) -> Point {
        std::array::from_fn(|i| self.max[i] - self.min[i])
    }
    pub fn include(&mut self, p: Point) {
        for i in 0..3 {
            self.min[i] = self.min[i].min(p[i]);
            self.max[i] = self.max[i].max(p[i]);
        }
    }
    pub fn union(&mut self, other: Self) {
        self.include(other.min);
        self.include(other.max);
    }
    pub fn packed(self) -> [f32; 6] {
        let c = self.center();
        let s = self.size();
        [c[0], c[1], c[2], s[0], s[1], s[2]]
    }
    pub fn finite(self) -> bool {
        (0..3).all(|i| {
            self.min[i].is_finite() && self.max[i].is_finite() && self.min[i] <= self.max[i]
        })
    }
}
fn identity() -> [f32; 16] {
    IDENTITY
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelObject {
    pub id: u32,
    pub name: String,
    pub kind: String,
    pub parent: Option<u32>,
    pub position: Point,
    pub bounds: Option<Bounds>,
    #[serde(default = "identity")]
    pub matrix: [f32; 16],
    #[serde(default = "identity")]
    pub inverse: [f32; 16],
    #[serde(default)]
    pub morph_names: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub bounds: Bounds,
    pub quaternion: [f32; 4],
    #[serde(default = "identity")]
    pub inverse: [f32; 16],
    pub objects: Vec<ModelObject>,
}
impl Model {
    pub fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::HashSet::new();
        if !self.bounds.finite()
            || !self.quaternion.iter().all(|v| v.is_finite())
            || !self.inverse.iter().all(|v| v.is_finite())
        {
            return Err("Invalid annotation model bounds/transform".into());
        }
        for object in &self.objects {
            if !ids.insert(object.id)
                || !object
                    .position
                    .iter()
                    .chain(object.matrix.iter())
                    .chain(object.inverse.iter())
                    .all(|v| v.is_finite())
                || object.bounds.is_some_and(|b| !b.finite())
            {
                return Err(format!("Invalid annotation object {}", object.id));
            }
        }
        Ok(())
    }
    pub fn object(&self, id: u32) -> Option<&ModelObject> {
        self.objects.iter().find(|o| o.id == id)
    }
    pub fn direction(&self, p: Point) -> Point {
        normalize3(rotate_by_quat(quat_or_identity(&self.quaternion), p))
    }
    pub fn resolve(&self, region: &Value, config: &Value) -> Vec<u32> {
        if let Some(ids) = region["objectIds"].as_array() {
            return ids
                .iter()
                .filter_map(Value::as_u64)
                .map(|n| n as u32)
                .filter(|id| self.object(*id).is_some())
                .collect();
        }
        if strings(&region["objects"]).iter().any(|n| n == "*") {
            return self
                .objects
                .iter()
                .filter(|o| o.kind == "Mesh")
                .map(|o| o.id)
                .collect();
        }
        let mut out = Vec::new();
        for (key, kind) in [("bones", "Bone"), ("meshes", "Mesh"), ("objects", "")] {
            let names = if key == "bones" {
                bone_names(&region[key], config)
            } else {
                strings(&region[key])
            };
            for object in &self.objects {
                if (kind.is_empty() || object.kind == kind)
                    && names.iter().any(|n| matches(&object.name, n, config))
                    && !out.contains(&object.id)
                {
                    out.push(object.id);
                }
            }
        }
        out
    }
    /// Tracking follows the first configured target, independently of the
    /// complete target set used for bounds and camera framing.
    pub fn primary_marker_object(&self, region: &Value, config: &Value) -> Option<u32> {
        if strings(&region["objects"]).iter().any(|name| name == "*") {
            return None;
        }
        for (key, kind) in [("bones", ""), ("meshes", "Mesh"), ("objects", "")] {
            let names = strings(&region[key]);
            let Some(first) = names.first() else {
                continue;
            };
            let names = if key == "bones" {
                bone_names(&json!([first]), config)
            } else {
                vec![first.clone()]
            };
            let first = names.first()?;
            return self.objects.iter().find(|object| {
                (kind.is_empty() || object.kind == kind)
                    && matches(&object.name, first, config)
            }).map(|object| object.id);
        }
        None
    }
    pub fn laterality(&self, regions: &[Value], config: &Value) -> (f32, f32) {
        let (mut signed, mut total) = (0., 0.);
        for r in regions {
            let Some(s) = side(text(r, "name")) else {
                continue;
            };
            // Names are ordered by the author; scene traversal order may put
            // an ancestor or the opposite side before the preferred target.
            let names = bone_names(&r["bones"], config);
            if let Some(o) = names.iter().find_map(|name| {
                self.objects.iter().find(|object| {
                    matches(&object.name, name, config)
                        || object.name.to_lowercase().contains(&name.to_lowercase())
                })
            }) {
                let x = transform(&self.inverse, o.position)[0];
                if x.abs() > 0.001 {
                    signed += if s == "left" { x } else { -x };
                    total += x.abs();
                }
            }
        }
        if total > 0. {
            (if signed > 0. { 1. } else { -1. }, signed.abs() / total)
        } else {
            (-1., 0.)
        }
    }
    pub fn face(&self, region: &Value, config: &Value) -> (Point, Option<u32>) {
        let find = |names: &[&str]| {
            names.iter().find_map(|n| {
                self.objects.iter().find(|o| {
                    matches(&o.name, n, config) || o.name.to_lowercase().contains(&n.to_lowercase())
                })
            })
        };
        let head_names = bone_names(&region["bones"], config)
            .into_iter()
            .filter(|n| n.to_lowercase().contains("head"))
            .collect::<Vec<_>>();
        let head = if head_names.is_empty() {
            find(&["CC_Base_Head", "Head", "Bip01_Head"])
        } else {
            find(&head_names.iter().map(String::as_str).collect::<Vec<_>>())
        };
        let mesh_ids = self.resolve(&json!({"meshes":region["meshes"]}), config);
        let mut bounds: Option<Bounds> = None;
        for id in mesh_ids {
            if let Some(b) = self.object(id).and_then(|o| o.bounds) {
                if let Some(all) = bounds.as_mut() {
                    all.union(b)
                } else {
                    bounds = Some(b)
                }
            }
        }
        if let Some(b) = bounds {
            if b.size()[1] <= self.bounds.size()[1] * 0.7 {
                return (b.center(), head.map(|o| o.id));
            }
        }
        if let (Some(left), Some(right)) = (
            find(&["CC_Base_L_Eye", "LeftEye", "Eye_L", "L_Eye"]),
            find(&["CC_Base_R_Eye", "RightEye", "Eye_R", "R_Eye"]),
        ) {
            return (
                add_scaled3(left.position, sub3(right.position, left.position), 0.5),
                head.map(|o| o.id),
            );
        }
        if let Some(head) = head {
            return (
                add_scaled3(
                    head.position,
                    self.direction([0., 0., 1.]),
                    0.08 * self.bounds.size()[1] / 1.8,
                ),
                Some(head.id),
            );
        }
        let mut center = self.bounds.center();
        center[1] = self.bounds.min[1] + self.bounds.size()[1] * 0.9;
        (center, None)
    }
}
pub fn bone_profile(config: &Value) -> Value {
    let mut profile = json!({});
    for key in ["boneNodes", "bonePrefix", "boneSuffix", "suffixPattern"] {
        if !config["profile"][key].is_null() {
            profile[key] = config["profile"][key].clone();
        } else if !config[key].is_null() {
            profile[key] = config[key].clone();
        }
    }
    profile
}
pub fn bone_names(names: &Value, config: &Value) -> Vec<String> {
    crate::profile_api::dispatch(
        "profile.resolveBoneNames",
        &json!({"names":names,"profile":bone_profile(config)}),
    )
    .ok()
    .map(|v| strings(&v))
    .unwrap_or_else(|| strings(names))
}
pub fn matches(name: &str, target: &str, config: &Value) -> bool {
    crate::profile_api::dispatch(
        "name.fuzzyMatch",
        &json!({"objectName":name,"targetName":target,"suffixPattern":bone_profile(config)["suffixPattern"]}),
    )
    .ok()
    .and_then(|v| v.as_bool())
    .unwrap_or(name == target)
}

pub fn anchor_region(region: &Value) -> Value {
    let anchor = &region["markerAnchor"];
    let kind = text(anchor, "type");
    let legacy = kind.is_empty() || kind == "region";
    let mut result = region.clone();
    if !legacy {
        for key in ["bones", "meshes", "objects", "customPosition"] {
            result.as_object_mut().unwrap().remove(key);
        }
        for key in ["bones", "meshes", "objects"] {
            if anchor[key].is_array() {
                result[key] = anchor[key].clone();
            }
        }
        match kind {
            "point" => result["customPosition"] = anchor["position"].clone(),
            "bone" => {
                if result["bones"].is_null() {
                    result["bones"] = region["bones"].clone()
                }
            }
            "mesh" => {
                if result["meshes"].is_null() {
                    result["meshes"] = region["meshes"].clone()
                }
            }
            "object" => {
                if result["objects"].is_null() {
                    result["objects"] = region["objects"].clone()
                }
            }
            "face-center" => {
                for key in ["bones", "meshes"] {
                    if result[key].is_null() {
                        result[key] = region[key].clone();
                    }
                }
            }
            _ => (),
        }
    }
    let projection = match anchor["projectToSurface"].as_bool() {
        Some(true) => "project",
        Some(false) => "skip",
        None if legacy => "legacy",
        None if kind == "point" || kind == "mesh" => "skip",
        _ => "project",
    };
    json!({"region":result,"anchor":anchor,"source":if kind.is_empty(){"legacy-region"}else{"marker-anchor"},"projection":projection,"useLegacyRegionSemantics":legacy})
}
pub fn camera_angle(region: &Value, left: f32, visibility: bool) -> Option<f32> {
    let side = side(text(region, "name"));
    let angle = region["cameraAngle"]
        .as_f64()
        .map(|a| crate::annotation_camera::normalize_camera_angle_degrees(a as f32));
    if let (Some(s), Some(90. | 270.)) = (side, angle) {
        return Some(if side_sign(s, left) > 0. { 90. } else { 270. });
    }
    angle.or_else(|| {
        if visibility && !region["parent"].is_null() {
            side.map(|s| if side_sign(s, left) > 0. { 90. } else { 270. })
        } else {
            None
        }
    })
}
