"""Analysis flags added on top of Silver. They mark rows; they never delete them from Silver."""
from __future__ import annotations

import numpy as np
import pandas as pd


def static_source_flag(df: pd.DataFrame, days_per_year: int, include_neighbours: bool = True) -> pd.Series:
    """True for detections in a ~1 km (0.01 deg) cell that has fire on more than `days_per_year`
    distinct local days in one calendar year: gas flares, steel plants and similar non-fire heat
    sources that the FIRMS 'type' field does not always catch (it is missing in NRT data).
    Computed across instruments, as one physical site is seen by both.

    include_neighbours: also flag the 8 cells around a static cell. Pixel positions jitter by a few
    hundred metres, so a site near a cell edge spreads over neighbouring cells, each with too few days
    to be caught on its own (found by the test suite). Note: the harmonized calendar keeps the original
    single-cell rule so its results stay identical to the delivered calendar.json."""
    ci = np.floor(df.latitude / 0.01).astype(np.int64)
    cj = np.floor(df.longitude / 0.01).astype(np.int64)
    cell = ci * 100000 + cj
    year = df.local_solar_date.dt.year
    days = pd.DataFrame({"c": cell, "y": year, "d": df.local_solar_date}).groupby(["c", "y"]).d.nunique()
    static = set(days[days > days_per_year].index.get_level_values(0))
    if include_neighbours:
        static = {c + di * 100000 + dj for c in static for di in (-1, 0, 1) for dj in (-1, 0, 1)}
    return pd.Series(cell.isin(static).values, index=df.index)


def analysis_mask(df: pd.DataFrame, vegetation_only: bool, exclude_static: bool, static_days: int,
                  exclude_low_conf: bool) -> pd.Series:
    keep = pd.Series(True, index=df.index)
    if vegetation_only:
        keep &= df.fire_type.isna() | (df.fire_type == 0)
    if exclude_low_conf:
        keep &= df.confidence_class != "low"
    if exclude_static and keep.any():
        # same order as the calendar pipeline: static sites are found among the rows that passed the other filters
        sub = df[keep]
        keep.loc[sub.index] = ~static_source_flag(sub, static_days)
    return keep
