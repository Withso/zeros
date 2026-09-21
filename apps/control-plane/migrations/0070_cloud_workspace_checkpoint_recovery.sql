-- Explicit recovery selects an already durable checkpoint when the source
-- engine cannot produce another one. The candidate's existing checkpoint FK
-- pins its content through the same fenced drain/provision workflow.
ALTER TYPE cloud_workspace_generation_transition_operation ADD VALUE 'recover';
