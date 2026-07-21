UPDATE `session`
SET `permission` = (
  SELECT json_group_array(json(`value`))
  FROM (
    SELECT `entry`.`value`
    FROM json_each(`session`.`permission`) AS `entry`
    JOIN (
      SELECT max(CAST(`key` AS INTEGER)) AS `idx`
      FROM json_each(`session`.`permission`)
      GROUP BY json_extract(`value`, '$.permission'), json_extract(`value`, '$.pattern')
    ) AS `keep` ON `keep`.`idx` = CAST(`entry`.`key` AS INTEGER)
    ORDER BY CAST(`entry`.`key` AS INTEGER)
  )
)
WHERE `permission` IS NOT NULL
  AND json_valid(`permission`)
  AND json_type(`permission`) = 'array'
  AND NOT EXISTS (
    SELECT 1
    FROM json_each(`permission`)
    WHERE json_type(`value`, '$.permission') != 'text'
      OR json_type(`value`, '$.pattern') != 'text'
      OR json_type(`value`, '$.action') != 'text'
  )
  AND json_array_length(`permission`) > (
    SELECT count(*)
    FROM (
      SELECT 1
      FROM json_each(`permission`)
      GROUP BY json_extract(`value`, '$.permission'), json_extract(`value`, '$.pattern')
    )
  );
