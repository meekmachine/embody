//! Semantic AU contributions of admitted AU-curve clips.
//!
//! Each named clip slot keeps the authored AU keys it was admitted with, its
//! resolved inherited start and its strength/easing. These records change only
//! at admission or an explicit strength/easing edit; they are never ticked.
//! Reads evaluate them at the host's actual native action time and weight, so
//! callers learn where a slot is without a second clock or pose ledger.
//! Physical rig values cannot be inverted to AUs, so only AU curves are kept.

use std::collections::{BTreeMap, HashMap};

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Easing { Linear, EaseIn, EaseOut, EaseInOut, EaseInOutCubic }

impl Easing {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "" | "linear" => Ok(Self::Linear),
            "easeIn" => Ok(Self::EaseIn),
            "easeOut" => Ok(Self::EaseOut),
            "easeInOut" => Ok(Self::EaseInOut),
            "easeInOutCubic" => Ok(Self::EaseInOutCubic),
            other => Err(format!("Unknown playback easing: {other}")),
        }
    }

    // Matches the adapter's per-segment easing so reads agree with rendering.
    fn apply(self, progress: f64) -> f64 {
        match self {
            Self::Linear => progress,
            Self::EaseIn => progress * progress,
            Self::EaseOut => 1.0 - (1.0 - progress).powi(2),
            Self::EaseInOut => if progress < 0.5 { 2.0 * progress * progress } else { 1.0 - (-2.0 * progress + 2.0).powi(2) / 2.0 },
            Self::EaseInOutCubic => if progress < 0.5 { 4.0 * progress.powi(3) } else { 1.0 - (-2.0 * progress + 2.0).powi(3) / 2.0 },
        }
    }
}

#[derive(Clone, Debug)]
pub struct AuthoredPoint { pub time: f64, pub intensity: f64, pub inherit: bool }

#[derive(Clone, Debug)]
pub struct SemanticSlot {
    authored: BTreeMap<u32, Vec<AuthoredPoint>>,
    /// Inherited first-key values, already in this slot's own units.
    inherited: BTreeMap<u32, f64>,
    scale: f64,
    easing: Easing,
}

impl SemanticSlot {
    /// Record a slot at admission. `predecessor` is the same-name slot with the
    /// outgoing action's native time and its effective-weight ratio
    /// (outgoing weight / incoming weight), matching physical inheritance.
    pub fn admit(
        curves: BTreeMap<String, Vec<AuthoredPoint>>, scale: f64, easing: Easing,
        predecessor: Option<(&SemanticSlot, f64, f64)>,
    ) -> Result<Self, String> {
        if !scale.is_finite() { return Err("Semantic AU slots require a finite intensity scale.".into()); }
        let mut authored = BTreeMap::new();
        let mut inherited = BTreeMap::new();
        for (key, mut points) in curves {
            // Viseme and named-morph curves have no AU identity to read back.
            let Ok(id) = key.parse::<u32>() else { continue; };
            if points.is_empty() { continue; }
            if points.iter().any(|point| !point.time.is_finite() || point.time < 0.0 || !point.intensity.is_finite()) {
                return Err(format!("AU {id} curve keys need finite values at nonnegative times."));
            }
            points.sort_by(|a, b| a.time.total_cmp(&b.time));
            if points[0].inherit {
                let start = predecessor
                    .and_then(|(slot, time, ratio)| slot.value_at(id, time).map(|value| value * ratio))
                    .unwrap_or(0.0);
                inherited.insert(id, start);
            }
            authored.insert(id, points);
        }
        Ok(Self { authored, inherited, scale, easing })
    }

    /// Change strength/easing in place; inherited starts stay the slot's own.
    pub fn restyle(&mut self, scale: f64, easing: Easing) -> Result<(), String> {
        if !scale.is_finite() { return Err("Semantic AU slots require a finite intensity scale.".into()); }
        self.scale = scale;
        self.easing = easing;
        Ok(())
    }

    fn duration(&self) -> f64 {
        self.authored.values().filter_map(|points| points.last()).map(|point| point.time).fold(0.0, f64::max)
    }

    fn key_value(&self, id: u32, index: usize, point: &AuthoredPoint) -> f64 {
        match (index, self.inherited.get(&id)) {
            (0, Some(start)) => *start,
            _ => point.intensity * self.scale,
        }
    }

    /// The slot's own AU value at native time, before mixer weight.
    pub fn value_at(&self, id: u32, time: f64) -> Option<f64> {
        let points = self.authored.get(&id)?;
        let time = time.clamp(0.0, self.duration());
        let last = points.len() - 1;
        if time <= points[0].time { return Some(self.key_value(id, 0, &points[0])); }
        if time >= points[last].time { return Some(self.key_value(id, last, &points[last])); }
        let index = points.windows(2).position(|pair| pair[0].time <= time && time <= pair[1].time)?;
        let (a, b) = (&points[index], &points[index + 1]);
        let (from, to) = (self.key_value(id, index, a), self.key_value(id, index + 1, b));
        if b.time <= a.time { return Some(to); }
        let progress = self.easing.apply((time - a.time) / (b.time - a.time));
        Some(from + (to - from) * progress)
    }

    pub fn values_at(&self, time: f64, weight: f64) -> BTreeMap<u32, f64> {
        self.authored.keys().filter_map(|id| self.value_at(*id, time).map(|value| (*id, value * weight))).collect()
    }

    /// Signed travel of the segment containing `time`; zero once finished.
    pub fn travel_at(&self, id: u32, time: f64) -> f64 {
        let Some(points) = self.authored.get(&id) else { return 0.0; };
        if time >= self.duration() { return 0.0; }
        points.windows(2).enumerate()
            .find(|(_, pair)| pair[0].time <= time && time < pair[1].time)
            .map(|(index, pair)| self.key_value(id, index + 1, &pair[1]) - self.key_value(id, index, &pair[0]))
            .unwrap_or(0.0)
    }
}

/// Largest travel between `current` and `destination`, with reversal against
/// `preceding` travel. Composite rotations render a continuum pair as
/// positive - negative, so a goal carrying both AUs is one signed movement:
/// crossing neutral from 0.3 negative to 0.3 positive is 0.6, not 0.3.
pub fn measure_travel(
    ids: &[u32], current: &[f32], destination: &[f32], preceding: &[f32],
    continuum_pairs: &HashMap<u32, (u32, bool)>,
) -> Option<(f32, bool)> {
    let count = ids.len();
    if current.len() != count || destination.len() != count || preceding.len() != count { return None; }
    let mut measured = vec![false; count];
    let (mut distance, mut reversal) = (0.0f32, false);
    for index in 0..count {
        if measured[index] { continue; }
        let pair = continuum_pairs.get(&ids[index]).and_then(|&(pair_id, is_negative)| {
            let partner = ids.iter().position(|id| *id == pair_id).filter(|&partner| partner != index && !measured[partner])?;
            Some(if is_negative { (index, partner) } else { (partner, index) })
        });
        let (delta, before) = match pair {
            Some((negative, positive)) => {
                measured[negative] = true;
                measured[positive] = true;
                ((destination[positive] - destination[negative]) - (current[positive] - current[negative]),
                 preceding[positive] - preceding[negative])
            }
            None => {
                measured[index] = true;
                (destination[index] - current[index], preceding[index])
            }
        };
        distance = distance.max(delta.abs());
        if before * delta < 0.0 { reversal = true; }
    }
    Some((distance, reversal))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn point(time: f64, intensity: f64, inherit: bool) -> AuthoredPoint { AuthoredPoint { time, intensity, inherit } }
    fn goal(id: &str, end: f64) -> BTreeMap<String, Vec<AuthoredPoint>> {
        BTreeMap::from([(id.to_string(), vec![point(0.0, 0.0, true), point(1.0, end, false)])])
    }
    fn near(actual: f64, expected: f64) { assert!((actual - expected).abs() < 1e-9, "{actual} != {expected}"); }

    #[test]
    fn evaluates_authored_keys_at_native_time_with_scale_and_easing() {
        let slot = SemanticSlot::admit(goal("12", 0.8), 0.5, Easing::Linear, None).unwrap();
        near(slot.value_at(12, 0.5).unwrap(), 0.2);
        near(slot.value_at(12, 9.0).unwrap(), 0.4);
        assert!(slot.value_at(13, 0.5).is_none());
        let negative = BTreeMap::from([("12".to_string(), vec![point(-1.0, 0.0, false)])]);
        assert!(SemanticSlot::admit(negative, 1.0, Easing::Linear, None).is_err());
        let eased = SemanticSlot::admit(goal("12", 1.0), 1.0, Easing::EaseIn, None).unwrap();
        near(eased.value_at(12, 0.5).unwrap(), 0.25);
    }

    #[test]
    fn inherited_starts_chain_from_the_predecessor_and_its_weight() {
        let first = SemanticSlot::admit(goal("51", 1.0), 1.0, Easing::Linear, None).unwrap();
        let second = SemanticSlot::admit(goal("51", 0.0), 1.0, Easing::Linear, Some((&first, 0.4, 1.0))).unwrap();
        near(second.value_at(51, 0.0).unwrap(), 0.4);
        near(second.value_at(51, 0.5).unwrap(), 0.2);
        // Mid-fade the outgoing contribution is value x weight.
        let faded = SemanticSlot::admit(goal("51", 0.0), 1.0, Easing::Linear, Some((&first, 0.4, 0.5))).unwrap();
        near(faded.value_at(51, 0.0).unwrap(), 0.2);
        // Restyling rescales authored keys but keeps the inherited start.
        let mut restyled = second.clone();
        restyled.restyle(2.0, Easing::Linear).unwrap();
        near(restyled.value_at(51, 0.0).unwrap(), 0.4);
    }

    #[test]
    fn ignores_non_au_curves_and_reports_segment_travel() {
        let mut curves = goal("61", 0.6);
        curves.insert("viseme_aa".into(), vec![point(0.0, 1.0, false)]);
        let slot = SemanticSlot::admit(curves, 1.0, Easing::Linear, None).unwrap();
        assert_eq!(slot.values_at(0.0, 1.0).len(), 1);
        near(slot.travel_at(61, 0.5), 0.6);
        near(slot.travel_at(61, 1.0), 0.0);
    }

    #[test]
    fn measures_paired_travel_along_the_signed_continuum() {
        let pairs = HashMap::from([(51, (52, true)), (52, (51, false))]);
        let near32 = |actual: f32, expected: f32| assert!((actual - expected).abs() < 1e-6, "{actual} != {expected}");
        let (crossing, reversed) = measure_travel(&[51, 52], &[0.3, 0.0], &[0.0, 0.3], &[0.0, 0.0], &pairs).unwrap();
        near32(crossing, 0.6);
        assert!(!reversed);
        near32(measure_travel(&[52, 51], &[0.0, 0.3], &[0.3, 0.0], &[0.0, 0.0], &pairs).unwrap().0, 0.6);
        near32(measure_travel(&[51, 52], &[0.0, 0.3], &[0.0, 0.5], &[0.0, 0.0], &pairs).unwrap().0, 0.2);
        assert_eq!(measure_travel(&[51, 52], &[0.0, 0.65], &[0.0, 0.65], &[0.0, 0.0], &pairs).unwrap().0, 0.0);
        let (distance, reversal) = measure_travel(&[51, 52], &[0.2, 0.0], &[0.0, 0.2], &[0.6, 0.0], &pairs).unwrap();
        near32(distance, 0.4);
        assert!(reversal);
        assert!(!measure_travel(&[51, 52], &[0.2, 0.0], &[0.0, 0.2], &[-0.4, 0.0], &pairs).unwrap().1);
        near32(measure_travel(&[51, 12], &[0.3, 0.0], &[0.0, 0.5], &[0.0, 0.0], &pairs).unwrap().0, 0.5);
        assert!(measure_travel(&[51], &[0.3, 0.0], &[0.0], &[0.0], &pairs).is_none());
    }
}
