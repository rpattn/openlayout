use super::*;

pub(super) fn repair_warm_start(
    prepared: &PreparedProblem,
    fixed: &[CandidatePlacement],
    placements: &[Placement],
) -> Vec<CandidatePlacement> {
    let movable = placements
        .iter()
        .filter(|placement| !placement.fixed)
        .cloned()
        .collect::<Vec<_>>();
    let mut orders = vec![movable.clone()];
    let mut reversed = movable.clone();
    reversed.reverse();
    orders.push(reversed);
    let mut by_y = movable.clone();
    by_y.sort_by(|a, b| a.y.total_cmp(&b.y).then_with(|| a.x.total_cmp(&b.x)));
    orders.push(by_y);
    let mut by_x = movable.clone();
    by_x.sort_by(|a, b| a.x.total_cmp(&b.x).then_with(|| a.y.total_cmp(&b.y)));
    orders.push(by_x);
    for restart in 0..4_u64 {
        let mut shuffled = movable.clone();
        let mut rng =
            ChaCha8Rng::seed_from_u64(0x9e3779b97f4a7c15_u64 ^ restart ^ movable.len() as u64);
        shuffled.shuffle(&mut rng);
        orders.push(shuffled);
    }
    let mut best = fixed.to_vec();
    for order in orders {
        let repaired = repair_warm_order(prepared, fixed, &order);
        if repaired.len() > best.len()
            || (repaired.len() == best.len() && layout_key(&repaired) < layout_key(&best))
        {
            best = repaired;
        }
    }
    best
}

fn repair_warm_order(
    prepared: &PreparedProblem,
    fixed: &[CandidatePlacement],
    placements: &[Placement],
) -> Vec<CandidatePlacement> {
    let mut repaired = fixed.to_vec();
    for placement in placements {
        let Some(variant) = prepared.variants.iter().find(|variant| {
            variant.item_id == placement.item_id
                && same_rotation(variant.rotation_deg, placement.rotation_deg)
        }) else {
            continue;
        };
        if item_count(&repaired, &variant.item_id)
            >= prepared.problem.items[variant.item_index].quantity as usize
        {
            continue;
        }
        let next = candidate(variant, placement.x, placement.y, false);
        let mut counters = Counters::default();
        if feasible(prepared, &next, repaired.iter(), &mut counters) {
            repaired.push(next);
        } else if let Some(adjusted) =
            locally_repair_candidate(prepared, variant, placement, &repaired)
        {
            repaired.push(adjusted);
        }
    }
    repaired
}

fn locally_repair_candidate(
    prepared: &PreparedProblem,
    variant: &crate::prepare::PreparedVariant,
    placement: &Placement,
    repaired: &[CandidatePlacement],
) -> Option<CandidatePlacement> {
    let step = variant.bounds.width().min(variant.bounds.height()) / 100.0;
    if !step.is_finite() || step <= EPSILON {
        return None;
    }
    let mut counters = Counters::default();
    for ring in 1..=24 {
        let distance = step * ring as f64;
        let offsets = [
            (-distance, 0.0),
            (distance, 0.0),
            (0.0, -distance),
            (0.0, distance),
            (-distance, -distance),
            (-distance, distance),
            (distance, -distance),
            (distance, distance),
        ];
        for (dx, dy) in offsets {
            let adjusted = candidate(variant, placement.x + dx, placement.y + dy, false);
            if feasible(prepared, &adjusted, repaired.iter(), &mut counters) {
                return Some(adjusted);
            }
        }
    }
    None
}
