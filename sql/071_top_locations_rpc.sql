-- Paginated "popular venues" for the favorite-locations profile picker.
-- Counts active (non-archived) events per location_key; excludes placeholders.

CREATE OR REPLACE FUNCTION public.top_locations_page(
  p_offset integer DEFAULT 0,
  p_limit integer DEFAULT 13
)
RETURNS TABLE (
  location_key text,
  raw_address text,
  display_name text,
  events_count bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.location_key,
    l.raw_address,
    l.display_name,
    COUNT(*)::bigint AS events_count
  FROM public.events e
  INNER JOIN public.locations l ON l.key = e.location_key
  WHERE e.archived = false
    AND e.location_key IS NOT NULL
    AND l.found = true
    AND COALESCE(l.kind, 'unknown') NOT IN ('placeholder', 'unknown')
  GROUP BY e.location_key, l.raw_address, l.display_name
  ORDER BY events_count DESC, e.location_key
  OFFSET GREATEST(p_offset, 0)
  LIMIT GREATEST(p_limit, 1);
$$;

CREATE OR REPLACE FUNCTION public.count_top_locations()
RETURNS bigint
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*)::bigint
  FROM (
    SELECT e.location_key
    FROM public.events e
    INNER JOIN public.locations l ON l.key = e.location_key
    WHERE e.archived = false
      AND e.location_key IS NOT NULL
      AND l.found = true
      AND COALESCE(l.kind, 'unknown') NOT IN ('placeholder', 'unknown')
    GROUP BY e.location_key
  ) t;
$$;

GRANT EXECUTE ON FUNCTION public.top_locations_page(integer, integer) TO postgres, service_role;
GRANT EXECUTE ON FUNCTION public.count_top_locations() TO postgres, service_role;

NOTIFY pgrst, 'reload schema';
