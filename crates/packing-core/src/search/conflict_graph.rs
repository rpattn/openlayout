use super::*;

pub(super) fn conflict_graph_refine(
    prepared: &PreparedProblem,
    config: &SearchConfig,
    incumbent: &SearchState,
    metrics: &mut SearchMetrics,
    observer: &mut dyn SolveObserver,
) -> Option<SearchState> {
    let empty = SearchState::from_placed(
        prepared,
        incumbent
            .placed
            .iter()
            .filter(|p| p.placement.fixed)
            .cloned()
            .collect(),
    );
    let mut candidates = generate_candidates(prepared, &empty, config, metrics, observer, None)?;
    score_candidates(prepared, &empty, &mut candidates, metrics);
    candidates.truncate(96);
    let spatial = SpatialIndex::new(
        &empty,
        prepared.minimum_item_area.sqrt().max(config.grid_stride),
    );
    let mut feasible = candidates
        .into_iter()
        .filter_map(|candidate| feasible_candidate(prepared, &empty, &spatial, &candidate, metrics))
        .collect::<Vec<_>>();
    metrics.conflict_graph_candidates = feasible.len();
    if feasible.is_empty() {
        metrics.conflict_graph_status = ConflictGraphStatus::BestFound;
        return None;
    }
    let mut adjacency = vec![0_u128; feasible.len()];
    for first in 0..feasible.len() {
        if observer.should_cancel() {
            metrics.cancelled = true;
            return None;
        }
        for second in (first + 1)..feasible.len() {
            if placements_conflict(prepared, &feasible[first], &feasible[second]) {
                adjacency[first] |= 1_u128 << second;
                adjacency[second] |= 1_u128 << first;
            }
        }
    }
    let mut order = (0..feasible.len()).collect::<Vec<_>>();
    order.sort_by(|a, b| {
        adjacency[*b]
            .count_ones()
            .cmp(&adjacency[*a].count_ones())
            .then_with(|| a.cmp(b))
    });
    let reordered = order
        .iter()
        .map(|index| feasible[*index].clone())
        .collect::<Vec<_>>();
    let mut reordered_adjacency = vec![0_u128; feasible.len()];
    for (new_first, old_first) in order.iter().enumerate() {
        for (new_second, old_second) in order.iter().enumerate() {
            if adjacency[*old_first] & (1_u128 << old_second) != 0 {
                reordered_adjacency[new_first] |= 1_u128 << new_second;
            }
        }
    }
    feasible = reordered;

    let mut selected = empty.placed.clone();
    let mut counts = empty.counts.clone();
    let mut greedy_mask = 0_u128;
    for (index, node) in feasible.iter().enumerate() {
        let variant = &prepared.variants[node.variant_id];
        if counts[variant.item_index] >= prepared.problem.items[variant.item_index].quantity {
            continue;
        }
        if reordered_adjacency[index] & greedy_mask == 0 {
            selected.push(node.clone());
            counts[variant.item_index] += 1;
            greedy_mask |= 1_u128 << index;
        }
    }
    let fixed_count = empty.placed.len();
    let mut best_mask = greedy_mask;
    let mut best_count = selected.len() - fixed_count;
    let mut budget = (config.max_states / 4).clamp(256, 30_000);
    let mut search_counts = empty.counts.clone();
    let complete = graph_branch_and_bound(
        prepared,
        &feasible,
        &reordered_adjacency,
        0,
        0,
        &mut search_counts,
        &mut best_mask,
        &mut best_count,
        &mut budget,
        observer,
    );
    if !complete && observer.should_cancel() {
        metrics.cancelled = true;
    }
    metrics.conflict_graph_status = if complete {
        ConflictGraphStatus::CandidateSetOptimal
    } else {
        ConflictGraphStatus::LimitReached
    };
    let mut graph_placements = empty.placed;
    for (index, node) in feasible.into_iter().enumerate() {
        if best_mask & (1_u128 << index) != 0 {
            graph_placements.push(node);
        }
    }
    Some(SearchState::from_placed(prepared, graph_placements))
}

fn placements_conflict(prepared: &PreparedProblem, first: &Placed, second: &Placed) -> bool {
    let first_variant = &prepared.variants[first.variant_id];
    let second_variant = &prepared.variants[second.variant_id];
    if first_variant.item_index == second_variant.item_index {
        let item = &prepared.problem.items[first_variant.item_index];
        let shared = matches!(
            item.rotation_policy,
            crate::RotationPolicy::Discrete {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            } | crate::RotationPolicy::Continuous {
                coupling: crate::RotationCoupling::SharedPerItem,
                ..
            }
        );
        if shared
            && angular_distance(first.placement.rotation_deg, second.placement.rotation_deg)
                > EPSILON
        {
            return true;
        }
    }
    let gap = prepared.problem.clearance.item_to_item;
    first.bounds.overlaps(second.bounds, gap)
        && (sets_overlap(&first.geometry, &second.geometry)
            || set_distance(&first.geometry, &second.geometry) + EPSILON < gap)
}

#[allow(clippy::too_many_arguments)]
fn graph_branch_and_bound(
    prepared: &PreparedProblem,
    nodes: &[Placed],
    adjacency: &[u128],
    index: usize,
    selected_mask: u128,
    counts: &mut [u32],
    best_mask: &mut u128,
    best_count: &mut usize,
    budget: &mut u64,
    observer: &mut dyn SolveObserver,
) -> bool {
    if *budget == 0 {
        return false;
    }
    if budget.is_multiple_of(256) && observer.should_cancel() {
        return false;
    }
    *budget -= 1;
    let selected_count = selected_mask.count_ones() as usize;
    let mut future_by_item = vec![0usize; prepared.problem.items.len()];
    for node in &nodes[index..] {
        future_by_item[prepared.variants[node.variant_id].item_index] += 1;
    }
    let remaining_quantity_bound = future_by_item
        .into_iter()
        .enumerate()
        .map(|(item_index, future)| {
            future.min(
                (prepared.problem.items[item_index].quantity as usize)
                    .saturating_sub(counts[item_index] as usize),
            )
        })
        .sum::<usize>();
    if selected_count + remaining_quantity_bound <= *best_count {
        return true;
    }
    if index == nodes.len() {
        if selected_count > *best_count {
            *best_count = selected_count;
            *best_mask = selected_mask;
        }
        return true;
    }
    let node = &nodes[index];
    let variant = &prepared.variants[node.variant_id];
    if adjacency[index] & selected_mask == 0
        && counts[variant.item_index] < prepared.problem.items[variant.item_index].quantity
    {
        counts[variant.item_index] += 1;
        let include_complete = graph_branch_and_bound(
            prepared,
            nodes,
            adjacency,
            index + 1,
            selected_mask | (1_u128 << index),
            counts,
            best_mask,
            best_count,
            budget,
            observer,
        );
        counts[variant.item_index] -= 1;
        if !include_complete {
            return false;
        }
    }
    graph_branch_and_bound(
        prepared,
        nodes,
        adjacency,
        index + 1,
        selected_mask,
        counts,
        best_mask,
        best_count,
        budget,
        observer,
    )
}
