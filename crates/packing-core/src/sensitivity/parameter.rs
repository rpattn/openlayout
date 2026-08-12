use super::*;

pub(super) fn apply_parameter(
    problem: &mut PackingProblem,
    path: &ParameterPath,
    value: f64,
) -> Result<(), PackingError> {
    if !value.is_finite() {
        return Err(PackingError::config("sensitivity values must be finite"));
    }
    match path {
        ParameterPath::ItemWidth { item_id } => set_item_dimension(problem, item_id, value, true),
        ParameterPath::ItemHeight { item_id } => set_item_dimension(problem, item_id, value, false),
        ParameterPath::ItemScale { item_id } => scale_item(problem, item_id, value),
        ParameterPath::ItemPartWidth {
            item_id,
            part_index,
        } => set_part_dimension(problem, item_id, *part_index, value, true),
        ParameterPath::ItemPartHeight {
            item_id,
            part_index,
        } => set_part_dimension(problem, item_id, *part_index, value, false),
        ParameterPath::ItemPartRadius {
            item_id,
            part_index,
        } => set_part_radius(problem, item_id, *part_index, value),
        ParameterPath::ItemPartScale {
            item_id,
            part_index,
        } => scale_part(problem, item_id, *part_index, value),
        ParameterPath::ClearanceItemToItem => {
            problem.clearance.item_to_item = value;
            Ok(())
        }
        ParameterPath::ClearanceItemToBoundary => {
            problem.clearance.item_to_boundary = value;
            Ok(())
        }
        ParameterPath::ContainerWidth => {
            let part = first_additive_part(problem)?;
            set_shape_dimension(&mut part.shape, value, true)
        }
        ParameterPath::ContainerHeight => {
            let part = first_additive_part(problem)?;
            set_shape_dimension(&mut part.shape, value, false)
        }
        ParameterPath::ItemQuantity { item_id } => {
            if value < 1.0 || value.fract().abs() > 1e-9 || value > u32::MAX as f64 {
                return Err(unsupported("item quantity must be a positive whole number"));
            }
            let item = problem
                .items
                .iter_mut()
                .find(|item| &item.id == item_id)
                .ok_or_else(|| unsupported(format!("unknown item '{item_id}'")))?;
            item.quantity = value as u32;
            Ok(())
        }
        ParameterPath::ContainerPartWidth { part_id } => {
            let part = container_part_mut(problem, part_id)?;
            set_shape_dimension(&mut part.shape, value, true)
        }
        ParameterPath::ContainerPartHeight { part_id } => {
            let part = container_part_mut(problem, part_id)?;
            set_shape_dimension(&mut part.shape, value, false)
        }
        ParameterPath::ContainerPartScale { part_id } => {
            let part = container_part_mut(problem, part_id)?;
            scale_shape(&mut part.shape, value);
            Ok(())
        }
        ParameterPath::ExclusionScale { exclusion_id } => {
            let exclusion = problem
                .exclusions
                .iter_mut()
                .find(|entry| &entry.id == exclusion_id)
                .ok_or_else(|| unsupported(format!("unknown exclusion '{exclusion_id}'")))?;
            scale_shape(&mut exclusion.shape, value);
            Ok(())
        }
    }
}

fn container_part_mut<'a>(
    problem: &'a mut PackingProblem,
    part_id: &str,
) -> Result<&'a mut crate::RegionPart, PackingError> {
    problem
        .container
        .parts
        .iter_mut()
        .find(|part| part.id == part_id)
        .ok_or_else(|| unsupported(format!("unknown container part '{part_id}'")))
}

fn first_additive_part(
    problem: &mut PackingProblem,
) -> Result<&mut crate::RegionPart, PackingError> {
    problem
        .container
        .parts
        .iter_mut()
        .find(|part| part.operation == crate::RegionOperation::Add)
        .ok_or_else(|| unsupported("container has no additive part"))
}

fn compound_part_mut<'a>(
    problem: &'a mut PackingProblem,
    item_id: &str,
    part_index: usize,
) -> Result<&'a mut Shape, PackingError> {
    let item = problem
        .items
        .iter_mut()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| unsupported(format!("unknown item '{item_id}'")))?;
    let Shape::Compound { parts } = &mut item.shape else {
        return Err(unsupported("item-part parameters require a compound item"));
    };
    parts
        .get_mut(part_index)
        .map(|part| part.shape.as_mut())
        .ok_or_else(|| unsupported(format!("item '{item_id}' has no part {part_index}")))
}

fn set_part_dimension(
    problem: &mut PackingProblem,
    item_id: &str,
    part_index: usize,
    value: f64,
    width: bool,
) -> Result<(), PackingError> {
    set_shape_dimension(
        compound_part_mut(problem, item_id, part_index)?,
        value,
        width,
    )
}

fn set_part_radius(
    problem: &mut PackingProblem,
    item_id: &str,
    part_index: usize,
    value: f64,
) -> Result<(), PackingError> {
    match compound_part_mut(problem, item_id, part_index)? {
        Shape::Circle { radius, .. } => {
            *radius = value;
            Ok(())
        }
        _ => Err(unsupported("part-radius parameters require a circle part")),
    }
}

fn scale_part(
    problem: &mut PackingProblem,
    item_id: &str,
    part_index: usize,
    value: f64,
) -> Result<(), PackingError> {
    scale_shape(compound_part_mut(problem, item_id, part_index)?, value);
    Ok(())
}

fn set_item_dimension(
    problem: &mut PackingProblem,
    item_id: &str,
    value: f64,
    width: bool,
) -> Result<(), PackingError> {
    let item = problem
        .items
        .iter_mut()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| unsupported(format!("unknown item '{item_id}'")))?;
    set_shape_dimension(&mut item.shape, value, width)
}

fn set_shape_dimension(shape: &mut Shape, value: f64, width: bool) -> Result<(), PackingError> {
    match shape {
        Shape::Rectangle {
            width: current_width,
            height,
        } => {
            if width {
                *current_width = value
            } else {
                *height = value
            };
            Ok(())
        }
        Shape::Triangle { base, height } => {
            if width {
                *base = value
            } else {
                *height = value
            };
            Ok(())
        }
        Shape::Polygon { vertices } => {
            let (minimum, maximum) =
                vertices
                    .iter()
                    .fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), point| {
                        let coordinate = if width { point.x } else { point.y };
                        (min.min(coordinate), max.max(coordinate))
                    });
            let size = maximum - minimum;
            if size <= 0.0 {
                return Err(unsupported("cannot resize a shape with a zero-sized axis"));
            }
            for point in vertices {
                if width {
                    point.x = minimum + (point.x - minimum) * value / size
                } else {
                    point.y = minimum + (point.y - minimum) * value / size
                }
            }
            Ok(())
        }
        Shape::Bezier { knots, .. } => {
            let points = knots
                .iter()
                .flat_map(|knot| [knot.point, knot.control_in, knot.control_out]);
            let (minimum, maximum) =
                points.fold((f64::INFINITY, f64::NEG_INFINITY), |(min, max), point| {
                    let coordinate = if width { point.x } else { point.y };
                    (min.min(coordinate), max.max(coordinate))
                });
            let size = maximum - minimum;
            if size <= 0.0 {
                return Err(unsupported("cannot resize a shape with a zero-sized axis"));
            }
            for knot in knots {
                for point in [&mut knot.point, &mut knot.control_in, &mut knot.control_out] {
                    if width {
                        point.x = minimum + (point.x - minimum) * value / size;
                    } else {
                        point.y = minimum + (point.y - minimum) * value / size;
                    }
                }
            }
            Ok(())
        }
        _ => Err(unsupported(
            "dimension paths support rectangle and polygon shapes; use scale for other shapes",
        )),
    }
}

fn scale_item(problem: &mut PackingProblem, item_id: &str, scale: f64) -> Result<(), PackingError> {
    let item = problem
        .items
        .iter_mut()
        .find(|entry| entry.id == item_id)
        .ok_or_else(|| unsupported(format!("unknown item '{item_id}'")))?;
    scale_shape(&mut item.shape, scale);
    Ok(())
}

fn scale_shape(shape: &mut Shape, scale: f64) {
    match shape {
        Shape::Polygon { vertices } => {
            for point in vertices {
                point.x *= scale;
                point.y *= scale;
            }
        }
        Shape::Rectangle { width, height } => {
            *width *= scale;
            *height *= scale;
        }
        Shape::Triangle { base, height } => {
            *base *= scale;
            *height *= scale;
        }
        Shape::Circle { radius, .. } => *radius *= scale,
        Shape::Bezier { knots, .. } => {
            for knot in knots {
                for point in [&mut knot.point, &mut knot.control_in, &mut knot.control_out] {
                    point.x *= scale;
                    point.y *= scale;
                }
            }
        }
        Shape::Compound { parts } => {
            for part in parts {
                part.translation.x *= scale;
                part.translation.y *= scale;
                if let Some(snap) = &mut part.snap {
                    snap.offset.x *= scale;
                    snap.offset.y *= scale;
                }
                scale_shape(&mut part.shape, scale);
            }
        }
    }
}

fn unsupported(message: impl Into<String>) -> PackingError {
    PackingError::new(PackingErrorKind::UnsupportedInput, message)
}
