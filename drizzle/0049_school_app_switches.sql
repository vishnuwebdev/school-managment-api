-- Simple product mode (15 Nov 2026): no plans or subscriptions. The Super Admin switches the
-- Teacher app and the Parent app on or off per school, stored as an ADMIN_OVERRIDE GRANT on
-- `teachers.mobile_app` / `parent_portal`. Existing schools keep the apps their plan gave them:
-- a school with an active plan grant for an app (and no override for it) gets the switch on.
-- No schema change; plan and subscription rows are kept as they are.
INSERT INTO `entitlements` (`id`, `tenant_id`, `feature_id`, `source_type`, `effect`, `status`, `starts_at`, `reason`)
SELECT UUID(), g.`tenant_id`, g.`feature_id`, 'ADMIN_OVERRIDE', 'GRANT', 'ACTIVE', NOW(3),
       'App kept on when plans were switched off'
FROM (
  SELECT DISTINCT e.`tenant_id`, e.`feature_id`
  FROM `entitlements` e
  JOIN `features` f ON f.`id` = e.`feature_id`
  JOIN `tenants` t ON t.`id` = e.`tenant_id`
  WHERE f.`code` IN ('teachers.mobile_app', 'parent_portal')
    AND e.`source_type` IN ('PLAN', 'ADD_ON', 'CUSTOM_CONTRACT')
    AND e.`effect` = 'GRANT'
    AND e.`status` = 'ACTIVE'
    AND (e.`ends_at` IS NULL OR e.`ends_at` > NOW(3))
    AND t.`status` <> 'ARCHIVED'
) g
WHERE NOT EXISTS (
  SELECT 1 FROM `entitlements` o
  WHERE o.`tenant_id` = g.`tenant_id` AND o.`feature_id` = g.`feature_id`
    AND o.`source_type` = 'ADMIN_OVERRIDE' AND o.`status` = 'ACTIVE'
);
