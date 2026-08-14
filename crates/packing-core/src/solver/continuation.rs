use super::annealing::anneal_elongated_continuation;
use super::*;

pub(super) fn clearance_continuation(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
    preview_seed: &[Placement],
) -> Result<ContinuationOutcome, PackingError> {
    if let Some(component) = dominant_complex_component(prepared) {
        let seed = if preview_seed.iter().any(|placement| !placement.fixed) {
            preview_seed.to_vec()
        } else {
            solve_with_observer_internal(prepared, options, &mut NoObserver, None, false)?
                .placements
        };
        let retained = seed
            .iter()
            .filter(|placement| !placement_inside_component(prepared, placement, &component))
            .cloned()
            .collect::<Vec<_>>();
        let component_seed = seed
            .iter()
            .filter(|placement| placement_inside_component(prepared, placement, &component))
            .cloned()
            .collect::<Vec<_>>();
        let component_prepared = prepared_for_component(prepared, component.clone());
        let mut component_observer = ComponentContinuationObserver {
            inner: observer,
            retained: &retained,
        };
        let mut outcome = clearance_continuation_single(
            &component_prepared,
            options,
            &mut component_observer,
            &component_seed,
        )?;
        outcome.placements.extend(retained);
        return Ok(outcome);
    }
    clearance_continuation_single(prepared, options, observer, preview_seed)
}

fn clearance_continuation_single(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    observer: &mut dyn SolveObserver,
    preview_seed: &[Placement],
) -> Result<ContinuationOutcome, PackingError> {
    let target_clearance = prepared.problem.clearance.item_to_item;
    let origin_x = (prepared.container_bounds.min_x + prepared.container_bounds.max_x) / 2.0;
    let origin_y = (prepared.container_bounds.min_y + prepared.container_bounds.max_y) / 2.0;
    let centered = centered_prepared_problem(prepared, origin_x, origin_y);
    let mut preview = preview_seed.to_vec();
    let mut donor = Vec::new();
    let mut repair_only_stages = 0;
    let mut search_stages = 0;
    let mut full_solve_stages = 0;
    let mut stages = 0;
    let mut continuation_options = *options;
    continuation_options.quality = crate::SolveQuality::Thorough;
    continuation_options.max_iterations = (options.max_iterations / 2).max(2_000);
    continuation_options.restarts = continuation_options.restarts.min(2);
    continuation_options.beam_width = Some(4);
    continuation_options.max_candidates_per_state = Some(8);
    continuation_options.max_search_states = Some(
        continuation_options
            .max_iterations
            .saturating_div(4)
            .max(128),
    );
    let fractions = [0.0, 0.15, 0.3, 0.45, 0.6, 0.75, 0.9, 1.0];
    for (stage, fraction) in fractions.into_iter().enumerate() {
        stages += 1;
        let mut relaxed_prepared = centered.clone();
        relaxed_prepared.problem.clearance.item_to_item = target_clearance * fraction;
        donor = if donor.is_empty() {
            full_solve_stages += 1;
            solve_with_observer_internal(
                &relaxed_prepared,
                &continuation_options,
                &mut NoObserver,
                Some(&donor),
                false,
            )?
            .placements
        } else {
            let outcome =
                incremental_clearance_stage(&relaxed_prepared, &continuation_options, &donor)?;
            match outcome.kind {
                ContinuationStageKind::RepairOnly => repair_only_stages += 1,
                ContinuationStageKind::Search => search_stages += 1,
                ContinuationStageKind::FullSolve => full_solve_stages += 1,
            }
            outcome.placements
        };
        let target_seed = donor
            .iter()
            .cloned()
            .map(|mut placement| {
                placement.x += origin_x;
                placement.y += origin_y;
                placement
            })
            .collect::<Vec<_>>();
        let repaired_to_target = stage == 1
            && donor.len() > preview_seed.len()
            && CONTINUATION_ANNEAL_SEED_SALTS
                .into_iter()
                .find_map(|salt| {
                    anneal_elongated_continuation(
                        prepared,
                        &target_seed,
                        options.seed ^ salt,
                        options
                            .max_iterations
                            .saturating_mul(5)
                            .div_ceil(2)
                            .clamp(100_000, 250_000),
                    )
                })
                .is_some_and(|repaired| {
                    donor = repaired
                        .into_iter()
                        .map(|mut placement| {
                            placement.x -= origin_x;
                            placement.y -= origin_y;
                            placement
                        })
                        .collect();
                    true
                });
        let translated = donor
            .iter()
            .cloned()
            .map(|mut placement| {
                placement.x += origin_x;
                placement.y += origin_y;
                placement
            })
            .collect::<Vec<_>>();
        // Relaxed-stage layouts are valid only for their temporary clearance and must never be
        // rendered against the requested problem. The final stage uses the requested clearance;
        // its solver path has already validated the translated-equivalent geometry.
        if repaired_to_target || stage + 1 == fractions.len() {
            preview = translated;
        }
        observer.on_progress(&SolveProgress {
            phase: SolvePhase::ClearanceContinuation,
            completed_fraction: if repaired_to_target {
                1.0
            } else {
                (stage + 1) as f64 / fractions.len() as f64
            },
            max_iterations: continuation_options.max_iterations,
            iterations: 0,
            packed_item_count: preview.len(),
            placements: preview.clone(),
            solver_strategy: "clearance_continuation".to_string(),
        });
        if repaired_to_target {
            repair_only_stages += 1;
            break;
        }
    }
    for placement in &mut donor {
        placement.x += origin_x;
        placement.y += origin_y;
    }
    Ok(ContinuationOutcome {
        placements: donor,
        stages,
        repair_only_stages,
        search_stages,
        full_solve_stages,
    })
}

struct ComponentContinuationObserver<'a> {
    inner: &'a mut dyn SolveObserver,
    retained: &'a [Placement],
}

impl SolveObserver for ComponentContinuationObserver<'_> {
    fn should_cancel(&mut self) -> bool {
        self.inner.should_cancel()
    }

    fn on_progress(&mut self, progress: &SolveProgress) {
        let mut combined = progress.clone();
        combined.placements.extend_from_slice(self.retained);
        combined.packed_item_count = combined.placements.len();
        self.inner.on_progress(&combined);
    }
}

fn dominant_complex_component(prepared: &PreparedProblem) -> Option<PolygonSet> {
    let complex_item = prepared.variants.iter().any(|variant| {
        variant
            .geometry
            .polygons
            .iter()
            .map(Vec::len)
            .sum::<usize>()
            > 16
    });
    if !complex_item {
        return None;
    }
    let mut outer = prepared
        .container
        .polygons
        .iter()
        .filter(|polygon| contour_twice_area(polygon) > EPSILON)
        .collect::<Vec<_>>();
    if outer.len() < 2 {
        return None;
    }
    outer.sort_by(|a, b| {
        contour_twice_area(b)
            .total_cmp(&contour_twice_area(a))
            .then_with(|| a.len().cmp(&b.len()))
    });
    let dominant = outer[0].clone();
    let dominant_owner = dominant.clone();
    let mut polygons = vec![dominant];
    polygons.extend(
        prepared
            .container
            .polygons
            .iter()
            .filter(|polygon| contour_twice_area(polygon) < -EPSILON)
            .filter(|polygon| {
                let point = polygon[0];
                prepared
                    .container
                    .polygons
                    .iter()
                    .filter(|outer| {
                        contour_twice_area(outer) > EPSILON
                            && crate::geometry::point_in_polygon(point, outer)
                    })
                    .min_by(|a, b| contour_twice_area(a).total_cmp(&contour_twice_area(b)))
                    .is_some_and(|owner| owner == &dominant_owner)
            })
            .cloned(),
    );
    let mut component = PolygonSet::new(polygons);
    component.enable_edge_index();
    Some(component)
}

fn prepared_for_component(prepared: &PreparedProblem, component: PolygonSet) -> PreparedProblem {
    let component_bounds = bounds(&component);
    let selected_exclusions = prepared
        .exclusions
        .iter()
        .zip(&prepared.problem.exclusions)
        .filter(|(geometry, _)| set_inside(geometry, &component, 0.0))
        .map(|(geometry, exclusion)| (geometry.clone(), exclusion.clone()))
        .collect::<Vec<_>>();
    let mut component_prepared = prepared.clone();
    component_prepared.container_contacts = component
        .polygons
        .iter()
        .flat_map(|polygon| {
            polygon.iter().enumerate().flat_map(|(index, point)| {
                let next = polygon[(index + 1) % polygon.len()];
                [
                    *point,
                    crate::Point {
                        x: (point.x + next.x) / 2.0,
                        y: (point.y + next.y) / 2.0,
                    },
                ]
            })
        })
        .collect();
    component_prepared.exclusion_contacts = selected_exclusions
        .iter()
        .flat_map(|(geometry, _)| geometry.polygons.iter().flatten().copied())
        .collect();
    component_prepared.exclusions = selected_exclusions
        .iter()
        .map(|(geometry, _)| geometry.clone())
        .collect();
    component_prepared.problem.exclusions = selected_exclusions
        .into_iter()
        .map(|(_, exclusion)| exclusion)
        .collect();
    component_prepared.problem.fixed_placements.retain(|fixed| {
        placement_inside_component(
            prepared,
            &Placement {
                item_id: fixed.item_id.clone(),
                x: fixed.x,
                y: fixed.y,
                rotation_deg: fixed.rotation_deg,
                fixed: true,
            },
            &component,
        )
    });
    component_prepared.container = component;
    component_prepared.container_bounds = component_bounds;
    component_prepared.usable_area = area(&component_prepared.container);
    component_prepared.simple_upper_bound = None;
    component_prepared.region_upper_bound = None;
    component_prepared.projection_upper_bound = None;
    component_prepared
}

fn placement_inside_component(
    prepared: &PreparedProblem,
    placement: &Placement,
    component: &PolygonSet,
) -> bool {
    prepared
        .variants
        .iter()
        .find(|variant| {
            variant.item_id == placement.item_id
                && same_rotation(variant.rotation_deg, placement.rotation_deg)
        })
        .is_some_and(|variant| {
            let geometry = transform(&variant.geometry, 0.0, placement.x, placement.y);
            set_inside(&geometry, component, 0.0)
        })
}

fn contour_twice_area(polygon: &[crate::Point]) -> f64 {
    polygon
        .iter()
        .enumerate()
        .map(|(index, point)| {
            let next = polygon[(index + 1) % polygon.len()];
            point.x * next.y - next.x * point.y
        })
        .sum()
}

pub(super) struct ContinuationOutcome {
    pub(super) placements: Vec<Placement>,
    pub(super) stages: u64,
    pub(super) repair_only_stages: u64,
    pub(super) search_stages: u64,
    pub(super) full_solve_stages: u64,
}

enum ContinuationStageKind {
    RepairOnly,
    Search,
    FullSolve,
}

struct ContinuationStageOutcome {
    placements: Vec<Placement>,
    kind: ContinuationStageKind,
}

fn incremental_clearance_stage(
    prepared: &PreparedProblem,
    options: &SolveOptions,
    donor: &[Placement],
) -> Result<ContinuationStageOutcome, PackingError> {
    let target_count = donor.len();
    let fixed = prepare_fixed(prepared)?;
    let repaired = repair_warm_start(prepared, &fixed, donor);
    if repaired.len() >= target_count {
        return Ok(ContinuationStageOutcome {
            placements: repaired.into_iter().map(|entry| entry.placement).collect(),
            kind: ContinuationStageKind::RepairOnly,
        });
    }
    let baseline = repaired
        .iter()
        .map(|entry| entry.placement.clone())
        .collect::<Vec<_>>();
    let mut search_options = *options;
    search_options.max_search_states = Some(512);
    if let Some(outcome) = bounded_search(
        prepared,
        &search_options,
        &baseline,
        Some(target_count),
        &mut NoObserver,
    ) && outcome.placements.len() > baseline.len()
    {
        return Ok(ContinuationStageOutcome {
            placements: outcome.placements,
            kind: ContinuationStageKind::Search,
        });
    }
    let mut fallback_options = *options;
    fallback_options.max_iterations = (options.max_iterations.saturating_mul(3) / 4).max(2_000);
    Ok(ContinuationStageOutcome {
        placements: solve_with_observer_internal(
            prepared,
            &fallback_options,
            &mut NoObserver,
            Some(donor),
            false,
        )?
        .placements,
        kind: ContinuationStageKind::FullSolve,
    })
}

fn centered_prepared_problem(
    prepared: &PreparedProblem,
    origin_x: f64,
    origin_y: f64,
) -> PreparedProblem {
    let mut centered = prepared.clone();
    centered.container = transform(&centered.container, 0.0, -origin_x, -origin_y);
    centered.container_bounds = centered.container_bounds.translated(-origin_x, -origin_y);
    centered.exclusions = centered
        .exclusions
        .iter()
        .map(|geometry| transform(geometry, 0.0, -origin_x, -origin_y))
        .collect();
    for point in &mut centered.container_contacts {
        point.x -= origin_x;
        point.y -= origin_y;
    }
    for point in &mut centered.exclusion_contacts {
        point.x -= origin_x;
        point.y -= origin_y;
    }
    for part in &mut centered.problem.container.parts {
        part.translation.x -= origin_x;
        part.translation.y -= origin_y;
    }
    for placement in &mut centered.problem.fixed_placements {
        placement.x -= origin_x;
        placement.y -= origin_y;
    }
    centered
}
