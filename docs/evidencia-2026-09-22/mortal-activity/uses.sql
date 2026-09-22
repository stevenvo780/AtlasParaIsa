
WITH roster AS (
 SELECT json_extract(p.value,'$.id') AS id, json_extract(p.value,'$.role') AS role,
        json_extract(p.value,'$.bornAt') AS bornAt, NULL AS diedAt
 FROM snapshots s, json_each(s.body,'$.people') p WHERE s.slot=0
 UNION ALL
 SELECT id, json_extract(body,'$.role'),json_extract(body,'$.bornAt'),json_extract(body,'$.diedAt')
 FROM legacy
)

SELECT CASE WHEN actor.role='neighbor' THEN 'mortal' WHEN actor.role IN ('S','I') THEN 'protected' ELSE 'unknown' END AS actorGroup, CASE WHEN author.role='neighbor' THEN 'mortal' WHEN author.role IN ('S','I') THEN 'protected' ELSE 'unknown' END AS authorGroup,
       COUNT(*) AS uses, SUM(json_extract(e.body,'$.benefit')) AS benefit,
       COUNT(DISTINCT json_extract(e.body,'$.recipeId')) AS distinctRecipes,
       SUM(CASE WHEN json_extract(d.body,'$.inventorId') IS NULL THEN 1 ELSE 0 END) AS unknownAuthorUses,
       SUM(CASE WHEN json_extract(d.body,'$.inventorId') <> json_extract(e.body,'$.actorId') THEN 1 ELSE 0 END) AS foreignUses
FROM technology_executions e
LEFT JOIN technology_definitions d ON d.id=json_extract(e.body,'$.recipeId')
LEFT JOIN roster actor ON actor.id=json_extract(e.body,'$.actorId') AND actor.bornAt<=e.tick AND (actor.diedAt IS NULL OR actor.diedAt>=e.tick)
LEFT JOIN roster author ON author.id=json_extract(d.body,'$.inventorId')
WHERE e.tick>:after AND e.tick<=:end
  AND json_extract(e.body,'$.success')=1 AND json_extract(e.body,'$.kind')='use'
  AND json_extract(e.body,'$.recipeId') IS NOT NULL AND json_extract(e.body,'$.benefit')>0
GROUP BY actorGroup,authorGroup ORDER BY actorGroup,authorGroup
