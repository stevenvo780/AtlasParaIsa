
WITH roster AS (
 SELECT json_extract(p.value,'$.id') AS id, json_extract(p.value,'$.role') AS role,
        json_extract(p.value,'$.bornAt') AS bornAt, NULL AS diedAt
 FROM snapshots s, json_each(s.body,'$.people') p WHERE s.slot=0
 UNION ALL
 SELECT id, json_extract(body,'$.role'),json_extract(body,'$.bornAt'),json_extract(body,'$.diedAt')
 FROM legacy
)

SELECT CASE WHEN teacher.role='neighbor' THEN 'mortal' WHEN teacher.role IN ('S','I') THEN 'protected' ELSE 'unknown' END AS teacherGroup, CASE WHEN learner.role='neighbor' THEN 'mortal' WHEN learner.role IN ('S','I') THEN 'protected' ELSE 'unknown' END AS learnerGroup,
       COUNT(*) AS episodes
FROM events e
LEFT JOIN roster teacher ON teacher.id=json_extract(e.body,'$.actors[0]') AND teacher.bornAt<=e.tick AND (teacher.diedAt IS NULL OR teacher.diedAt>=e.tick)
LEFT JOIN roster learner ON learner.id=json_extract(e.body,'$.actors[1]') AND learner.bornAt<=e.tick AND (learner.diedAt IS NULL OR learner.diedAt>=e.tick)
WHERE e.tick>:after AND e.tick<=:end AND json_extract(e.body,'$.source')='simulation'
 AND json_array_length(e.body,'$.actors')=2 AND (
 (:kind='recipe' AND json_extract(e.body,'$.kind')='learning' AND json_extract(e.body,'$.cause')=:recipeCause)
 OR (:kind='cooperation' AND json_extract(e.body,'$.kind')='cooperation' AND json_extract(e.body,'$.cause') LIKE 'Estrategia teach;%')
 )
GROUP BY teacherGroup,learnerGroup ORDER BY teacherGroup,learnerGroup
